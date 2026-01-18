import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { UsersService } from '../users/users.service';

// File upload interface (compatible with Multer)
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface EmailListItem {
  id: string; // format: labelId|messageId
  mailboxId: string; // labelId
  senderName: string;
  senderEmail: string;
  subject: string;
  preview: string;
  timestamp: string;
  starred: boolean;
  unread: boolean;
  important: boolean;
}

export interface EmailDetail extends EmailListItem {
  to: string[];
  cc?: string[];
  body: string;
  attachments?: {
    id: string; // gmail attachmentId
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
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  private composeEmailId(mailboxId: string, messageId: string) {
    return `${encodeURIComponent(mailboxId)}|${messageId}`;
  }

  private parseEmailId(emailId: string) {
    // ✅ allow raw gmail message id
    if (!emailId.includes('|')) {
      return { mailboxId: 'INBOX', messageId: emailId };
    }

    const [encodedMailbox, messageId] = emailId.split('|');
    const mailboxId = decodeURIComponent(encodedMailbox ?? '');

    if (!mailboxId || !messageId) {
      throw new BadRequestException('Invalid email id');
    }

    return { mailboxId, messageId };
  }

  private async getGmailClient(userId: string) {
    const { refreshToken } =
      await this.usersService.getGmailRefreshToken(userId);

    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });

