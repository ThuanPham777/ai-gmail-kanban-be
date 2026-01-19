import { UserResponseDto } from './user.response.dto';

export class RefreshTokenResponseDto {
  accessToken: string;

  static create(accessToken: string): RefreshTokenResponseDto {
    return {
      accessToken,
    };
  }
}

export class GoogleLoginResponseDto {
  accessToken: string;
  user: UserResponseDto;
  provider: string;
  isNewUser?: boolean;

  static create(
    accessToken: string,
    user: any,
    isNewUser?: boolean,
  ): GoogleLoginResponseDto {
    return {
      accessToken,
      user: UserResponseDto.fromEntity(user, true),
      provider: 'google',
      isNewUser,
    };
  }
}
