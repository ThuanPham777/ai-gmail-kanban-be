import {
    Injectable,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { UsersService } from '../users/users.service';

interface EmailListItem {
    id: string;          // format: labelId|messageId
    mailboxId: string;   // labelId
    senderName: string;
    senderEmail: string;
    subject: string;
    preview: string;
    timestamp: string;
    starred: boolean;
    unread: boolean;
    important: boolean;
}

interface EmailDetail extends EmailListItem {
    to: string[];
    cc?: string[];
    body: string;
    attachments?: {
        id: string;        // gmail attachmentId
        fileName: string;
        size: string;
        type: string;
    }[];
    threadId?: string;
}

interface ModifyActions {
    markRead?: boolean;
    markUnread?: boolean;
    star?: boolean;
    unstar?: boolean;
    delete?: boolean;
}

@Injectable()
export class MailService {
    constructor(
        private readonly config: ConfigService,
        private readonly usersService: UsersService,
    ) { }

    private composeEmailId(mailboxId: string, messageId: string) {
        return `${encodeURIComponent(mailboxId)}|${messageId}`;
    }

    private parseEmailId(emailId: string) {
        const [encodedMailbox, messageId] = emailId.split('|');
        const mailboxId = decodeURIComponent(encodedMailbox ?? '');
        if (!mailboxId || !messageId) {
            throw new BadRequestException('Invalid email id');
        }
        return { mailboxId, messageId };
    }

    private async getGmailClient(userId: string) {
        const { refreshToken } = await this.usersService.getGmailRefreshToken(userId);

        const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
        const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');

        const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oAuth2Client.setCredentials({ refresh_token: refreshToken });

        return google.gmail({ version: 'v1', auth: oAuth2Client });
    }

    private getHeader(headers: any[] | undefined, name: string) {
        const h = headers?.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
        return h?.value ?? '';
    }

    private parseAddress(raw: string) {
        // format đơn giản: "Name <email>" hoặc "email"
        const match = raw.match(/(.*)<(.+@.+)>/);
        if (match) {
            return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
        }
        return { name: raw || 'Unknown', email: raw };
    }

    private base64UrlDecode(input: string) {
        const pad = '='.repeat((4 - (input.length % 4)) % 4);
        const base64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    private extractBody(payload: any): string {
        if (!payload) return '<p>No content</p>';

        // ưu tiên text/html
        if (payload.mimeType === 'text/html' && payload.body?.data) {
            return this.base64UrlDecode(payload.body.data);
        }
        if (payload.mimeType === 'text/plain' && payload.body?.data) {
            const text = this.base64UrlDecode(payload.body.data);
            return `<pre>${text}</pre>`;
        }

        // duyệt parts
        if (payload.parts?.length) {
            // tìm html
            for (const p of payload.parts) {
                const html = this.extractBody(p);
                if (html && !html.includes('No content')) return html;
            }
        }

        return '<p>No content</p>';
    }

    private extractAttachments(payload: any) {
        const result: Array<{ id: string; fileName: string; size: string; type: string }> = [];

        const walk = (node: any) => {
            if (!node) return;

            const filename = node.filename;
            const body = node.body;

            if (filename && body?.attachmentId) {
                result.push({
                    id: body.attachmentId,
                    fileName: filename,
                    size: `${body.size ?? 0} bytes`,
                    type: node.mimeType ?? 'application/octet-stream',
                });
            }

            if (node.parts?.length) {
                for (const p of node.parts) walk(p);
            }
        };

        walk(payload);
        return result.length ? result : undefined;
    }

    // ✅ Labels = "mailboxes"
    async getMailboxes(userId: string) {
        const gmail = await this.getGmailClient(userId);
        const res = await gmail.users.labels.list({ userId: 'me' });

        const labels = res.data.labels ?? [];

        // Lấy unread count (có thể tốn call nhưng ok cho demo)
        const items: Array<{ id: string; name: string; unread?: number }> = [];
        for (const lb of labels) {
            if (!lb.id) continue;
            const detail = await gmail.users.labels.get({ userId: 'me', id: lb.id }).catch(() => null);
            items.push({
                id: lb.id,
                name: lb.name ?? lb.id,
                unread: detail?.data?.messagesUnread ?? 0,
            });
        }

        return items;
    }

    // ✅ Page number không phải native của Gmail API
    // Mình implement tối thiểu để giữ contract FE:
    async getEmailsByMailbox(userId: string, mailboxId: string, page = 1, pageSize = 20) {
        const gmail = await this.getGmailClient(userId);
        const safePage = page > 0 ? page : 1;
        const safeSize = Math.min(Math.max(pageSize, 1), 50);

        // duyệt pageToken tuần tự tới page cần lấy
        let pageToken: string | undefined = undefined;
        for (let i = 1; i < safePage; i++) {
            const step = await gmail.users.messages.list({
                userId: 'me',
                labelIds: [mailboxId],
                maxResults: safeSize,
                pageToken,
            });
            pageToken = step.data.nextPageToken ?? undefined;
            if (!pageToken) break;
        }

        const list = await gmail.users.messages.list({
            userId: 'me',
            labelIds: [mailboxId],
            maxResults: safeSize,
            pageToken,
        });

        const msgs = list.data.messages ?? [];

        const data: EmailListItem[] = [];
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
            const dateRaw = this.getHeader(headers, 'Date');

            const from = this.parseAddress(fromRaw);
            const labelIds = detail.data.labelIds ?? [];

            data.push({
                id: this.composeEmailId(mailboxId, m.id),
                mailboxId,
                senderName: from.name,
                senderEmail: from.email,
                subject,
                preview: subject,
                timestamp: dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString(),
                starred: labelIds.includes('STARRED'),
                unread: labelIds.includes('UNREAD'),
                important: labelIds.includes('IMPORTANT'),
            });
        }

        return {
            data,
            meta: {
                total: undefined, // Gmail API không trả total theo label dễ dàng
                page: safePage,
                pageSize: safeSize,
                nextPageToken: list.data.nextPageToken ?? null,
            },
        };
    }

    async getEmailById(userId: string, emailId: string): Promise<EmailDetail> {
        const { mailboxId, messageId } = this.parseEmailId(emailId);
        const gmail = await this.getGmailClient(userId);

        const msg = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        if (!msg.data) throw new NotFoundException('Email not found');

        const headers = msg.data.payload?.headers ?? [];
        const fromRaw = this.getHeader(headers, 'From');
        const subject = this.getHeader(headers, 'Subject') || '(No subject)';
        const dateRaw = this.getHeader(headers, 'Date');
        const toRaw = this.getHeader(headers, 'To');
        const ccRaw = this.getHeader(headers, 'Cc');

        const from = this.parseAddress(fromRaw);
        const labelIds = msg.data.labelIds ?? [];

        const body = this.extractBody(msg.data.payload);
        const attachments = this.extractAttachments(msg.data.payload);

        const to = toRaw
            ? toRaw.split(',').map((s) => this.parseAddress(s.trim()).email).filter(Boolean)
            : [];

        const cc = ccRaw
            ? ccRaw.split(',').map((s) => this.parseAddress(s.trim()).email).filter(Boolean)
            : undefined;

        return {
            id: this.composeEmailId(mailboxId, messageId),
            mailboxId,
            senderName: from.name,
            senderEmail: from.email,
            subject,
            preview: subject,
            timestamp: dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString(),
            starred: labelIds.includes('STARRED'),
            unread: labelIds.includes('UNREAD'),
            important: labelIds.includes('IMPORTANT'),
            to,
            cc,
            body,
            attachments,
            threadId: msg.data.threadId ?? undefined,
        };
    }

    private buildRawEmail(from: string, to: string[], subject: string, html: string, extraHeaders?: Record<string, string>) {
        const headers: string[] = [
            `From: ${from}`,
            `To: ${to.join(', ')}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset="UTF-8"',
        ];

        if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) {
                headers.splice(3, 0, `${k}: ${v}`); // chèn trước MIME lines
            }
        }

        const message = `${headers.join('\r\n')}\r\n\r\n${html}`;
        return Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    async sendEmail(userId: string, data: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }) {
        if (!data.to?.length) throw new BadRequestException('At least one recipient is required');

        const gmail = await this.getGmailClient(userId);
        const user = await this.usersService.findById(userId);

        // NOTE: demo đơn giản chưa add CC/BCC headers
        const raw = this.buildRawEmail(user.email, data.to, data.subject, data.body);

        const res = await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw },
        });

        return res.data.id;
    }

    async replyToEmail(userId: string, emailId: string, body: string, replyAll = false) {
        const { messageId } = this.parseEmailId(emailId);
        const gmail = await this.getGmailClient(userId);
        const user = await this.usersService.findById(userId);

        const original = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
        });

        const headers = original.data.payload?.headers ?? [];
        const fromRaw = this.getHeader(headers, 'From');
        const toRaw = this.getHeader(headers, 'To');
        const ccRaw = this.getHeader(headers, 'Cc');
        const subjectRaw = this.getHeader(headers, 'Subject');
        const messageIdHeader = this.getHeader(headers, 'Message-ID');
        const referencesHeader = this.getHeader(headers, 'References');

        const from = this.parseAddress(fromRaw);

        let recipients: string[] = [];
        if (replyAll) {
            const all = [
                from.email,
                ...toRaw.split(',').map((s) => this.parseAddress(s.trim()).email),
                ...ccRaw.split(',').map((s) => this.parseAddress(s.trim()).email),
            ].filter(Boolean);

            recipients = Array.from(new Set(all)).filter((e) => e && e !== user.email);
        } else {
            recipients = from.email ? [from.email] : [];
        }

        if (!recipients.length) throw new BadRequestException('No recipients for reply');

        const subject = subjectRaw.startsWith('Re:') ? subjectRaw : `Re: ${subjectRaw}`;

        const extraHeaders: Record<string, string> = {};
        if (messageIdHeader) extraHeaders['In-Reply-To'] = messageIdHeader;
        if (referencesHeader) extraHeaders['References'] = referencesHeader;
        else if (messageIdHeader) extraHeaders['References'] = messageIdHeader;

        const raw = this.buildRawEmail(user.email, recipients, subject, body, extraHeaders);

        const res = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw,
                threadId: original.data.threadId,
            },
        });

        return res.data.id;
    }

    async modifyEmail(userId: string, emailId: string, actions: ModifyActions) {
        const { messageId } = this.parseEmailId(emailId);
        const gmail = await this.getGmailClient(userId);

        if (actions.delete) {
            await gmail.users.messages.trash({ userId: 'me', id: messageId });
            return;
        }

        const addLabelIds: string[] = [];
        const removeLabelIds: string[] = [];

        if (actions.markRead) removeLabelIds.push('UNREAD');
        if (actions.markUnread) addLabelIds.push('UNREAD');
        if (actions.star) addLabelIds.push('STARRED');
        if (actions.unstar) removeLabelIds.push('STARRED');

        if (addLabelIds.length || removeLabelIds.length) {
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: { addLabelIds, removeLabelIds },
            });
        }
    }

    async getAttachment(userId: string, emailId: string, attachmentId: string) {
        const { messageId } = this.parseEmailId(emailId);
        const gmail = await this.getGmailClient(userId);

        const att = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: attachmentId,
        });

        const data = att.data.data;
        if (!data) throw new NotFoundException('Attachment not found');

        const buffer = Buffer.from(
            data.replace(/-/g, '+').replace(/_/g, '/'),
            'base64',
        );

        // mimeType/filename phải lấy từ EmailDetail attachments list
        return {
            data: buffer,
            mimeType: 'application/octet-stream',
            filename: `attachment-${attachmentId}`,
        };
    }
}
