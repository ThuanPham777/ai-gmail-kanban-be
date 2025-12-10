import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { UsersService } from '../users/users.service';
import { EmailItem, EmailItemDocument, EmailStatus } from './schemas/email-item.chema';
import { AiService } from 'src/ai/ai.service';

// NOTE: demo LLM giản lược.
// Bạn có thể thay bằng OpenAI/Groq service của bạn.
async function fakeSummarize(htmlOrText: string) {
    const text = htmlOrText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 240) + (text.length > 240 ? '...' : '');
}

@Injectable()
export class KanbanService {
    constructor(
        @InjectModel(EmailItem.name) private emailItemModel: Model<EmailItemDocument>,
        private readonly usersService: UsersService,
        private readonly config: ConfigService,
        private readonly ai: AiService,
    ) { }

    private async getGmailClient(userId: string) {
        const { refreshToken } = await this.usersService.getGmailRefreshToken(userId);

        const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
        const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');

        const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oAuth2Client.setCredentials({ refresh_token: refreshToken });

        return google.gmail({ version: 'v1', auth: oAuth2Client });
    }

    private base64UrlDecode(input: string) {
        const pad = '='.repeat((4 - (input.length % 4)) % 4);
        const base64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    private extractText(payload: any): { html?: string; text?: string } {
        if (!payload) return {};

        const mime = payload.mimeType;
        const data = payload.body?.data;

        if (mime === 'text/html' && data) {
            const html = this.base64UrlDecode(data);
            return { html, text: this.ai.stripHtml(html) };
        }

        if (mime === 'text/plain' && data) {
            const text = this.base64UrlDecode(data);
            return { text };
        }

        if (payload.parts?.length) {
            for (const p of payload.parts) {
                const r = this.extractText(p);
                if (r.html || r.text) return r;
            }
        }

        return {};
    }

    private getHeader(headers: any[] | undefined, name: string) {
        const h = headers?.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
        return h?.value ?? '';
    }

    private parseAddress(raw: string) {
        const match = raw.match(/(.*)<(.+@.+)>/);
        if (match) {
            return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
        }
        return { name: raw || 'Unknown', email: raw };
    }

    /**
     * Đồng bộ tối thiểu: lấy list Gmail messages theo label,
     * upsert vào email_items để phục vụ Kanban.
     */
    async syncLabelToItems(userId: string, labelId = 'INBOX', maxResults = 30) {
        const gmail = await this.getGmailClient(userId);

        const list = await gmail.users.messages.list({
            userId: 'me',
            labelIds: [labelId],
            maxResults,
        });

        const msgs = list.data.messages ?? [];
        const uid = new Types.ObjectId(userId);

        for (const m of msgs) {
            if (!m.id) continue;

            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: m.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'Date'],
            });

            const headers = detail.data.payload?.headers ?? [];
            const fromRaw = this.getHeader(headers, 'From');
            const subject = this.getHeader(headers, 'Subject') || '(No subject)';
            const from = this.parseAddress(fromRaw);

            await this.emailItemModel.updateOne(
                { userId: uid, messageId: m.id },
                {
                    $setOnInsert: {
                        userId: uid,
                        provider: 'gmail',
                        messageId: m.id,
                        status: EmailStatus.INBOX,
                    },
                    $set: {
                        mailboxId: labelId,
                        senderName: from.name,
                        senderEmail: from.email,
                        subject,
                        snippet: subject,
                        threadId: detail.data.threadId,
                    },
                },
                { upsert: true },
            );
        }

        return { synced: msgs.length };
    }

    async getBoard(userId: string, labelId?: string) {
        // Optional sync khi mở board lần đầu
        if (labelId) {
            await this.syncLabelToItems(userId, labelId, 5);
        } else {
            await this.syncLabelToItems(userId, 'INBOX', 5);
        }

        const uid = new Types.ObjectId(userId);

        const items = await this.emailItemModel
            .find({ userId: uid })
            .sort({ updatedAt: -1 })
            .lean();

        const group = (status: EmailStatus) => items.filter((i) => i.status === status);

        return {
            INBOX: group(EmailStatus.INBOX),
            TODO: group(EmailStatus.TODO),
            IN_PROGRESS: group(EmailStatus.IN_PROGRESS),
            DONE: group(EmailStatus.DONE),
            SNOOZED: group(EmailStatus.SNOOZED),
        };
    }

    async updateStatus(userId: string, messageId: string, status: EmailStatus) {
        const uid = new Types.ObjectId(userId);

        const updated = await this.emailItemModel.findOneAndUpdate(
            { userId: uid, messageId },
            { $set: { status }, $unset: { snoozeUntil: 1, originalStatus: 1 } },
            { new: true },
        );

        if (!updated) throw new NotFoundException('Email item not found');
        return updated;
    }

    async snooze(userId: string, messageId: string, until: string) {
        const date = new Date(until);
        if (!Number.isFinite(date.getTime())) {
            throw new BadRequestException('Invalid snooze datetime');
        }

        const uid = new Types.ObjectId(userId);

        const item = await this.emailItemModel.findOne({ userId: uid, messageId });
        if (!item) throw new NotFoundException('Email item not found');

        const original = item.status === EmailStatus.SNOOZED ? item.originalStatus : item.status;

        item.status = EmailStatus.SNOOZED;
        item.originalStatus = original ?? EmailStatus.INBOX;
        item.snoozeUntil = date;

        return item.save();
    }

    async summarize(userId: string, messageId: string) {
        const uid = new Types.ObjectId(userId);
        const item = await this.emailItemModel.findOne({ userId: uid, messageId });
        if (!item) throw new NotFoundException('Email item not found');

        // cache 24h
        if (item.summary && item.lastSummarizedAt) {
            const diff = Date.now() - item.lastSummarizedAt.getTime();
            if (diff < 24 * 60 * 60 * 1000) {
                return { summary: item.summary, cached: true };
            }
        }

        const gmail = await this.getGmailClient(userId);
        const msg = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const payload = msg.data.payload;
        const { html, text } = this.extractText(payload);

        const fallback = msg.data.snippet ?? item.subject ?? 'No content';
        const bodyText = text?.trim() || fallback;

        const s = await this.ai.summarizeEmail({
            subject: item.subject,
            fromEmail: item.senderEmail,
            fromName: item.senderName,
            bodyHtml: html,
            bodyText,
        });

        item.summary = s.summary;
        item.lastSummarizedAt = new Date();
        // optional nếu bạn thêm field:
        // (item as any).summaryModel = s.model;
        // (item as any).bodyHash = s.bodyHash;

        await item.save();

        return { summary: s.summary, cached: false };
    }

    /**
     * Cron sẽ gọi hàm này
     */
    async wakeExpiredSnoozed() {
        const now = new Date();

        const items = await this.emailItemModel.find({
            status: EmailStatus.SNOOZED,
            snoozeUntil: { $lte: now },
        });

        for (const it of items) {
            await this.emailItemModel.updateOne(
                { _id: it._id },
                {
                    $set: { status: it.originalStatus ?? EmailStatus.INBOX },
                    $unset: { snoozeUntil: 1, originalStatus: 1 },
                },
            );
        }

        return { woke: items.length };
    }
}
