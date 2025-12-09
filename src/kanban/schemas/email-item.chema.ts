import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailItemDocument = EmailItem & Document;

export enum EmailStatus {
    INBOX = 'INBOX',
    TODO = 'TODO',
    IN_PROGRESS = 'IN_PROGRESS',
    DONE = 'DONE',
    SNOOZED = 'SNOOZED',
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

    @Prop({ enum: EmailStatus, default: EmailStatus.INBOX, index: true })
    status: EmailStatus;

    @Prop({ enum: EmailStatus })
    originalStatus?: EmailStatus;

    @Prop({ type: Date, index: true })
    snoozeUntil?: Date;

    @Prop() summary?: string;
    @Prop() lastSummarizedAt?: Date;
}

export const EmailItemSchema = SchemaFactory.createForClass(EmailItem);

// unique per user + message
EmailItemSchema.index({ userId: 1, messageId: 1 }, { unique: true });
