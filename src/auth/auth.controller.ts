import {
  Controller,
  Post,
  Body,
  BadRequestException,
  UnauthorizedException,
  UseFilters,
  Res,
  Req,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { MongoExceptionFilter } from '../common/filters/mongo-exception.filter';
import { GoogleAuthService } from './google-auth.service';
import { JwtPayload } from './strategies/jwt.strategy';
import { LogoutDto, GoogleLoginDto } from './dtos/request';
import {
  RefreshTokenResponseDto,
  GoogleLoginResponseDto,
} from './dtos/response';
import { ApiResponseDto } from '../common/dtos/api-response.dto';

const REFRESH_TOKEN_COOKIE = 'refresh_token';
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

@Controller('api/auth')
@UseFilters(MongoExceptionFilter)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Helper to set refresh token as HttpOnly cookie
   * Security: Cookie is HttpOnly, Secure (in production), SameSite=Lax
   *
   * NOTE on SameSite:
   * - 'strict': Cookie NOT sent on cross-origin requests (breaks new tab/refresh)
   * - 'lax': Cookie sent on top-level navigations (GET) and same-origin requests
   * - 'none': Cookie always sent (requires Secure=true, HTTPS only)
   *
   * We use 'lax' for development (localhost cross-port) and 'none' for production
   * (cross-origin between frontend domain and backend domain)
   */
  private setRefreshTokenCookie(res: Response, refreshToken: string) {
    const isProduction = this.configService.get('NODE_ENV') === 'production';
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      secure: isProduction, // HTTPS only in production
      sameSite: isProduction ? 'none' : 'lax', // 'none' for cross-origin in prod, 'lax' for dev
      maxAge: REFRESH_TOKEN_MAX_AGE,
      path: '/', // Allow cookie to be sent to all paths (interceptor needs it)
    });
  }

  /**
   * Helper to clear refresh token cookie
   */
  private clearRefreshTokenCookie(res: Response) {
    const isProduction = this.configService.get('NODE_ENV') === 'production';
    res.clearCookie(REFRESH_TOKEN_COOKIE, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/',
    });
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<RefreshTokenResponseDto>> {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: JwtPayload;
    try {
      payload =
        await this.authService.verifyRefreshToken<JwtPayload>(refreshToken);
    } catch {
      this.clearRefreshTokenCookie(res);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.validateRefreshToken(
      payload.sub,
      refreshToken,
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

    // Set new refresh token in HttpOnly cookie
    this.setRefreshTokenCookie(res, newRefreshToken);

    // Only return accessToken in response body (refresh token is in cookie)
    const response = RefreshTokenResponseDto.create(accessToken);
    return ApiResponseDto.success(response, 'Token refreshed');
  }

  @Post('logout')
  async logout(
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<null>> {
    if (!dto.userId) {
      throw new BadRequestException('Missing user id');
    }

    await this.usersService.clearRefreshToken(dto.userId);

    // Clear the refresh token cookie
    this.clearRefreshTokenCookie(res);

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
    @Res({ passthrough: true }) res: Response,
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

    // Set refresh token in HttpOnly cookie (not in response body)
    this.setRefreshTokenCookie(res, refreshToken);

    // Only return accessToken in response body (refresh token is in cookie)
    const response = GoogleLoginResponseDto.create(
      accessToken,
      user,
      isNewUser,
    );
    const message = isNewUser ? 'Registration successful' : 'Login successful';
    return ApiResponseDto.success(response, message);
  }
}
