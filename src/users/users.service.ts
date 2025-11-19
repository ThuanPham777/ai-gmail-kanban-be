import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) { }

  async create(email: string, rawPassword: string): Promise<User> {
    const user = new this.userModel({ email, password: rawPassword });
    return user.save();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email }).exec();
  }


  async verifyCredentials(email: string, password: string): Promise<User> {
    const user = await this.findByEmail(email);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return user;
  }

  async setRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(refreshToken, salt);
    await this.userModel.updateOne({ _id: userId }, { $set: { refreshToken: hashed } }).exec();
  }

  async clearRefreshToken(userId: string): Promise<void> {
    await this.userModel.updateOne({ _id: userId }, { $unset: { refreshToken: 1 } }).exec();
  }

  async validateRefreshToken(userId: string, refreshToken: string): Promise<User> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.refreshToken) throw new UnauthorizedException('Invalid refresh token');
    const matches = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!matches) throw new UnauthorizedException('Invalid refresh token');
    return user;
  }

  async findByRefreshToken(refreshToken: string): Promise<User> {
    // Iterate over users with stored refresh tokens and compare hashed values
    const candidates = await this.userModel
      .find({ refreshToken: { $exists: true, $ne: null } })
      .select(['_id', 'email', 'refreshToken', 'password'])
      .exec();
    for (const user of candidates) {
      if (user.refreshToken && (await bcrypt.compare(refreshToken, user.refreshToken))) {
        return user;
      }
    }
    throw new UnauthorizedException('Invalid refresh token');
  }
}
