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
import {
  EmailItem,
  EmailItemDocument,
  EmailStatus,
} from './schemas/email-item.chema';
import { KanbanColumnConfig } from '../users/schemas/user-settings.schema';
import { AiService } from 'src/ai/ai.service';
import { QdrantService } from 'src/ai/qdrant.service';
import Fuse from 'fuse.js';

@Injectable()
export class KanbanService {
  constructor(
    @InjectModel(EmailItem.name)
    private emailItemModel: Model<EmailItemDocument>,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly qdrant: QdrantService,
  ) {}

  private async getGmailClient(userId: string) {
    const { refreshToken } =
      await this.usersService.getGmailRefreshToken(userId);

    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });

    return google.gmail({ version: 'v1', auth: oAuth2Client });
  }

  /**
   * Fuzzy search email items for a user across subject, sender name/email, snippet, summary.
   * Supports typo tolerance and partial matches.
   */
  async searchItems(userId: string, q: string, limit = 50) {
    const uid = new Types.ObjectId(userId);

    // fetch candidate items with LIMIT to prevent memory issues
    // Only load recent 500 items instead of ALL emails
    const items = await this.emailItemModel
      .find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    if (!q || !q.trim()) return [];

    const fuse = new Fuse(items, {
      keys: [
        { name: 'subject', weight: 0.6 },
        { name: 'senderName', weight: 0.5 },
        { name: 'senderEmail', weight: 0.5 },
        { name: 'snippet', weight: 0.3 },
        { name: 'summary', weight: 0.2 },
      ],
      includeScore: true,
      threshold: 0.45, // Typo tolerance
      ignoreLocation: true,
      minMatchCharLength: 2, // Partial matches
      shouldSort: true, // Best matches first
    });

    const results = fuse.search(q, { limit });

    // map to items with score and return sorted by score asc (best matches first)
    return results
      .map((r) => ({ ...(r.item as any), _score: r.score ?? 0 }))
      .sort((a, b) => (a._score ?? 0) - (b._score ?? 0));
  }

  /**
   * Semantic search using vector embeddings in Qdrant
   * Finds emails by conceptual relevance, not just keyword matching
   */
  async semanticSearch(userId: string, query: string, limit = 20) {
    if (!query || !query.trim()) {
      return [];
    }

    try {
      // Generate embedding for search query
      const queryEmbedding = await this.ai.generateEmbedding(query.trim());

      // Search in Qdrant
      const results = await this.qdrant.searchSimilar(
        userId,
        queryEmbedding,
        limit,
        0.5, // Score threshold for relevance
      );

      // Enrich with MongoDB data (batch query for better performance)
      const messageIds = results.map((r) => r.messageId);
      const items = await this.emailItemModel
        .find({
          userId: new Types.ObjectId(userId),
          messageId: { $in: messageIds },
        })
        .select(
          'messageId subject senderName senderEmail snippet summary status',
        )
        .lean()
        .exec();

      // Create lookup map
      const itemMap = new Map(items.map((item) => [item.messageId, item]));

      const enriched = [];
      for (const result of results) {
        const item = itemMap.get(result.messageId);
        if (item) {
          enriched.push({
            ...item,
            _score: result.score,
            _searchType: 'semantic',
          });
        }
      }

      return enriched;
    } catch (error) {
      console.error('Semantic search error:', error);
      // Fallback to fuzzy search if semantic search fails
      return this.searchItems(userId, query, limit);
    }
  }

  /**
   * Get auto-suggestions for search based on contacts and keywords
   */
  async getSearchSuggestions(userId: string, query: string, limit = 5) {
    if (!query || query.trim().length < 2) {
      return [];
    }

    const uid = new Types.ObjectId(userId);
    const q = query.trim().toLowerCase();

    // Get unique contacts from Qdrant
    const contacts = await this.qdrant.getUniqueContacts(userId, 100);

    // Filter contacts by query
    const contactSuggestions = contacts
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q),
      )
      .slice(0, 3)
      .map((c) => ({
        type: 'contact' as const,
        text: c.name,
        value: c.email,
      }));

    // Get subject keywords from recent emails (limit fields to reduce memory)
    const recentEmails = await this.emailItemModel
      .find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('subject')
      .lean()
      .exec();

    // Extract keywords from subjects
    const keywords = new Set<string>();
    recentEmails.forEach((email) => {
      if (email.subject) {
        const words = email.subject
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3 && w.includes(q));
        words.forEach((w) => keywords.add(w));
      }
    });

    const keywordSuggestions = Array.from(keywords)
      .slice(0, 2)
      .map((k) => ({
        type: 'keyword' as const,
        text: k,
        value: k,
      }));

    return [...contactSuggestions, ...keywordSuggestions].slice(0, limit);
  }

  /**
   * Generate and store embedding for an email item
   */
  async generateAndStoreEmbedding(userId: string, messageId: string) {
    const uid = new Types.ObjectId(userId);
    const item = await this.emailItemModel.findOne({ userId: uid, messageId });

    if (!item) {
      throw new NotFoundException('Email item not found');
    }

    // Generate embedding
    const embedding = await this.ai.generateEmailEmbedding({
      subject: item.subject,
      fromEmail: item.senderEmail,
      fromName: item.senderName,
      snippet: item.snippet,
      summary: item.summary,
    });

    // Store in Qdrant
    await this.qdrant.upsertEmbedding(messageId, userId, embedding, {
      subject: item.subject,
      senderName: item.senderName,
      senderEmail: item.senderEmail,
      snippet: item.snippet,
      summary: item.summary,
      createdAt: (item as any).createdAt,
    });

    // Update MongoDB
    item.hasEmbedding = true;
    item.embeddingGeneratedAt = new Date();
    await item.save();

    return { success: true };
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
    const h = headers?.find(
      (x) => (x.name || '').toLowerCase() === name.toLowerCase(),
    );
    return h?.value ?? '';
  }

  private parseAddress(raw: string) {
    const match = raw.match(/(.*)<(.+@.+)>/);
    if (match) {
      return {
        name: match[1].trim().replace(/^"|"$/g, ''),
        email: match[2].trim(),
      };
    }
    return { name: raw || 'Unknown', email: raw };
  }

  /**
   * Đồng bộ tối thiểu: lấy list Gmail messages theo label,
   * upsert vào email_items để phục vụ Kanban.
   * Always detects attachments for filtering support.
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

      const detail = await gmail.users.messages
        .get({
          userId: 'me',
          id: m.id,
          format: 'full',
        })
        .catch(() => null);

      if (!detail) continue;

      const headers = detail.data.payload?.headers ?? [];
      const fromRaw = this.getHeader(headers, 'From');
      const subject = this.getHeader(headers, 'Subject') || '(No subject)';
      const from = this.parseAddress(fromRaw);

      // Detect attachments if requested (walk payload)
      let hasAttachments = false;
      try {
        const walk = (node: any): boolean => {
          if (!node) return false;
          if (node.filename) return true;
          if (node.body && node.body.attachmentId) return true;
          if (node.parts && Array.isArray(node.parts)) {
            return node.parts.some((p: any) => walk(p));
          }
          return false;
        };

        hasAttachments = walk(detail.data.payload);
      } catch (e) {
        hasAttachments = false;
      }

      const result = await this.emailItemModel.updateOne(
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
            hasAttachments,
          },
        },
        { upsert: true },
      );

      // Generate embedding for new emails (in background, don't await)
      // Skip embedding generation during initial sync to reduce memory
      if (result.upsertedCount > 0 && process.env.NODE_ENV !== 'production') {
        this.generateAndStoreEmbedding(userId, m.id).catch((err) =>
          console.error('Failed to generate embedding for', m.id, err),
        );
      }
    }

    return { synced: msgs.length };
  }

  async getBoard(
    userId: string,
    labelId?: string,
    pageToken?: string,
    pageSize: number = 20,
  ) {
    // Optional sync khi mở board lần đầu
    if (labelId) {
      await this.syncLabelToItems(userId, labelId, 10);
    } else {
      await this.syncLabelToItems(userId, 'INBOX', 10);
    }

    const uid = new Types.ObjectId(userId);

    // Get user's column configuration
    const columns = await this.getKanbanColumns(userId);
    const statuses = columns.map((col) => col.id);

    // Decode pageToken to get skip offset for each column
    let skipMap: Record<string, number> = {};
    statuses.forEach((status) => {
      skipMap[status] = 0;
    });

    if (pageToken) {
      try {
        skipMap = JSON.parse(
          Buffer.from(pageToken, 'base64').toString('utf-8'),
        );
      } catch {
        // Invalid token, start from beginning
      }
    }

    // Get total counts for each status
    const totals = await Promise.all(
      statuses.map(async (status) => ({
        status,
        count: await this.emailItemModel.countDocuments({
          userId: uid,
          status,
        }),
      })),
    );

    const totalMap = totals.reduce(
      (acc, { status, count }) => ({ ...acc, [status]: count }),
      {} as Record<string, number>,
    );

    // Fetch paginated items for each column
    const columnData = await Promise.all(
      statuses.map(async (status) => {
        const items = await this.emailItemModel
          .find({ userId: uid, status })
          .sort({ updatedAt: -1 })
          .skip(skipMap[status] || 0)
          .limit(pageSize)
          .lean();

        return { status, items };
      }),
    );

    const data = columnData.reduce(
      (acc, { status, items }) => ({ ...acc, [status]: items }),
      {} as Record<string, any[]>,
    );

    // Check if there are more items for any column
    const hasMore = statuses.some(
      (status) => (skipMap[status] || 0) + pageSize < totalMap[status],
    );

    // Generate next page token
    let nextPageToken: string | null = null;
    if (hasMore) {
      const nextSkipMap = statuses.reduce(
        (acc, status) => ({
          ...acc,
          [status]: (skipMap[status] || 0) + pageSize,
        }),
        {} as Record<string, number>,
      );
      nextPageToken = Buffer.from(JSON.stringify(nextSkipMap)).toString(
        'base64',
      );
    }

    return {
      data,
      meta: {
        pageSize,
        nextPageToken,
        hasMore,
        total: totalMap,
      },
      columns, // Include column configuration in response
    };
  }

  async updateStatus(
    userId: string,
    messageId: string,
    status: EmailStatus,
    gmailLabel?: string,
  ) {
    const uid = new Types.ObjectId(userId);

    const updated = await this.emailItemModel.findOneAndUpdate(
      { userId: uid, messageId },
      { $set: { status }, $unset: { snoozeUntil: 1, originalStatus: 1 } },
      { new: true },
    );

    if (!updated) throw new NotFoundException('Email item not found');

    // Sync with Gmail labels if gmailLabel is provided
    if (gmailLabel) {
      try {
        const gmail = await this.getGmailClient(userId);

        // Add the new label to the message
        await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: [gmailLabel],
          },
        });

        console.log(
          `[Gmail Sync] Added label ${gmailLabel} to message ${messageId}`,
        );
      } catch (error) {
        console.error(`[Gmail Sync] Failed to add label:`, error);
        // Don't fail the whole operation if Gmail sync fails
      }
    }

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

    const original =
      item.status === EmailStatus.SNOOZED ? item.originalStatus : item.status;

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

    // Generate embedding after summary (in background)
    this.generateAndStoreEmbedding(userId, messageId).catch((err) =>
      console.error('Failed to generate embedding after summary', err),
    );

    return { summary: s.summary, cached: false };
  }

  /**
   * Cron sẽ gọi hàm này
   */
  async wakeExpiredSnoozed() {
    const now = new Date();

    // Limit to 100 items per run to prevent memory issues
    const items = await this.emailItemModel
      .find({
        status: EmailStatus.SNOOZED,
        snoozeUntil: { $lte: now },
      })
      .limit(100)
      .select('_id originalStatus')
      .lean()
      .exec();

    if (items.length === 0) {
      return { woke: 0 };
    }

    // Bulk update for better performance
    const bulkOps = items.map((it) => ({
      updateOne: {
        filter: { _id: it._id },
        update: {
          $set: { status: (it as any).originalStatus ?? EmailStatus.INBOX },
          $unset: { snoozeUntil: 1, originalStatus: 1 },
        },
      },
    }));

    await this.emailItemModel.bulkWrite(bulkOps);

    return { woke: items.length };
  }

  async getKanbanColumns(userId: string): Promise<KanbanColumnConfig[]> {
    return this.usersService.getKanbanColumns(userId);
  }

  async updateKanbanColumns(
    userId: string,
    columns: KanbanColumnConfig[],
  ): Promise<KanbanColumnConfig[]> {
    return this.usersService.updateKanbanColumns(userId, columns);
  }
}
