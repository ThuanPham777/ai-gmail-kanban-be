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

  async findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email }).exec();
  }

  async findById(userId: string): Promise<User | null> {
    return this.userModel.findById(userId).exec();
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.userModel.findOne({ googleId }).exec();
  }

  /**
   * Find or create a user by Google OAuth
   * - If user with googleId exists → login (return existing)
   * - If user with email exists → link Google account and login
   * - If no user exists → register new user
   * @returns { user, isNewUser } - isNewUser indicates if this was a registration
   */
  async findOrCreateGoogleUser(params: {
    email: string;
    googleId: string;
    name?: string;
    avatarUrl?: string;
  }): Promise<{ user: User; isNewUser: boolean }> {
    // Check if user already exists with this Google ID
    const existingByGoogleId = await this.userModel
      .findOne({ googleId: params.googleId })
      .exec();
    if (existingByGoogleId) {
      return { user: existingByGoogleId, isNewUser: false };
    }

    // Check if user exists with this email (may have been created differently)
    const existingByEmail = await this.userModel
      .findOne({ email: params.email })
      .exec();
    if (existingByEmail) {
      // Link Google data to existing account
      existingByEmail.googleId = params.googleId;
      existingByEmail.provider = 'google';
      existingByEmail.name = params.name ?? existingByEmail.name;
      existingByEmail.avatarUrl = params.avatarUrl ?? existingByEmail.avatarUrl;
      const savedUser = await existingByEmail.save();
      return { user: savedUser, isNewUser: false };
    }

    // Create new user (registration)
    const user = new this.userModel({
      email: params.email,
      provider: 'google',
      googleId: params.googleId,
      name: params.name,
      avatarUrl: params.avatarUrl,
    });
    const savedUser = await user.save();
    return { user: savedUser, isNewUser: true };
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

  /**
   * Update Gmail Watch data (historyId, expiration)
   */
  async updateGmailWatch(
    userId: string,
    data: { historyId: string; watchExpiration: Date },
  ) {
    await this.userModel.updateOne(
      { _id: userId },
      {
        $set: {
          'gmail.historyId': data.historyId,
          'gmail.watchExpiration': data.watchExpiration,
        },
      },
    );
  }

  /**
   * Update Gmail historyId after processing notifications
   */
  async updateGmailHistoryId(userId: string, historyId: string) {
    await this.userModel.updateOne(
      { _id: userId },
      { $set: { 'gmail.historyId': historyId } },
    );
  }

  /**
   * Get user by email (for webhook processing)
   */
  async findByEmailWithGmail(email: string) {
    return this.userModel.findOne({ email }).select('gmail email').exec();
  }

  /**
   * Find users with expiring Gmail watch
   */
  async findUsersWithExpiringWatch(beforeDate: Date) {
    return this.userModel
      .find({
        'gmail.refreshToken': { $exists: true, $ne: null },
        $or: [
          { 'gmail.watchExpiration': { $lt: beforeDate } },
          { 'gmail.watchExpiration': { $exists: false } },
        ],
      })
      .select('_id email gmail')
      .exec();
  }

  async getKanbanColumns(userId: string): Promise<KanbanColumnConfig[]> {
    let settings = await this.userSettingsModel.findOne({ userId }).exec();
    if (!settings) {
      // Create default settings if not exists
      settings = new this.userSettingsModel({ userId });
      await settings.save();
    }
    return [...settings.kanbanColumns].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
  }

  async updateKanbanColumns(
    userId: string,
    columns: KanbanColumnConfig[],
  ): Promise<KanbanColumnConfig[]> {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new ConflictException('At least one column is required.');
    }

    // Basic validation + normalization
    const idSet = new Set<string>();
    const normalized = columns.map((c, idx) => {
      const id = String(c.id ?? '').trim();
      const name = String(c.name ?? '').trim();
      const gmailLabel = c.gmailLabel ? String(c.gmailLabel).trim() : undefined;
      const order = Number.isFinite(Number(c.order)) ? Number(c.order) : idx;
      if (!id) throw new ConflictException('Column id is required.');
      if (!name) throw new ConflictException('Column name is required.');
      if (idSet.has(id)) {
        throw new ConflictException(
          `Duplicate column id "${id}" is not allowed.`,
        );
      }
      idSet.add(id);
      return { id, name, gmailLabel: gmailLabel || undefined, order };
    });

    // Normalize ordering to 0..n-1 by provided order
    normalized.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    normalized.forEach((c, i) => (c.order = i));

    // Validate for duplicate column names (case-insensitive)
    const nameMap = new Map<string, string>();
    for (const col of normalized) {
      const lowerName = col.name.toLowerCase().trim();
      if (nameMap.has(lowerName)) {
        throw new ConflictException(
          `Column name "${col.name}" is already used. Column names must be unique (case-insensitive).`,
        );
      }
      nameMap.set(lowerName, col.name);
    }

    // Validate for duplicate Gmail labels (case-insensitive, skip empty labels)
    const labelMap = new Map<string, string>();
    for (const col of normalized) {
      if (col.gmailLabel) {
        const lowerLabel = col.gmailLabel.toLowerCase().trim();
        if (labelMap.has(lowerLabel)) {
          throw new ConflictException(
            `Gmail label "${col.gmailLabel}" is already used by another column. Each Gmail label can only be assigned to one column.`,
          );
        }
        labelMap.set(lowerLabel, col.gmailLabel);
      }
    }

    const settings = await this.userSettingsModel
      .findOneAndUpdate(
        { userId },
        { kanbanColumns: normalized },
        { new: true, upsert: true },
      )
      .exec();
    return [...settings.kanbanColumns].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
  }
}
