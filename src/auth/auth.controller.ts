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
import { MongoExceptionFilter } from '../common/filters/mongo-exception.filter';
import { GoogleAuthService } from './google-auth.service';
import { JwtPayload } from './strategies/jwt.strategy';
import { RefreshTokenDto, LogoutDto, GoogleLoginDto } from './dtos/request';
import {
  RefreshTokenResponseDto,
  GoogleLoginResponseDto,
} from './dtos/response';
import { ApiResponseDto } from '../common/dtos/api-response.dto';

@Controller('api/auth')
@UseFilters(MongoExceptionFilter)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly googleAuthService: GoogleAuthService,
  ) {}

  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
  ): Promise<ApiResponseDto<RefreshTokenResponseDto>> {
    if (!dto.refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.authService.verifyRefreshToken<JwtPayload>(
        dto.refreshToken,
      );
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.validateRefreshToken(
      payload.sub,
      dto.refreshToken,
    );

    const { accessToken, refreshToken: newRefreshToken } =
      this.authService.issueTokens({
        sub: (user as any)._id,
        email: user.email,
      });

    await this.usersService.setRefreshToken(
      (user as any)._id.toString(),
      newRefreshToken,
    );

    const response = RefreshTokenResponseDto.create(
      accessToken,
      newRefreshToken,
    );
    return ApiResponseDto.success(response, 'Token refreshed');
  }

  @Post('logout')
  async logout(@Body() dto: LogoutDto): Promise<ApiResponseDto<null>> {
    if (!dto.userId) {
      throw new BadRequestException('Missing user id');
    }

    await this.usersService.clearRefreshToken(dto.userId);

    return ApiResponseDto.success(null, 'Logged out');
  }

  /**
   * Google OAuth 2.0 Login/Register
   * - Email doesn't exist → register new user
   * - Email exists → login existing user
   * Uses Authorization Code flow with offline access for Gmail refresh token
   */
  @Post('google/login')
  async googleLogin(
    @Body() dto: GoogleLoginDto,
  ): Promise<ApiResponseDto<GoogleLoginResponseDto>> {
    const { identity, tokens } =
      await this.googleAuthService.exchangeCodeForTokens(dto.code);

    // findOrCreateGoogleUser handles both register (new user) and login (existing user)
    const { user, isNewUser } = await this.usersService.findOrCreateGoogleUser({
      email: identity.email!,
      googleId: identity.sub,
      name: identity.name,
      avatarUrl: identity.picture,
    });

    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Missing refresh token. Check access_type=offline & prompt=consent',
      );
    }

    // Store Gmail OAuth refresh token for Gmail API access
    await this.usersService.updateGmailTokens((user as any)._id.toString(), {
      refreshToken: tokens.refresh_token!,
      scope: tokens.scope,
    });

    // Issue app JWT tokens (access + refresh)
    const { accessToken, refreshToken } = this.authService.issueTokens({
      sub: (user as any)._id,
      email: user.email,
    });

    // Store hashed refresh token server-side for validation
    await this.usersService.setRefreshToken(
      (user as any)._id.toString(),
      refreshToken,
    );

    const response = GoogleLoginResponseDto.create(
      accessToken,
      refreshToken,
      user,
      isNewUser,
    );
    const message = isNewUser ? 'Registration successful' : 'Login successful';
    return ApiResponseDto.success(response, message);
  }
}
