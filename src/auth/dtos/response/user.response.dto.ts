export class UserResponseDto {
  _id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  provider: 'google';
  googleId: string;
  gmailConnected?: boolean;
  createdAt: Date;

  static fromEntity(user: any, gmailConnected?: boolean): UserResponseDto {
    return {
      _id: user._id.toString(),
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      provider: user.provider,
      googleId: user.googleId,
      gmailConnected: gmailConnected ?? !!user.gmail?.refreshToken,
      createdAt: user.createdAt,
    };
  }
}
