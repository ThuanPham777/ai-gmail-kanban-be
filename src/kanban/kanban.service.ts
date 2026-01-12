import {
  BadRequestException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
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
  private readonly logger = new Logger(KanbanService.name);

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
   * Fetch all available Gmail labels for autocomplete
   * Returns both system and user-created labels
   */
  async getAvailableGmailLabels(userId: string) {
    try {
      const gmail = await this.getGmailClient(userId);
      const response = await gmail.users.labels.list({ userId: 'me' });
      const labels = (response.data.labels ?? []) as Array<{
        id?: string;
        name?: string;
        type?: string;
      }>;

      const processedLabels = labels
        .filter((l) => l.id && l.name)
        .map((l) => ({
          id: l.id!,
          name: l.name!,
          type: l.type || 'user',
        }));

      // Ensure all common system labels are included (Gmail API might not return all)
      const systemLabels = [
        'INBOX',
        'STARRED',
        'IMPORTANT',
        'SENT',
        'DRAFT',
        'TRASH',
        'SPAM',
        'UNREAD',
      ];

      const existingLabelNames = new Set(
        processedLabels.map((l) => l.name.toUpperCase()),
      );

      // Add missing system labels
      for (const sysLabel of systemLabels) {
        if (!existingLabelNames.has(sysLabel)) {
          processedLabels.push({
            id: sysLabel,
            name: sysLabel,
            type: 'system',
          });
        }
      }

      // Add SNOOZED as virtual label (not a real Gmail label, uses q: 'is:snoozed')
      // This allows users to configure a column that shows snoozed emails
      processedLabels.push({
        id: 'SNOOZED',
        name: 'SNOOZED',
        type: 'virtual', // Mark as virtual to distinguish from real labels
      });

      return processedLabels.sort((a, b) => {
        // System labels first, then alphabetically
        if (a.type === 'system' && b.type !== 'system') return -1;
        if (a.type !== 'system' && b.type === 'system') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      console.error('[Gmail Labels] Failed to fetch labels:', error);
      throw new InternalServerErrorException('Failed to fetch Gmail labels');
    }
  }

  /**
   * Validate if a Gmail label exists
   * Returns { valid: boolean, suggestion?: string }
   */
  async validateGmailLabel(userId: string, labelName: string) {
    if (!labelName.trim()) {
      return {
        valid: true,
        message: 'Empty label (Archive column - removes INBOX)',
      };
    }

    try {
      const labels = await this.getAvailableGmailLabels(userId);
      const labelMap = new Map(labels.map((l) => [l.name.toLowerCase(), l]));

      const systemLabelIds = new Set([
        'INBOX',
        'STARRED',
        'IMPORTANT',
        'SENT',
        'DRAFT',
        'TRASH',
        'SPAM',
        'UNREAD',
      ]);

      // Virtual labels that use query instead of labelId
      const virtualLabels = new Set(['SNOOZED']);

      const trimmed = labelName.trim();

      // Check if it's a system label
      if (systemLabelIds.has(trimmed)) {
        return { valid: true, message: `System label: ${trimmed}` };
      }

      // Check if it's a virtual label (e.g., SNOOZED)
      if (virtualLabels.has(trimmed)) {
        return {
          valid: true,
          message: `Virtual label: ${trimmed} (uses Gmail search query)`,
        };
      }

      // Check if label exists (case-insensitive)
      const found = labelMap.get(trimmed.toLowerCase());
      if (found) {
        return {
          valid: true,
          message: `Label exists: ${found.name}`,
          actualName: found.name,
        };
      }

      // Label doesn't exist - find similar labels for suggestions
      const similar = labels
        .filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase()))
        .slice(0, 3);

      return {
        valid: false,
        message: `Label "${trimmed}" not found in Gmail`,
        suggestions: similar.length ? similar.map((l) => l.name) : undefined,
        hint: 'The label will be used as-is. Create it in Gmail first for best results.',
      };
    } catch (error) {
      console.error('[Gmail Label Validation] Error:', error);
      return {
        valid: false,
        message: 'Failed to validate label',
        hint: 'The label will be used as-is.',
      };
    }
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
      .map((r) => ({
        ...(r.item as any),
        hasAttachments: (r.item as any).hasAttachments ?? false,
        _score: r.score ?? 0,
      }))
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

      // Search in Qdrant with better threshold
      // Cosine similarity: 1.0 = identical, 0.0 = completely different
      // 0.5 = moderately similar, good balance for semantic search
      const results = await this.qdrant.searchSimilar(
        userId,
        queryEmbedding,
        limit * 2, // Get more results to filter
        0.5, // Better threshold for meaningful semantic matches
      );

      if (results.length === 0) {
        // If no results with 0.5, try with lower threshold
        this.logger.log(
          `No results with threshold 0.5, trying 0.3 for query: ${query}`,
        );
        const lowerResults = await this.qdrant.searchSimilar(
          userId,
          queryEmbedding,
          limit * 2,
          0.3,
        );
        if (lowerResults.length === 0) {
          // Fallback to fuzzy search
          return this.searchItems(userId, query, limit);
        }
        results.push(...lowerResults);
      }

      // Enrich with MongoDB data (batch query for better performance)
      const messageIds = results.map((r) => r.messageId);
      const items = await this.emailItemModel
        .find({
          userId: new Types.ObjectId(userId),
          messageId: { $in: messageIds },
        })
        .select(
          '_id userId provider mailboxId messageId threadId subject senderName senderEmail snippet summary status originalStatus snoozeUntil lastSummarizedAt hasAttachments createdAt updatedAt',
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
            hasAttachments: item.hasAttachments ?? false,
            _score: result.score,
            _searchType: 'semantic',
          });
        }
      }

      // Sort by score descending (higher score = better match)
      enriched.sort((a, b) => (b._score || 0) - (a._score || 0));

      // Return top results
      return enriched.slice(0, limit);
    } catch (error) {
      this.logger.error('Semantic search error:', error);
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
    const contacts = await this.qdrant.getUniqueContacts(userId, 200);

    // Filter contacts by query - prioritize startsWith, then includes
    const exactMatches = contacts.filter(
      (c) =>
        c.name.toLowerCase().startsWith(q) ||
        c.email.toLowerCase().startsWith(q),
    );
    const partialMatches = contacts.filter(
      (c) =>
        !exactMatches.includes(c) &&
        (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)),
    );

    const contactSuggestions = [...exactMatches, ...partialMatches]
      .slice(0, 3)
      .map((c) => ({
        type: 'contact' as const,
        text: c.name,
        value: c.email,
      }));

    // Get subject keywords from recent emails (increase limit)
    const recentEmails = await this.emailItemModel
      .find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(200)
      .select('subject snippet')
      .lean()
      .exec();

    // Extract keywords from subjects and snippets - better matching logic
    const keywordCounts = new Map<string, number>();
    recentEmails.forEach((email) => {
      const text = `${email.subject || ''} ${(email as any).snippet || ''}`;
      if (text) {
        const words = text
          .toLowerCase()
          .split(/[\s,\.;:!?]+/)
          .filter(
            (w) =>
              w.length > 3 &&
              (w.startsWith(q) || (q.length >= 3 && w.includes(q))),
          );
        words.forEach((w) => {
          keywordCounts.set(w, (keywordCounts.get(w) || 0) + 1);
        });
      }
    });

    // Sort keywords by frequency and relevance
    const sortedKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => {
        // Prioritize words that start with query
        const aStarts = a[0].startsWith(q) ? 1 : 0;
        const bStarts = b[0].startsWith(q) ? 1 : 0;
        if (aStarts !== bStarts) return bStarts - aStarts;
        // Then by frequency
        return b[1] - a[1];
      })
      .map(([word]) => word);

    const keywordSuggestions = sortedKeywords
      .slice(0, limit - contactSuggestions.length)
      .map((k) => ({
        type: 'keyword' as const,
        text: k,
        value: k,
      }));

    // Combine and ensure we have at least some suggestions
    const combined = [...contactSuggestions, ...keywordSuggestions];
    return combined.slice(0, limit);
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
    const upsertOk = await this.qdrant.upsertEmbedding(
      messageId,
      userId,
      embedding,
      {
        subject: item.subject,
        senderName: item.senderName,
        senderEmail: item.senderEmail,
        snippet: item.snippet,
        summary: item.summary,
        createdAt: (item as any).createdAt,
      },
    );

    // Important: only mark Mongo as embedded if Qdrant upsert succeeded.
    if (!upsertOk) {
      throw new InternalServerErrorException(
        'Failed to store embedding in vector database',
      );
    }

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
    if (!raw || !raw.trim()) {
      return { name: 'Unknown', email: '' };
    }

    const trimmed = raw.trim();

    // Format: "Name" <email@example.com>
    const matchWithQuotes = trimmed.match(/"([^"]+)"\s*<(.+@.+)>/);
    if (matchWithQuotes) {
      return {
        name: matchWithQuotes[1].trim(),
        email: matchWithQuotes[2].trim(),
      };
    }

    // Format: Name <email@example.com>
    const matchWithoutQuotes = trimmed.match(/(.+?)\s*<(.+@.+)>/);
    if (matchWithoutQuotes) {
      return {
        name: matchWithoutQuotes[1].trim(),
        email: matchWithoutQuotes[2].trim(),
      };
    }

    // Format: email@example.com (no name)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(trimmed)) {
      // Extract name from email (part before @)
      const username = trimmed.split('@')[0];
      return {
        name: username.replace(/[._-]/g, ' ').trim() || 'Unknown',
        email: trimmed,
      };
    }

    // Fallback: treat entire string as name
    return { name: trimmed, email: trimmed };
  }

  /**
   * Đồng bộ tối thiểu: lấy list Gmail messages theo label,
   * upsert vào email_items để phục vụ Kanban.
   * Always detects attachments for filtering support.
   * @param specificMessageId - If provided, only sync this specific message
   */
  async syncLabelToItems(
    userId: string,
    labelId = 'INBOX',
    maxResults = 30,
    specificMessageId?: string,
  ) {
    const gmail = await this.getGmailClient(userId);
    const uid = new Types.ObjectId(userId);

    let msgs: Array<{ id?: string | null }> = [];

    if (specificMessageId) {
      // Fetch specific message
      msgs = [{ id: specificMessageId }];
    } else {
      // Fetch message list by label
      const list = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        maxResults,
      });
      msgs = list.data.messages ?? [];
    }

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
      const snippet = detail.data.snippet || subject; // Use Gmail snippet
      const from = this.parseAddress(fromRaw);

      // Debug logging
      if (!fromRaw || from.name === 'Unknown') {
        this.logger.warn(
          `Email ${m.id}: Missing or invalid From header. fromRaw="${fromRaw}", parsed name="${from.name}"`,
        );
      }

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

      // Parse Gmail internalDate (milliseconds since epoch)
      let receivedAt: Date | undefined;
      if (detail.data.internalDate) {
        receivedAt = new Date(parseInt(detail.data.internalDate, 10));
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
            snippet,
            threadId: detail.data.threadId,
            hasAttachments,
            ...(receivedAt && { receivedAt }), // Only set if available
          },
        },
        { upsert: true },
      );

      // Generate embedding for new emails (in background, don't await)
      if (result.upsertedCount > 0) {
        this.generateAndStoreEmbedding(userId, m.id).catch((err) =>
          this.logger.error('Failed to generate embedding for', m.id, err),
        );
      }
    }

    return { synced: msgs.length };
  }

  async getBoard(userId: string, pageToken?: string, pageSize: number = 20) {
    const uid = new Types.ObjectId(userId);
    const gmail = await this.getGmailClient(userId);
    const now = new Date();

    // Get user's column configuration
    const columns = await this.getKanbanColumns(userId);

    // Fetch all Gmail labels for resolution
    const labelList = await gmail.users.labels.list({ userId: 'me' });
    const labels = (labelList.data.labels ?? []) as Array<{
      id?: string;
      name?: string;
      type?: string;
    }>;
    const nameToId = new Map(
      labels
        .filter((l) => l.name && l.id)
        .map((l) => [String(l.name).toLowerCase(), String(l.id)]),
    );

    const systemLabelIds = new Set([
      'INBOX',
      'STARRED',
      'IMPORTANT',
      'SENT',
      'DRAFT',
      'TRASH',
      'SPAM',
      'UNREAD',
    ]);

    // Virtual labels that use query instead of labelId
    const virtualLabels = new Set(['SNOOZED']);

    // Resolve label name -> label id (or 'SNOOZED' for virtual labels)
    const resolveLabelId = (value: string) => {
      const v = value.trim();
      if (!v) return '';
      if (systemLabelIds.has(v)) return v;
      if (virtualLabels.has(v)) return v; // Return virtual label as-is
      if (/^Label_/.test(v)) return v;
      const resolved = nameToId.get(v.toLowerCase());
      if (!resolved) {
        console.warn(
          `[Kanban getBoard] Label "${v}" not found in Gmail. Skipping column.`,
        );
      }
      return resolved ?? '';
    };

    // Decode pageToken to get skip offset for each column
    let skipMap: Record<string, number> = {};
    columns.forEach((col) => {
      skipMap[col.id] = 0;
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

    // Fetch emails from Gmail based on each column's gmailLabel
    const columnData = await Promise.all(
      columns.map(async (col) => {
        const gmailLabelId = col.gmailLabel
          ? resolveLabelId(col.gmailLabel)
          : '';

        // For columns without Gmail labels, fetch from MongoDB by status
        if (!gmailLabelId) {
          this.logger.log(
            `Column "${col.name}" has no Gmail label. Fetching from MongoDB by status.`,
          );

          // Count total items with this status
          const total = await this.emailItemModel.countDocuments({
            userId: uid,
            status: col.id,
          });

          // Fetch paginated items from MongoDB
          const skip = skipMap[col.id] || 0;
          const items = await this.emailItemModel
            .find({ userId: uid, status: col.id })
            .sort({ receivedAt: -1, createdAt: -1 }) // Sort by email received time, fallback to DB insert time
            .skip(skip)
            .limit(pageSize)
            .lean();

          return {
            status: col.id,
            items: items.map((item) => ({
              ...item,
              hasAttachments: item.hasAttachments ?? false,
            })),
            total,
            warning: col.gmailLabel
              ? `Gmail label "${col.gmailLabel}" not found. Please update column settings.`
              : undefined,
          };
        }

        try {
          // SNOOZED is a virtual label - use query instead of labelId
          const isSnoozed = gmailLabelId === 'SNOOZED';

          // Fetch message IDs from Gmail for this label
          // Gmail API returns messages sorted by internalDate descending (newest first)
          const response = await gmail.users.messages.list({
            userId: 'me',
            ...(isSnoozed ? { q: 'is:snoozed' } : { labelIds: [gmailLabelId] }),
            // Limit to avoid excessive API calls and token consumption
            maxResults: Math.min(100, (skipMap[col.id] || 0) + pageSize * 2),
          });

          const messages = response.data.messages || [];

          // Apply pagination (skip already fetched items)
          const skip = skipMap[col.id] || 0;
          const paginatedMessages = messages.slice(skip, skip + pageSize * 2);

          // Fetch email details from MongoDB (or sync if missing)
          const items = await Promise.all(
            paginatedMessages.map(async (msg) => {
              let item = await this.emailItemModel
                .findOne({ userId: uid, messageId: msg.id })
                .lean();

              // If not in MongoDB, sync it first
              // For SNOOZED, sync to INBOX first (snoozed emails are still in INBOX)
              if (!item) {
                await this.syncLabelToItems(
                  userId,
                  isSnoozed ? 'INBOX' : gmailLabelId,
                  1,
                  msg.id,
                );
                item = await this.emailItemModel
                  .findOne({ userId: uid, messageId: msg.id })
                  .lean();
              }

              if (!item) return null;

              // Hide active snoozed emails from the board.
              // If a snooze has expired but cron hasn't run yet, wake it on-read.
              if (item.status === EmailStatus.SNOOZED) {
                const snoozeUntil = (item as any).snoozeUntil
                  ? new Date((item as any).snoozeUntil)
                  : null;

                if (snoozeUntil && Number.isFinite(snoozeUntil.getTime())) {
                  if (snoozeUntil.getTime() > now.getTime()) {
                    return null;
                  }

                  const restoreTo =
                    (item as any).originalStatus ?? EmailStatus.INBOX;
                  await this.emailItemModel.updateOne(
                    { userId: uid, messageId: msg.id },
                    {
                      $set: { status: restoreTo },
                      $unset: { snoozeUntil: 1, originalStatus: 1 },
                    },
                  );
                  item = {
                    ...(item as any),
                    status: restoreTo,
                    snoozeUntil: undefined,
                    originalStatus: undefined,
                  };
                } else {
                  // No valid snoozeUntil -> keep it hidden and let cron clean it up later.
                  return null;
                }
              }

              // Ensure status matches column ID
              if (item.status !== col.id) {
                await this.emailItemModel.updateOne(
                  { userId: uid, messageId: msg.id },
                  { $set: { status: col.id } },
                );
                item.status = col.id;
              }

              return {
                ...item,
                hasAttachments: item.hasAttachments ?? false,
              };
            }),
          );

          return {
            status: col.id,
            items: items.filter((i) => i !== null).slice(0, pageSize),
            total: messages.length, // Total count from Gmail
          };
        } catch (error) {
          console.error(
            `[Kanban getBoard] Failed to fetch Gmail messages for label ${gmailLabelId}:`,
            error,
          );
          return {
            status: col.id,
            items: [],
            total: 0,
            error: `Failed to fetch emails for label "${col.gmailLabel}". Please check label exists in Gmail.`,
          };
        }
      }),
    );

    const data = columnData.reduce(
      (acc, { status, items }) => ({ ...acc, [status]: items }),
      {} as Record<string, any[]>,
    );

    const totalMap = columnData.reduce(
      (acc, { status, total }) => ({ ...acc, [status]: total }),
      {} as Record<string, number>,
    );

    // Collect warnings and errors from columns
    const warnings = columnData
      .filter((col) => col.warning || col.error)
      .map((col) => ({
        columnId: col.status,
        message: col.warning || col.error,
        type: col.error ? 'error' : 'warning',
      }));

    // Check if there are more items for any column
    const hasMore = columns.some(
      (col) => (skipMap[col.id] || 0) + pageSize < totalMap[col.id],
    );

    // Generate next page token
    let nextPageToken: string | null = null;
    if (hasMore) {
      const nextSkipMap = columns.reduce(
        (acc, col) => ({
          ...acc,
          [col.id]: (skipMap[col.id] || 0) + pageSize,
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
      warnings: warnings.length > 0 ? warnings : undefined, // Include warnings if any
    };
  }

  async updateStatus(
    userId: string,
    messageId: string,
    status: string,
    gmailLabel?: string,
  ) {
    const uid = new Types.ObjectId(userId);

    const updated = await this.emailItemModel.findOneAndUpdate(
      { userId: uid, messageId },
      { $set: { status }, $unset: { snoozeUntil: 1, originalStatus: 1 } },
      { new: true },
    );

    if (!updated) throw new NotFoundException('Email item not found');

    // Sync with Gmail labels (gmailLabel can be provided, empty string for archive, or undefined to skip)
    if (gmailLabel !== undefined) {
      try {
        const gmail = await this.getGmailClient(userId);

        // Resolve label name -> label id when needed
        const labelList = await gmail.users.labels.list({ userId: 'me' });
        const labels = (labelList.data.labels ?? []) as Array<{
          id?: string;
          name?: string;
          type?: string;
        }>;
        const nameToId = new Map(
          labels
            .filter((l) => l.name && l.id)
            .map((l) => [String(l.name).toLowerCase(), String(l.id)]),
        );

        const systemLabelIds = new Set([
          'INBOX',
          'STARRED',
          'IMPORTANT',
          'SENT',
          'DRAFT',
          'TRASH',
          'SPAM',
          'UNREAD',
        ]);

        const resolveLabelId = (value: string) => {
          const v = value.trim();
          if (!v) return '';
          if (systemLabelIds.has(v)) return v;
          if (/^Label_/.test(v)) return v;
          const resolved = nameToId.get(v.toLowerCase());
          if (!resolved) {
            console.warn(
              `[Gmail Sync] Label "${v}" not found in Gmail. Using as-is.`,
            );
          }
          return resolved ?? v;
        };

        const addLabelId = gmailLabel ? resolveLabelId(gmailLabel) : '';

        // Get all column labels for cleanup
        const columns = await this.getKanbanColumns(userId);
        const allWorkflowLabels = columns
          .map((c) => (c.gmailLabel ? resolveLabelId(c.gmailLabel) : ''))
          .filter((id) => id);

        // Archive column support: empty gmailLabel means remove INBOX
        const isArchiveColumn = gmailLabel === '';

        // Remove other workflow labels, and INBOX if archiving
        const removeLabelIds = allWorkflowLabels.filter(
          (id) => id !== addLabelId && (isArchiveColumn || id !== 'INBOX'),
        );

        // If archiving, also remove INBOX
        if (isArchiveColumn && !removeLabelIds.includes('INBOX')) {
          removeLabelIds.push('INBOX');
        }

        // Apply label mapping in a single modify call
        await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: addLabelId ? [addLabelId] : undefined,
            removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
          },
        });

        const action = isArchiveColumn
          ? 'archived (removed INBOX)'
          : addLabelId
            ? `applied label (${gmailLabel} -> ${addLabelId})`
            : 'removed workflow labels';
        this.logger.log(`${action} for message ${messageId}`);
      } catch (error) {
        this.logger.error(`Failed to sync labels:`, error);
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
    const saved = await this.usersService.updateKanbanColumns(userId, columns);

    // If a column was deleted, emails in that status would vanish from the board.
    // Migrate any non-snoozed emails whose status is no longer present into the first column.
    const allowedStatusIds = new Set(saved.map((c) => c.id));
    const fallbackStatus = saved[0]?.id ?? EmailStatus.INBOX;
    const uid = new Types.ObjectId(userId);

    await this.emailItemModel.updateMany(
      {
        userId: uid,
        status: {
          $nin: Array.from(allowedStatusIds),
          $ne: EmailStatus.SNOOZED,
        },
      } as any,
      { $set: { status: fallbackStatus } },
    );

    return saved;
  }
}
