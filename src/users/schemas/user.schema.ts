import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'users',
})
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: false, trim: true })
  name?: string;

  @Prop({ required: false })
  avatarUrl?: string;

  @Prop({
    required: true,
    enum: ['google'],
    default: 'google',
  })
  provider: 'google';

  // Google identity (để identify user)
  @Prop({ required: true, unique: true })
  googleId: string;

  // Refresh token của app (JWT refresh) - stored hashed
  @Prop({ required: false })
  refreshToken?: string;

  // Gmail OAuth (per-user)
  @Prop({
    required: false,
    type: {
      refreshToken: { type: String, required: false },
      scope: { type: String, required: false },
      connectedAt: { type: Date, required: false },
      // Gmail Push Notifications (Watch API)
      historyId: { type: String, required: false },
      watchExpiration: { type: Date, required: false },
    },
    _id: false,
  })
  gmail?: {
    refreshToken?: string;
    scope?: string;
    connectedAt?: Date;
    historyId?: string;
    watchExpiration?: Date;
  };

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Hide sensitive data when JSON stringifying
UserSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    // never expose app refresh token to client
    delete ret.refreshToken;
    if (ret.gmail?.refreshToken) {
      // không nên trả Gmail refresh token ra client
      delete ret.gmail.refreshToken;
    }
    return ret;
  },
});
