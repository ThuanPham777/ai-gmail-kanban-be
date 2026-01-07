import { UserResponseDto } from './user.response.dto';

export class RefreshTokenResponseDto {
  accessToken: string;
  refreshToken: string;

  static create(
    accessToken: string,
    refreshToken: string,
  ): RefreshTokenResponseDto {
    return {
      accessToken,
      refreshToken,
    };
  }
}

export class GoogleLoginResponseDto {
  accessToken: string;
  refreshToken: string;
  user: UserResponseDto;
  provider: string;
  isNewUser?: boolean;

  static create(
    accessToken: string,
    refreshToken: string,
    user: any,
    isNewUser?: boolean,
  ): GoogleLoginResponseDto {
    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.fromEntity(user, true),
      provider: 'google',
      isNewUser,
    };
  }
}
