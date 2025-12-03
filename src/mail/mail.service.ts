import {
    Injectable,
    InternalServerErrorException,
    NotFoundException,
    BadRequestException,
    HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';

interface EmailListItem {
    id: string;
    mailboxId: string;
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
        id: string;
        fileName: string;
        size: string;
        type: string;
    }[];
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
    private readonly imapOptions: any;
    private readonly smtpTransport: nodemailer.Transporter;

    constructor(private readonly config: ConfigService) {
        this.imapOptions = {
            host: this.config.getOrThrow<string>('IMAP_HOST'),
            port: Number(this.config.get<string>('IMAP_PORT') ?? 993),
            secure: this.config.get<string>('IMAP_SECURE') !== 'false',
            auth: {
                user: this.config.getOrThrow<string>('IMAP_USER'),
                pass: this.config.getOrThrow<string>('IMAP_PASS'),
            },
        };

        this.smtpTransport = nodemailer.createTransport({
            host: this.config.getOrThrow<string>('SMTP_HOST'),
            port: Number(this.config.get<string>('SMTP_PORT') ?? 465),
            secure: this.config.get<string>('SMTP_SECURE') !== 'false',
            auth: {
                user: this.config.getOrThrow<string>('SMTP_USER'),
                pass: this.config.getOrThrow<string>('SMTP_PASS'),
            },
        });
    }



    private composeEmailId(mailboxId: string, uid: number) {
        return `${encodeURIComponent(mailboxId)}|${uid}`;
    }

    private parseEmailId(emailId: string) {
        const [encodedMailbox, uidStr] = emailId.split('|');
        const mailboxId = decodeURIComponent(encodedMailbox ?? '');
        const uid = Number(uidStr);
        if (!mailboxId || !Number.isFinite(uid)) {
            throw new BadRequestException('Invalid email id');
        }
        return { mailboxId, uid };
    }

    private async withClient<T>(handler: (client: ImapFlow) => Promise<T>): Promise<T> {
        const client = new ImapFlow(this.imapOptions);
        try {
            await client.connect();
            return await handler(client);
        } catch (error) {
            // Nếu là HttpException (NotFound, BadRequest, ...) thì giữ nguyên
            if (error instanceof HttpException) {
                throw error;
            }
            throw new InternalServerErrorException(error?.message || 'IMAP operation failed');
        } finally {
            try {
                await client.logout();
            } catch {
                // ignore
            }
        }
    }

    private formatAddress(address?: { name?: string; address?: string }) {
        if (!address) return { name: 'Unknown sender', email: '' };
        return {
            name: address.name || address.address || 'Unknown sender',
            email: address.address || '',
        };
    }

    async getMailboxes() {
        return this.withClient(async (client) => {
            const list = await client.list();
            const items: Array<{ id: string; name: string; unread?: number }> = [];
            for (const mailbox of list) {
                if (mailbox.path?.startsWith('[Gmail]/Chats')) continue;
                const status = await client.status(mailbox.path, { unseen: true }).catch(() => ({ unseen: 0 }));
                items.push({
                    id: mailbox.path,
                    name: mailbox.name ?? mailbox.path,
                    unread: status?.unseen ?? 0,
                });
            }
            return items;
        });
    }

    async getEmailsByMailbox(mailboxId: string, page = 1, pageSize = 20) {
        const safePage = page > 0 ? page : 1;
        const safeSize = Math.min(Math.max(pageSize, 1), 100);
        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(mailboxId);
            try {
                const mailboxInfo = client.mailbox;
                if (!mailboxInfo) {
                    throw new NotFoundException('Mailbox not available');
                }
                const total = mailboxInfo.exists ?? 0;
                if (!total) {
                    return {
                        data: [],
                        meta: { total: 0, page: safePage, pageSize: safeSize },
                    };
                }

                const endSeq = Math.max(1, total - (safePage - 1) * safeSize);
                const startSeq = Math.max(1, endSeq - safeSize + 1);
                const range = `${startSeq}:${endSeq}`;

                const messages: EmailListItem[] = [];
                for await (const message of client.fetch(
                    { seq: range },
                    { envelope: true, flags: true, uid: true, internalDate: true },
                )) {
                    if (!message) continue;
                    const fromAddress = this.formatAddress(message.envelope?.from?.[0]);
                    const timestampSource = message.envelope?.date || message.internalDate || new Date();
                    const timestamp = new Date(timestampSource).toISOString();
                    const flags = message.flags || new Set<string>();
                    messages.unshift({
                        id: this.composeEmailId(mailboxId, message.uid),
                        mailboxId,
                        senderName: fromAddress.name,
                        senderEmail: fromAddress.email,
                        subject: message.envelope?.subject || '(No subject)',
                        preview: message.envelope?.subject || '',
                        timestamp,
                        starred: flags.has('\\Flagged'),
                        unread: !flags.has('\\Seen'),
                        important: false,
                    });
                }

                return {
                    data: messages,
                    meta: {
                        total,
                        page: safePage,
                        pageSize: safeSize,
                    },
                };
            } finally {
                lock.release();
            }
        });
    }

    async getEmailById(emailId: string): Promise<EmailDetail> {
        const { mailboxId, uid } = this.parseEmailId(emailId);

        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(mailboxId);
            try {
                const message = await client.fetchOne(
                    uid,
                    {
                        source: true,
                        envelope: true,
                        flags: true,
                        internalDate: true,
                        bodyStructure: true,
                    },
                    { uid: true },
                );
                if (!message || !message.source) {
                    throw new NotFoundException('Email not found');
                }

                const parsed = await simpleParser(message.source);
                const fromAddress = this.formatAddress(message.envelope?.from?.[0]);

                // ✅ Dùng bodyStructure để tìm attachment & luôn dùng partId
                const rawAttachments = this.extractAttachments(message.bodyStructure);
                const attachments =
                    rawAttachments.length > 0
                        ? rawAttachments.map((a) => ({
                            id: a.partId, // 👈 id trả về cho FE chính là partId
                            fileName: a.filename,
                            size: `${a.size} bytes`,
                            type: a.mimeType,
                        }))
                        : undefined;

                const timestampSource = message.envelope?.date || message.internalDate || new Date();
                const timestamp = new Date(timestampSource).toISOString();
                const flags = message.flags || new Set<string>();

                return {
                    id: this.composeEmailId(mailboxId, uid),
                    mailboxId,
                    senderName: fromAddress.name,
                    senderEmail: fromAddress.email,
                    subject: message.envelope?.subject || '(No subject)',
                    preview: parsed.subject || '',
                    timestamp,
                    starred: flags.has('\\Flagged'),
                    unread: !flags.has('\\Seen'),
                    important: false,
                    to: (parsed.to?.value || []).map((addr) => addr.address || '').filter(Boolean),
                    cc: parsed.cc?.value?.map((addr) => addr.address || '').filter(Boolean),
                    body:
                        parsed.html ||
                        parsed.textAsHtml ||
                        (parsed.text ? `<pre>${parsed.text}</pre>` : '<p>No content</p>'),
                    attachments,
                };
            } finally {
                lock.release();
            }
        });
    }

    async sendEmail(data: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] }) {
        if (!data.to?.length) throw new BadRequestException('At least one recipient is required');
        const info = await this.smtpTransport.sendMail({
            from: this.smtpTransport.options.auth?.user,
            to: data.to.join(','),
            cc: data.cc?.length ? data.cc.join(',') : undefined,
            bcc: data.bcc?.length ? data.bcc.join(',') : undefined,
            subject: data.subject,
            html: data.body,
        });
        return info.messageId;
    }

    async replyToEmail(emailId: string, body: string, replyAll = false) {
        const { mailboxId, uid } = this.parseEmailId(emailId);
        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(mailboxId);
            try {
                const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
                if (!message || !message.envelope) throw new NotFoundException('Original message not found');
                const from = message.envelope.from?.[0];
                if (!from?.address) throw new BadRequestException('Original sender missing');

                const recipients = replyAll
                    ? Array.from(
                        new Set(
                            [
                                from.address,
                                ...(message.envelope.to?.map((addr) => addr.address) ?? []),
                                ...(message.envelope.cc?.map((addr) => addr.address) ?? []),
                            ]
                                .filter(Boolean)
                                .filter((addr) => addr !== this.smtpTransport.options.auth?.user),
                        ),
                    )
                    : [from.address];

                const subject = message.envelope.subject?.startsWith('Re:')
                    ? message.envelope.subject
                    : `Re: ${message.envelope.subject ?? ''}`;

                const info = await this.smtpTransport.sendMail({
                    from: this.smtpTransport.options.auth?.user,
                    to: recipients.join(','),
                    subject,
                    html: body,
                    inReplyTo: message.envelope.messageId,
                    references: message.envelope.messageId,
                });
                return info.messageId;
            } finally {
                lock.release();
            }
        });
    }

    async modifyEmail(emailId: string, actions: ModifyActions) {
        const { mailboxId, uid } = this.parseEmailId(emailId);
        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(mailboxId);
            try {
                if (actions.markRead) {
                    await client.messageFlagsAdd({ uid }, ['\\Seen']);
                }
                if (actions.markUnread) {
                    await client.messageFlagsRemove({ uid }, ['\\Seen']);
                }
                if (actions.star) {
                    await client.messageFlagsAdd({ uid }, ['\\Flagged']);
                }
                if (actions.unstar) {
                    await client.messageFlagsRemove({ uid }, ['\\Flagged']);
                }
                if (actions.delete) {
                    await client.messageDelete({ uid });
                }
            } finally {
                lock.release();
            }
        });
    }

    async getAttachment(emailId: string, attachmentId: string) {
        const { mailboxId, uid } = this.parseEmailId(emailId);

        return this.withClient(async (client) => {
            const lock = await client.getMailboxLock(mailboxId);
            try {
                const meta = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
                if (!meta) {
                    throw new NotFoundException('Message not found');
                }

                const attachments = this.extractAttachments(meta.bodyStructure);
                const attachment = attachments.find((a) => a.partId === attachmentId);

                if (!attachment) {
                    throw new NotFoundException('Attachment not found');
                }

                const download = await client.download(uid, attachment.partId, { uid: true });

                // ✅ ĐỌC HẾT STREAM VÀO BUFFER TRƯỚC KHI LOGOUT
                const chunks: Buffer[] = [];
                for await (const chunk of download.content) {
                    chunks.push(chunk as Buffer);
                }
                const buffer = Buffer.concat(chunks);

                return {
                    data: buffer,
                    mimeType: attachment.mimeType,
                    filename: attachment.filename,
                };
            } finally {
                lock.release();
            }
        });
    }

    private extractAttachments(
        structure: any,
        list: Array<{ partId: string; filename: string; size: number; mimeType: string }> = [],
    ) {
        if (!structure) return list;

        const type = (structure.type || '').toLowerCase();
        const subtype = (structure.subtype || '').toLowerCase();
        const disposition = (structure.disposition?.type || '').toLowerCase();

        const filename =
            structure.disposition?.params?.filename ||
            structure.parameters?.name ||
            '';

        const hasFilename = !!filename;
        const contentType = `${type}/${subtype}`.toLowerCase();

        // phần có filename và không phải text/* coi như attachment
        const isAttachment =
            disposition === 'attachment' ||
            (disposition === 'inline' && hasFilename && type !== 'text') ||
            (hasFilename && type !== 'text');

        if (isAttachment) {
            list.push({
                partId: structure.part || '1',
                filename: filename || `attachment-${structure.part || Math.random().toString(36).slice(2)}`,
                size: structure.size || 0,
                mimeType: contentType || 'application/octet-stream',
            });
        }

        if (structure.childNodes?.length) {
            for (const child of structure.childNodes) {
                this.extractAttachments(child, list);
            }
        }

        return list;
    }

}

