import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import {
  UserSettings,
  KanbanColumnConfig,
} from './schemas/user-settings.schema';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(UserSettings.name)
    private userSettingsModel: Model<UserSettings>,
  ) {}

  async createLocalUser(
    email: string,
    rawPassword: string,
    name?: string,
  ): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email is already registered');
    }
    const user = new this.userModel({
      email,
      password: rawPassword,
      name,
      provider: 'password',
    });
    return user.save();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email }).exec();
  }

  async findById(userId: string): Promise<User | null> {
    return this.userModel.findById(userId).exec();
  }

  async verifyCredentials(email: string, password: string): Promise<User> {
    const user = await this.findByEmail(email);
    if (!user || user.provider !== 'password' || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return user;
  }

  async findOrCreateGoogleUser(params: {
    email: string;
    googleId: string;
    name?: string;
    avatarUrl?: string;
  }): Promise<User> {
    const existingByGoogleId = await this.userModel
      .findOne({ googleId: params.googleId })
      .exec();
    if (existingByGoogleId) return existingByGoogleId;

    const existingByEmail = await this.userModel
      .findOne({ email: params.email })
      .exec();
    if (existingByEmail) {
      // Link Google data to existing account
      existingByEmail.googleId = params.googleId;
      existingByEmail.provider = 'google';
      existingByEmail.name = params.name ?? existingByEmail.name;
      existingByEmail.avatarUrl = params.avatarUrl ?? existingByEmail.avatarUrl;
      return existingByEmail.save();
    }

    const user = new this.userModel({
      email: params.email,
      provider: 'google',
      googleId: params.googleId,
      name: params.name,
      avatarUrl: params.avatarUrl,
    });
    return user.save();
  }

  async setRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(refreshToken, salt);
    await this.userModel
      .updateOne({ _id: userId }, { $set: { refreshToken: hashed } })
      .exec();
  }

  async clearRefreshToken(userId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $unset: { refreshToken: 1 } })
      .exec();
  }

  async validateRefreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<User> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.refreshToken)
      throw new UnauthorizedException('Invalid refresh token');
    const matches = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!matches) throw new UnauthorizedException('Invalid refresh token');
    return user;
  }

  async updateGmailTokens(
    userId: string,
    data: { refreshToken: string; scope?: string },
  ) {
    await this.userModel.updateOne(
      { _id: userId },
      {
        gmail: {
          refreshToken: data.refreshToken,
          scope: data.scope,
          connectedAt: new Date(),
        },
      },
    );
  }

  async getGmailRefreshToken(userId: string) {
    const user = await this.userModel.findById(userId).select('gmail email');
    if (!user?.gmail?.refreshToken) {
      throw new UnauthorizedException('Gmail is not connected');
    }
    return { refreshToken: user.gmail.refreshToken, email: user.email };
  }

  async getKanbanColumns(userId: string): Promise<KanbanColumnConfig[]> {
    let settings = await this.userSettingsModel.findOne({ userId }).exec();
    if (!settings) {
      // Create default settings if not exists
      settings = new this.userSettingsModel({ userId });
      await settings.save();
    }
    return settings.kanbanColumns;
  }

  async updateKanbanColumns(
    userId: string,
    columns: KanbanColumnConfig[],
  ): Promise<KanbanColumnConfig[]> {
    // Validate for duplicate column names (case-insensitive)
    const nameMap = new Map<string, string>();
    for (const col of columns) {
      const lowerName = col.name.toLowerCase().trim();
      if (nameMap.has(lowerName)) {
        throw new ConflictException(
          `Column name "${col.name}" is already used. Column names must be unique (case-insensitive).`,
        );
      }
      nameMap.set(lowerName, col.name);
    }

    const settings = await this.userSettingsModel
      .findOneAndUpdate(
        { userId },
        { kanbanColumns: columns },
        { new: true, upsert: true },
      )
      .exec();
    return settings.kanbanColumns;
  }
}
