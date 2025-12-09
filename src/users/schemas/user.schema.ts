import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import * as bcrypt from 'bcrypt';

export type UserDocument = User & Document;

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'users',
})
export class User {
  toJSON() {
      throw new Error('Method not implemented.');
  }
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({
    required: function (this: User) {
      return this.provider === 'password';
    },
  })
  password?: string;

  @Prop({ required: false, trim: true })
  name?: string;

  @Prop({ required: false })
  avatarUrl?: string;

  @Prop({
    required: true,
    enum: ['password', 'google'],
    default: 'password',
  })
  provider: 'password' | 'google';

  // Google identity (để identify user)
  @Prop({ required: false, unique: true, sparse: true })
  googleId?: string;

  // Refresh token của app (JWT refresh)
  @Prop({ required: false })
  refreshToken?: string;

  // Gmail OAuth (per-user)
  @Prop({
    required: false,
    type: {
      refreshToken: { type: String, required: false },
      scope: { type: String, required: false },
      connectedAt: { type: Date, required: false },
    },
    _id: false,
  })
  gmail?: {
    refreshToken?: string;
    scope?: string;
    connectedAt?: Date;
  };

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Hide password when JSON stringifying
UserSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    delete ret.password;
    if (ret.gmail?.refreshToken) {
      // không nên trả token ra client
      delete ret.gmail.refreshToken;
    }
    return ret;
  },
});

// Hash on create or when password changed
UserSchema.pre<UserDocument>('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});