    return google.gmail({ version: 'v1', auth: oAuth2Client });
  }

  private getHeader(headers: any[] | undefined, name: string) {
    const h = headers?.find(
      (x) => (x.name || '').toLowerCase() === name.toLowerCase(),
    );
    return h?.value ?? '';
  }

  private parseAddress(raw: string) {
    // format đơn giản: "Name <email>" hoặc "email"
    const match = raw.match(/(.*)<(.+@.+)>/);
    if (match) {
      return {
        name: match[1].trim().replace(/^"|"$/g, ''),
        email: match[2].trim(),
      };
    }
    return { name: raw || 'Unknown', email: raw };
  }

  private base64UrlDecode(input: string) {
    const pad = '='.repeat((4 - (input.length % 4)) % 4);
    const base64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf8');
  }

  private base64UrlToBase64(input: string) {
    const pad = '='.repeat((4 - (input.length % 4)) % 4);
    return (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  }

  private escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private findFirstPartByMime(payload: any, mimeType: string): any | null {
    if (!payload) return null;
    if ((payload.mimeType || '').toLowerCase() === mimeType.toLowerCase()) {
      return payload;
    }
    if (payload.parts?.length) {
      for (const p of payload.parts) {
        const found = this.findFirstPartByMime(p, mimeType);
        if (found) return found;
      }
    }
    return null;
  }

  private async getPartDataBase64Url(
    gmail: any,
    messageId: string,
    part: any,
  ): Promise<string | undefined> {
    if (!part) return undefined;
    const direct = part.body?.data;
    if (direct) return direct;

    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) return undefined;

    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    return attachment?.data?.data ?? undefined;
  }

  private async extractBodyHtml(
    gmail: any,
    messageId: string,
    payload: any,
  ): Promise<string> {
    if (!payload) return '<p>No content</p>';

    const htmlPart = this.findFirstPartByMime(payload, 'text/html');
    if (htmlPart) {
      const data = await this.getPartDataBase64Url(gmail, messageId, htmlPart);
      if (data) return this.base64UrlDecode(data);
    }

    const textPart = this.findFirstPartByMime(payload, 'text/plain');
    if (textPart) {
      const data = await this.getPartDataBase64Url(gmail, messageId, textPart);
      if (data) {
        const text = this.base64UrlDecode(data);
        return `<pre style="white-space:pre-wrap">${this.escapeHtml(text)}</pre>`;
      }
    }

    return '<p>No content</p>';
  }

  /**
   * Extract inline images (images with Content-ID for cid: references)
   */
  private async extractInlineImages(
    gmail: any,
    messageId: string,
    payload: any,
  ): Promise<Map<string, { data: string; mimeType: string }>> {
    const inlineImages = new Map<string, { data: string; mimeType: string }>();

    const walk = async (node: any) => {
      if (!node) return;

      const headers = node.headers || [];
      const contentIdHeader = headers.find(
        (h: any) => h.name?.toLowerCase() === 'content-id',
      );
      const contentLocationHeader = headers.find(
        (h: any) => h.name?.toLowerCase() === 'content-location',
      );
      const dispositionHeader = headers.find(
        (h: any) => h.name?.toLowerCase() === 'content-disposition',
      );

      const isInline = dispositionHeader?.value
        ?.toLowerCase()
        ?.includes('inline');
      const isImage = (node.mimeType || '').toLowerCase().startsWith('image/');

      if (isImage && (contentIdHeader || contentLocationHeader || isInline)) {
        const data = await this.getPartDataBase64Url(gmail, messageId, node);
        if (data) {
          const keys: string[] = [];
          if (contentIdHeader?.value) {
            keys.push(contentIdHeader.value.replace(/^<|>$/g, '').trim());
          }
          if (contentLocationHeader?.value) {
            keys.push(contentLocationHeader.value.trim());
          }
          if (node.filename) {
            keys.push(node.filename);
          }

          for (const key of keys) {
            if (!key) continue;
            inlineImages.set(key, {
              data,
              mimeType: node.mimeType || 'image/jpeg',
            });
          }
        }
      }

      if (node.parts?.length) {
        for (const p of node.parts) {
          await walk(p);
        }
      }
    };

    await walk(payload);
    return inlineImages;
  }

  /**
   * Replace cid: references in HTML with base64 data URIs
   */
  private replaceInlineImages(
    html: string,
    inlineImages: Map<string, { data: string; mimeType: string }>,
  ): string {
    let result = html;

    // Replace all cid: references
    inlineImages.forEach((imageData, contentId) => {
      const base64 = this.base64UrlToBase64(imageData.data);
      const dataUri = `data:${imageData.mimeType};base64,${base64}`;

      const escaped = contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Replace cid: references (with/without angle brackets)
      const cidPattern = new RegExp(`cid:(?:<)?${escaped}(?:>)?`, 'gi');
      result = result.replace(cidPattern, dataUri);

      // Some HTML uses the Content-Location directly
      const srcPattern = new RegExp(`src=["']${escaped}["']`, 'gi');
      result = result.replace(srcPattern, `src="${dataUri}"`);
    });

    return result;
  }

  private extractAttachments(payload: any) {
    const result: Array<{
      id: string;
      fileName: string;
      size: string;
      type: string;
    }> = [];

    const walk = (node: any) => {
      if (!node) return;

      const filename = node.filename;
      const body = node.body;
      const headers = node.headers || [];

      // Check Content-Disposition to filter out inline images
      const dispositionHeader = headers.find(
        (h: any) => h.name?.toLowerCase() === 'content-disposition',
      );
      const isInline = dispositionHeader?.value?.includes('inline');

      // Only include as attachment if it has attachmentId and is NOT inline
      // (inline images should be embedded in the body, not listed as attachments)
      if (filename && body?.attachmentId && !isInline) {
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
  // Gmail-style labels matching real Gmail sidebar:
  // Inbox (primary only), Starred, Snoozed, Sent, Drafts, Purchases, Important, Scheduled, All Mail, Spam, Trash
  // Then Social, Promotions, Updates as separate categories
  async getMailboxes(userId: string) {
    const gmail = await this.getGmailClient(userId);
    const res = await gmail.users.labels.list({ userId: 'me' });

    const labels = res.data.labels ?? [];

    // Labels to show in Gmail-style sidebar (matching real Gmail)
    // INBOX will only show Primary emails (using CATEGORY_PRIMARY filter when fetching)
    const gmailSidebarLabels = [
      'INBOX', // Primary emails only
      'STARRED',
      'SNOOZED', // Virtual - will be added separately
      'SENT',
      'DRAFT',
      'CATEGORY_PURCHASES', // Purchases
      'IMPORTANT',
      'CATEGORY_SCHEDULED', // Scheduled
      'ALL_MAIL', // Virtual - All Mail
      'SPAM',
      'TRASH',
      // Categories as separate labels
      'CATEGORY_SOCIAL',
      'CATEGORY_PROMOTIONS',
      'CATEGORY_UPDATES',
    ];

    // Build items with unread counts
    const items: Array<{ id: string; name: string; unread?: number }> = [];

    for (const labelId of gmailSidebarLabels) {
      // Skip virtual labels - will add them separately
      if (['SNOOZED', 'ALL_MAIL', 'CATEGORY_SCHEDULED'].includes(labelId))
        continue;

      const lb = labels.find((l) => l.id === labelId);
      if (!lb) continue;

      // Get unread count
      const detail = await gmail.users.labels
        .get({ userId: 'me', id: labelId })
        .catch((err) => {
          this.logger.warn(
            `Failed to get label details for ${labelId}: ${err.message}`,
          );
          return null;
        });

      // For INBOX, get count from primary emails only using query
      let unread = detail?.data?.messagesUnread ?? 0;
      if (labelId === 'INBOX') {
        try {
          const primaryList = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:inbox category:primary is:unread',
            maxResults: 100,
          });
          unread = primaryList.data.messages?.length ?? 0;
        } catch {
          // Fallback to INBOX unread count
        }
      }

      items.push({
        id: labelId,
        name: lb.name ?? labelId,
        unread,
      });
    }

    // Add SNOOZED as virtual mailbox
    try {
      const snoozedList = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:snoozed',
        maxResults: 100,
      });
      const snoozedCount = snoozedList.data.messages?.length ?? 0;

      // Insert after STARRED (index 1)
      const starredIdx = items.findIndex((i) => i.id === 'STARRED');
      items.splice(starredIdx + 1, 0, {
        id: 'SNOOZED',
        name: 'Snoozed',
        unread: snoozedCount,
      });
    } catch (err) {
      this.logger.warn('Failed to check snoozed emails', err);
    }

    // Add SCHEDULED as virtual mailbox (emails scheduled to send)
    try {
      const scheduledList = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:scheduled',
        maxResults: 100,
      });
      const scheduledCount = scheduledList.data.messages?.length ?? 0;

      // Insert after Important
      const importantIdx = items.findIndex((i) => i.id === 'IMPORTANT');
      if (importantIdx !== -1) {
        items.splice(importantIdx + 1, 0, {
          id: 'SCHEDULED',
          name: 'Scheduled',
          unread: scheduledCount,
        });
      }
    } catch (err) {
      this.logger.warn('Failed to check scheduled emails', err);
    }

    // Add ALL_MAIL as virtual mailbox
    try {
      // Get total unread from All Mail
      const allMailLabel = await gmail.users.labels
        .get({ userId: 'me', id: 'INBOX' })
        .catch(() => null);

      // Insert before SPAM
      const spamIdx = items.findIndex((i) => i.id === 'SPAM');
      if (spamIdx !== -1) {
        items.splice(spamIdx, 0, {
          id: 'ALL_MAIL',
          name: 'All Mail',
          unread: 0, // All Mail typically doesn't show unread count
        });
      }
    } catch (err) {
      this.logger.warn('Failed to add All Mail', err);
    }

    // Add user-created labels at the end
    const userLabels = labels.filter(
      (lb) =>
        lb.id &&
        lb.type === 'user' &&
        !gmailSidebarLabels.includes(lb.id) &&
        !lb.id.startsWith('CATEGORY_'),
    );

    for (const lb of userLabels) {
      if (!lb.id) continue;
      const detail = await gmail.users.labels
        .get({ userId: 'me', id: lb.id })
        .catch(() => null);

      items.push({
        id: lb.id,
        name: lb.name ?? lb.id,
        unread: detail?.data?.messagesUnread ?? 0,
      });
    }

    return items;
  }

  // ✅ Method mới: Dùng trực tiếp pageToken cho infinite scroll
  async getEmailsByMailboxWithToken(
    userId: string,
    mailboxId: string,
    pageToken: string | undefined,
    pageSize = 20,
  ) {
    const gmail = await this.getGmailClient(userId);
    const safeSize = Math.min(Math.max(pageSize, 1), 50);

    // Virtual mailboxes and special handling
    const isSnoozed = mailboxId === 'SNOOZED';
    const isScheduled = mailboxId === 'SCHEDULED';
    const isAllMail = mailboxId === 'ALL_MAIL';
    // INBOX should only show Primary emails (exclude promotions, social, updates)
    const isInbox = mailboxId === 'INBOX';

    // Build list params based on mailbox type
    let listParams: { q?: string; labelIds?: string[] } = {};
    if (isSnoozed) {
      listParams = { q: 'is:snoozed' };
    } else if (isScheduled) {
      listParams = { q: 'is:scheduled' };
    } else if (isAllMail) {
      listParams = { q: 'in:all' };
    } else if (isInbox) {
      // INBOX: Only Primary emails using Gmail query
      listParams = { q: 'in:inbox category:primary' };
    } else {
      listParams = { labelIds: [mailboxId] };
    }

    const list = await gmail.users.messages.list({
      userId: 'me',
      ...listParams,
      maxResults: safeSize,
      pageToken: pageToken || undefined,
    });

    const msgs = list.data.messages ?? [];
    const data: EmailListItem[] = [];

    // Process message details in small parallel batches to limit concurrent memory
    const batchSize = 5;
    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((m) =>
          m.id
            ? gmail.users.messages
                .get({
                  userId: 'me',
                  id: m.id,
                  format: 'metadata',
                  metadataHeaders: ['From', 'Subject', 'Date'],
                })
                .catch(() => null)
            : Promise.resolve(null),
        ),
      );

      for (let j = 0; j < batch.length; j++) {
        const m = batch[j];
        const detail = details[j];
        if (!m.id || !detail) continue;

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
          timestamp: dateRaw
            ? new Date(dateRaw).toISOString()
            : new Date().toISOString(),
          starred: labelIds.includes('STARRED'),
          unread: labelIds.includes('UNREAD'),
          important: labelIds.includes('IMPORTANT'),
        });
      }
    }

    return {
      data,
      meta: {
        pageSize: safeSize,
        nextPageToken: list.data.nextPageToken ?? null,
        hasMore: !!list.data.nextPageToken,
      },
    };
  }

  /**
   * Search emails globally across all labels using Gmail's q parameter
   * This method does NOT filter by labelIds, enabling true global search
   */
  async searchEmails(
    userId: string,
    query: string,
    pageToken: string | undefined,
    pageSize = 20,
  ) {
    const gmail = await this.getGmailClient(userId);
    const safeSize = Math.min(Math.max(pageSize, 1), 50);

    // Use only the q parameter for global search - no labelIds restriction
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: safeSize,
      pageToken: pageToken || undefined,
    });

    const msgs = list.data.messages ?? [];
    const data: EmailListItem[] = [];

    // Process message details in small parallel batches to limit concurrent memory
    const batchSize = 5;
    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((m) =>
          m.id
            ? gmail.users.messages
                .get({
                  userId: 'me',
                  id: m.id,
                  format: 'metadata',
                  metadataHeaders: ['From', 'Subject', 'Date'],
                })
                .catch(() => null)
            : Promise.resolve(null),
        ),
      );

      for (let j = 0; j < batch.length; j++) {
        const m = batch[j];
        const detail = details[j];
        if (!m.id || !detail) continue;

        const headers = detail.data.payload?.headers ?? [];
        const fromRaw = this.getHeader(headers, 'From');
        const subject = this.getHeader(headers, 'Subject') || '(No subject)';
        const dateRaw = this.getHeader(headers, 'Date');

        const from = this.parseAddress(fromRaw);
        const labelIds = detail.data.labelIds ?? [];

        // For search results, use SEARCH as the mailbox identifier
        data.push({
          id: this.composeEmailId('SEARCH', m.id),
          mailboxId: 'SEARCH',
          senderName: from.name,
          senderEmail: from.email,
          subject,
          preview: subject,
          timestamp: dateRaw
            ? new Date(dateRaw).toISOString()
            : new Date().toISOString(),
          starred: labelIds.includes('STARRED'),
          unread: labelIds.includes('UNREAD'),
          important: labelIds.includes('IMPORTANT'),
        });
      }
    }

    return {
      data,
      meta: {
        pageSize: safeSize,
        nextPageToken: list.data.nextPageToken ?? null,
        hasMore: !!list.data.nextPageToken,
      },
    };
  }

  // ✅ Page number không phải native của Gmail API
  // Mình implement tối thiểu để giữ contract FE (backward compatibility):
  async getEmailsByMailbox(
    userId: string,
    mailboxId: string,
    page = 1,
    pageSize = 20,
  ) {
    const gmail = await this.getGmailClient(userId);
    const safePage = Math.min(Math.max(page, 1), 5); // cap to 5 pages to avoid deep traversal
    const safeSize = Math.min(Math.max(pageSize, 1), 50);

    // Virtual mailboxes and special handling
    const isSnoozed = mailboxId === 'SNOOZED';
    const isScheduled = mailboxId === 'SCHEDULED';
    const isAllMail = mailboxId === 'ALL_MAIL';
    // INBOX should only show Primary emails (exclude promotions, social, updates)
    const isInbox = mailboxId === 'INBOX';

    // Build list params based on mailbox type
    let listParams: { q?: string; labelIds?: string[] } = {};
    if (isSnoozed) {
      listParams = { q: 'is:snoozed' };
    } else if (isScheduled) {
      listParams = { q: 'is:scheduled' };
    } else if (isAllMail) {
      listParams = { q: 'in:all' };
    } else if (isInbox) {
      // INBOX: Only Primary emails using Gmail query
      listParams = { q: 'in:inbox category:primary' };
    } else {
      listParams = { labelIds: [mailboxId] };
    }

    // traverse pageToken sequentially but cap at safePage to avoid large memory
    let pageToken: string | undefined = undefined;
    for (let i = 1; i < safePage; i++) {
      const step = await gmail.users.messages
        .list({
          userId: 'me',
          ...listParams,
          maxResults: safeSize,
          pageToken,
        })
        .catch(() => null);
      pageToken = step?.data?.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    const list = await gmail.users.messages.list({
      userId: 'me',
      ...listParams,
      maxResults: safeSize,
      pageToken,
    });

    const msgs = list.data.messages ?? [];

    const data: EmailListItem[] = [];

    // Process details in small batches to limit memory
    const batchSize = 5;
    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((m) =>
          m.id
            ? gmail.users.messages
                .get({
                  userId: 'me',
                  id: m.id,
                  format: 'metadata',
                  metadataHeaders: ['From', 'Subject', 'Date'],
                })
                .catch(() => null)
            : Promise.resolve(null),
        ),
      );

      for (let j = 0; j < batch.length; j++) {
        const m = batch[j];
        const detail = details[j];
        if (!m.id || !detail) continue;

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
          timestamp: dateRaw
            ? new Date(dateRaw).toISOString()
            : new Date().toISOString(),
          starred: labelIds.includes('STARRED'),
          unread: labelIds.includes('UNREAD'),
          important: labelIds.includes('IMPORTANT'),
        });
      }
    }

    return {
      data,
      meta: {
        total: undefined, // Gmail API doesn't return total per label
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

    // Extract body HTML (prefer text/html, fallback to text/plain)
    let body = await this.extractBodyHtml(gmail, messageId, msg.data.payload);

    // Extract inline images (cid/content-location/inline)
    const inlineImages = await this.extractInlineImages(
      gmail,
      messageId,
      msg.data.payload,
    );

    if (inlineImages.size > 0) {
      body = this.replaceInlineImages(body, inlineImages);
    }

    const attachments = this.extractAttachments(msg.data.payload);

    const to = toRaw
      ? toRaw
          .split(',')
          .map((s) => this.parseAddress(s.trim()).email)
          .filter(Boolean)
      : [];

    const cc = ccRaw
      ? ccRaw
          .split(',')
          .map((s) => this.parseAddress(s.trim()).email)
          .filter(Boolean)
      : undefined;

    return {
      id: this.composeEmailId(mailboxId, messageId),
      mailboxId,
      senderName: from.name,
      senderEmail: from.email,
      subject,
      preview: subject,
      timestamp: dateRaw
        ? new Date(dateRaw).toISOString()
        : new Date().toISOString(),
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

  private buildRawEmail(
    from: string,
    to: string[],
    subject: string,
    html: string,
    extraHeaders?: Record<string, string>,
    attachments?: UploadedFile[],
  ) {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const headers: string[] = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
    ];

    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers.splice(3, 0, `${k}: ${v}`); // chèn trước MIME lines
      }
    }

    // If no attachments, use simple text/html
    if (!attachments || attachments.length === 0) {
      headers.push('Content-Type: text/html; charset="UTF-8"');
      const message = `${headers.join('\r\n')}\r\n\r\n${html}`;
      return Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    // With attachments, use multipart/mixed
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts: string[] = [];

    // HTML body part
    parts.push(
      `--${boundary}\r\n` +
        'Content-Type: text/html; charset="UTF-8"\r\n' +
        'Content-Transfer-Encoding: 7bit\r\n\r\n' +
        html,
    );

    // Attachment parts
    for (const file of attachments) {
      const base64Content = file.buffer.toString('base64');
      const mimeType = file.mimetype || 'application/octet-stream';
      const filename = file.originalname || 'attachment';

      parts.push(
        `--${boundary}\r\n` +
          `Content-Type: ${mimeType}; name="${filename}"\r\n` +
          'Content-Transfer-Encoding: base64\r\n' +
          `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
          base64Content,
      );
    }

    // Close boundary
    parts.push(`--${boundary}--`);

    const message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
    return Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private buildForwardedHtml(original: EmailDetail) {
    const date = original.timestamp
      ? new Date(original.timestamp).toISOString()
      : new Date().toISOString();

    const toLine = original.to?.length ? original.to.join(', ') : '';
    const ccLine = original.cc?.length ? original.cc.join(', ') : '';

    const headerLines = [
      '<p>---------- Forwarded message ---------</p>',
      `<p><b>From:</b> ${original.senderName} &lt;${original.senderEmail}&gt;</p>`,
      `<p><b>Date:</b> ${date}</p>`,
      `<p><b>Subject:</b> ${original.subject}</p>`,
      toLine ? `<p><b>To:</b> ${toLine}</p>` : '',
      ccLine ? `<p><b>Cc:</b> ${ccLine}</p>` : '',
    ]
      .filter(Boolean)
      .join('');

    return `${headerLines}<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original.body}</blockquote>`;
  }

  async sendEmail(
    userId: string,
    data: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
    },
    attachments?: UploadedFile[],
  ) {
    if (!data.to?.length)
      throw new BadRequestException('At least one recipient is required');

    const gmail = await this.getGmailClient(userId);
    const user = await this.usersService.findById(userId);

    const extraHeaders: Record<string, string> = {};
    if (data.cc?.length) extraHeaders['Cc'] = data.cc.join(', ');
    if (data.bcc?.length) extraHeaders['Bcc'] = data.bcc.join(', ');

    const raw = this.buildRawEmail(
      user.email,
      data.to,
      data.subject,
      data.body,
      Object.keys(extraHeaders).length ? extraHeaders : undefined,
      attachments,
    );

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return res.data.id;
  }

  async forwardEmail(
    userId: string,
    emailId: string,
    data: {
      to: string[];
      subject?: string;
      body?: string;
      cc?: string[];
      bcc?: string[];
    },
  ) {
    if (!data.to?.length)
      throw new BadRequestException('At least one recipient is required');

    const gmail = await this.getGmailClient(userId);
    const user = await this.usersService.findById(userId);

    const original = await this.getEmailById(userId, emailId);

    const baseSubject = original.subject || '(No subject)';
    const defaultSubject = baseSubject.startsWith('Fwd:')
      ? baseSubject
      : `Fwd: ${baseSubject}`;
    const subject = (data.subject || '').trim() || defaultSubject;

    const note = (data.body || '').trim();
    const forwarded = this.buildForwardedHtml(original);
    const html = note ? `${note}<br/><br/>${forwarded}` : forwarded;

    const extraHeaders: Record<string, string> = {};
    if (data.cc?.length) extraHeaders['Cc'] = data.cc.join(', ');
    if (data.bcc?.length) extraHeaders['Bcc'] = data.bcc.join(', ');

    const raw = this.buildRawEmail(
      user.email,
      data.to,
      subject,
      html,
      Object.keys(extraHeaders).length ? extraHeaders : undefined,
    );

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return res.data.id;
  }

  async replyToEmail(
    userId: string,
    emailId: string,
    body: string,
    replyAll = false,
  ) {
    const { messageId } = this.parseEmailId(emailId);
    const gmail = await this.getGmailClient(userId);
    const user = await this.usersService.findById(userId);

    const original = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: [
        'From',
        'To',
        'Cc',
        'Subject',
        'Message-ID',
        'References',
      ],
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

      recipients = Array.from(new Set(all)).filter(
        (e) => e && e !== user.email,
      );
    } else {
      recipients = from.email ? [from.email] : [];
    }

    if (!recipients.length)
      throw new BadRequestException('No recipients for reply');

    const subject = subjectRaw.startsWith('Re:')
      ? subjectRaw
      : `Re: ${subjectRaw}`;

    const extraHeaders: Record<string, string> = {};
    if (messageIdHeader) extraHeaders['In-Reply-To'] = messageIdHeader;
    if (referencesHeader) extraHeaders['References'] = referencesHeader;
    else if (messageIdHeader) extraHeaders['References'] = messageIdHeader;

    const raw = this.buildRawEmail(
      user.email,
      recipients,
      subject,
      body,
      extraHeaders,
    );

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

    // Get message to find attachment metadata (filename, mimeType)
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    // Find attachment metadata in message parts
    let filename = `attachment-${attachmentId}`;
    let mimeType = 'application/octet-stream';

    const findAttachmentMeta = (payload: any): void => {
      if (!payload) return;
      if (payload.body?.attachmentId === attachmentId) {
        filename = payload.filename || filename;
        mimeType = payload.mimeType || mimeType;
        return;
      }
      if (payload.parts?.length) {
        for (const part of payload.parts) {
          findAttachmentMeta(part);
        }
      }
    };
    findAttachmentMeta(msg.data.payload);

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

    return {
      data: buffer,
      mimeType,
      filename,
    };
  }
}
