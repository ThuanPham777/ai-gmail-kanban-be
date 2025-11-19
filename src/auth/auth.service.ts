import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) { }

  issueAccessToken(payload: Record<string, any>) {
    const accessTtl = this.config.get<string>('JWT_ACCESS_EXPIRES') ?? '15m';
    return this.jwt.sign(payload, { expiresIn: accessTtl as `${number}${'m' | 'h' | 'd'}` | number });
  }

  issueRefreshToken(payload: Record<string, any>) {
    const refreshTtl = this.config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d';
    return this.jwt.sign(payload, { expiresIn: refreshTtl as `${number}${'m' | 'h' | 'd'}` | number });
  }

  issueTokens(payload: Record<string, any>) {
    const accessToken = this.issueAccessToken(payload);
    const refreshToken = this.issueRefreshToken(payload);
    return { accessToken, refreshToken };
  }
}
