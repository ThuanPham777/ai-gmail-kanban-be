import { Body, Controller, Post, UnauthorizedException, UseFilters } from '@nestjs/common';
import { UsersService } from './users.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { MongoExceptionFilter } from 'src/common/filters/mongo-exception.filter';
import { AuthService } from 'src/auth/auth.service';

@Controller('user')
@UseFilters(MongoExceptionFilter)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) { }

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const created = await this.users.create(dto.email, dto.password);
    return {
      status: 'success',
      message: 'User registered successfully',
      user: created, // password automatically omitted by toJSON()
    };
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    const user = await this.users.verifyCredentials(dto.email, dto.password);
    const { accessToken, refreshToken } = this.auth.issueTokens({
      sub: (user as any)._id,
      email: user.email,
    });
    await this.users.setRefreshToken((user as any)._id.toString(), refreshToken);
    return {
      status: 'success',
      message: 'Login successful',
      accessToken,
      refreshToken,
      user,
    };
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const user = await this.users.findByRefreshToken(refreshToken);
    const { accessToken, refreshToken: newRefreshToken } = this.auth.issueTokens({
      sub: (user as any)._id,
      email: user.email,
    });
    await this.users.setRefreshToken((user as any)._id.toString(), newRefreshToken);
    return {
      status: 'success',
      message: 'Token refreshed',
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  @Post('logout')
  async logout(@Body('userId') userId: string) {
    await this.users.clearRefreshToken(userId);
    return { status: 'success', message: 'Logged out' };
  }
}
