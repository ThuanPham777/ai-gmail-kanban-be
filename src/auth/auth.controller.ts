import {
    Controller,
    Post,
    Body,
    BadRequestException,
    UnauthorizedException,
    UseFilters,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from '../users/dtos/register.dto';
import { LoginDto } from '../users/dtos/login.dto';
import { GoogleLoginDto } from '../users/dtos/google-login.dto';
import { GoogleGmailConnectDto } from '../users/dtos/google-gmail-connect.dto';
import { MongoExceptionFilter } from '../common/filters/mongo-exception.filter';
import { GoogleAuthService } from './google-auth.service';
import { JwtPayload } from './strategies/jwt.strategy';

@Controller('api/auth')
@UseFilters(MongoExceptionFilter)
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly usersService: UsersService,
        private readonly googleAuthService: GoogleAuthService,
    ) { }

    @Post('register')
    async register(@Body() dto: RegisterDto) {
        const created = await this.usersService.createLocalUser(dto.email, dto.password);
        return {
            status: 'success',
            message: 'User registered successfully',
            user: created,
        };
    }

    @Post('login')
    async login(@Body() dto: LoginDto) {
        const user = await this.usersService.verifyCredentials(dto.email, dto.password);
        const { accessToken, refreshToken } = this.authService.issueTokens({
            sub: (user as any)._id,
            email: user.email,
        });
        await this.usersService.setRefreshToken((user as any)._id.toString(), refreshToken);
        return {
            status: 'success',
            message: 'Login successful',
            accessToken,
            refreshToken,
            user,
        };
    }

    // GIS One-Tap / Google Identity login (không xin quyền Gmail)
    @Post('google')
    async googleLogin(@Body() dto: GoogleLoginDto) {
        const tokenInfo = await this.googleAuthService.verifyCredential(dto.credential);

        const user = await this.usersService.findOrCreateGoogleUser({
            email: tokenInfo.email!,
            googleId: tokenInfo.sub!,
            name: tokenInfo.name,
            avatarUrl: tokenInfo.picture,
        });

        const { accessToken, refreshToken } = this.authService.issueTokens({
            sub: (user as any)._id,
            email: user.email,
        });

        await this.usersService.setRefreshToken((user as any)._id.toString(), refreshToken);

        return {
            status: 'success',
            message: 'Login successful',
            accessToken,
            refreshToken,
            user,
            provider: 'google',
        };
    }

    // Connect Gmail (OAuth code)
    @Post('google/gmail-connect')
    async connectGmail(@Body() dto: GoogleGmailConnectDto) {
        const { identity, tokens } = await this.googleAuthService.exchangeCodeForTokens(dto.code);

        const user = await this.usersService.findOrCreateGoogleUser({
            email: identity.email!,
            googleId: identity.sub!,
            name: identity.name,
            avatarUrl: identity.picture,
        });

        await this.usersService.updateGmailTokens((user as any)._id.toString(), {
            refreshToken: tokens.refresh_token!,
            scope: tokens.scope,
        });

        return {
            status: 'success',
            message: 'Gmail connected successfully',
            user,
            provider: 'google',
        };
    }

    @Post('refresh')
    async refresh(@Body('refreshToken') refreshToken: string) {
        if (!refreshToken) throw new UnauthorizedException('Missing refresh token');

        let payload: JwtPayload;
        try {
            payload = await this.authService.verifyRefreshToken<JwtPayload>(refreshToken);
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }

        const user = await this.usersService.validateRefreshToken(payload.sub, refreshToken);

        const { accessToken, refreshToken: newRefreshToken } = this.authService.issueTokens({
            sub: (user as any)._id,
            email: user.email,
        });

        await this.usersService.setRefreshToken((user as any)._id.toString(), newRefreshToken);

        return {
            status: 'success',
            message: 'Token refreshed',
            accessToken,
            refreshToken: newRefreshToken,
        };
    }

    @Post('logout')
    async logout(@Body() body: { userId?: string }) {
        const userId = body.userId;
        if (!userId) throw new BadRequestException('Missing user id');

        await this.usersService.clearRefreshToken(userId);

        return {
            status: 'success',
            message: 'Logged out',
        };
    }

    @Post('google/full-login')
    async googleFullLogin(@Body() dto: { code: string }) {
        const { identity, tokens } =
            await this.googleAuthService.exchangeCodeForTokens(dto.code);

        const user = await this.usersService.findOrCreateGoogleUser({
            email: identity.email!,
            googleId: identity.sub,
            name: identity.name,
            avatarUrl: identity.picture,
        });

        if (!tokens.refresh_token) {
            throw new BadRequestException(
                'Missing refresh token. Check access_type=offline & prompt=consent'
            );
        }

        await this.usersService.updateGmailTokens((user as any)._id.toString(), {
            refreshToken: tokens.refresh_token!,
            scope: tokens.scope,
        });

        const { accessToken, refreshToken } = this.authService.issueTokens({
            sub: (user as any)._id,
            email: user.email,
        });
        await this.usersService.setRefreshToken((user as any)._id.toString(), refreshToken);

        return {
            status: 'success',
            message: 'Login successful',
            accessToken,
            refreshToken,
            user: {
                ...(user as any)._doc,
                gmailConnected: true,
            },
            provider: 'google',
        };
    }
}
