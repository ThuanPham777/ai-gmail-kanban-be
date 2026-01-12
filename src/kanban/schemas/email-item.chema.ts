import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailItemDocument = EmailItem & Document;

/**
 * Built-in email status constants.
 * Note: The 'status' field accepts ANY string (for dynamic columns),
 * but these constants are used for:
 * - SNOOZED functionality (special status, not a column)
 * - Default values
 * - Built-in column IDs
 */
export enum EmailStatus {
  INBOX = 'INBOX',
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  SNOOZED = 'SNOOZED', // Special: temporary status for snoozed emails
}

@Schema({ timestamps: true, collection: 'email_items' })
export class EmailItem {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ default: 'gmail', enum: ['gmail'] })
  provider: 'gmail';

  // Gmail message id
  @Prop({ required: true })
  messageId: string;

  // Optional: labelId nếu muốn gắn theo mailbox
  @Prop()
  mailboxId?: string;

  // Snapshot metadata để render nhanh
  @Prop() senderName?: string;
  @Prop() senderEmail?: string;
  @Prop() subject?: string;
  @Prop() snippet?: string;
  @Prop() threadId?: string;

  // Kanban column id. Historically this was limited to EmailStatus enum,
  // but for dynamic column configuration we allow any string.
  @Prop({ type: String, default: EmailStatus.INBOX, index: true })
  status: string;

  @Prop({ type: String })
  originalStatus?: string;

  @Prop({ type: Date, index: true })
  snoozeUntil?: Date;

  @Prop() summary?: string;
  @Prop() lastSummarizedAt?: Date;

  // Email received/sent date from Gmail (internalDate)
  // Used for sorting emails by actual received time, not DB insert time
  @Prop({ type: Date, index: true })
  receivedAt?: Date;

  // Whether the message has attachments (set during sync or when fetching details)
  @Prop() hasAttachments?: boolean;

  // Embedding metadata
  @Prop() hasEmbedding?: boolean;
  @Prop() embeddingGeneratedAt?: Date;
}

export const EmailItemSchema = SchemaFactory.createForClass(EmailItem);

// unique per user + message
EmailItemSchema.index({ userId: 1, messageId: 1 }, { unique: true });
