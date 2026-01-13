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
   * Detect real attachments in email payload
   * Excludes inline images (signatures, embedded images)
   */
  private detectAttachments(payload: any): boolean {
    const walk = (node: any): boolean => {
      if (!node) return false;

      // Check if this part has a real attachment (not inline)
      if (node.filename && node.filename.trim()) {
        const headers = node.headers || [];
        const disposition = headers.find(
          (h: any) => h.name?.toLowerCase() === 'content-disposition',
        );
        const dispositionValue = disposition?.value?.toLowerCase() || '';

        // It's a real attachment if has attachmentId AND not inline
        if (node.body?.attachmentId && !dispositionValue.startsWith('inline')) {
          return true;
        }
      }

      // Recurse into parts
      if (node.parts && Array.isArray(node.parts)) {
        return node.parts.some((p: any) => walk(p));
      }
      return false;
    };

    try {
      return walk(payload);
    } catch {
      return false;
    }
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

      // Detect attachments - exclude inline images
      const hasAttachments = this.detectAttachments(detail.data.payload);

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

  async getBoard(userId: string, pageToken?: string, pageSize: number = 10) {
    const uid = new Types.ObjectId(userId);

    // Get user's column configuration
    const columns = await this.getKanbanColumns(userId);

    // Decode pageToken to get skip offset and Gmail sync state for each column
    let skipMap: Record<string, number> = {};
    let gmailDoneMap: Record<string, boolean> = {}; // Track if Gmail sync is complete for each column
    let gmailPageTokenMap: Record<string, string | null> = {}; // Track Gmail API pageToken for each column

    columns.forEach((col) => {
      skipMap[col.id] = 0;
      gmailDoneMap[col.id] = false;
      gmailPageTokenMap[col.id] = null;
    });

    if (pageToken) {
      try {
        const decoded = JSON.parse(
          Buffer.from(pageToken, 'base64').toString('utf-8'),
        );
        skipMap = decoded.skip || decoded; // Backward compatible
        gmailDoneMap = decoded.gmailDone || {};
        gmailPageTokenMap = decoded.gmailPageToken || {};
      } catch {
        // Invalid token, start from beginning
      }
    }

    // Get Gmail client for on-demand sync
    let gmail: any = null;
    try {
      gmail = await this.getGmailClient(userId);
    } catch (e) {
      this.logger.warn('Could not get Gmail client for on-demand sync');
    }

    // Fetch emails from MongoDB based on status field (source of truth)
    // If MongoDB doesn't have enough data, sync more from Gmail
    const columnData = await Promise.all(
      columns.map(async (col) => {
        const now = new Date();
        const skip = skipMap[col.id] || 0;

        // Build query for this column
        const baseQuery: any = {
          userId: uid,
          status: col.id,
        };

        // Count total items with this status in MongoDB
        let total = await this.emailItemModel.countDocuments(baseQuery);

        // Check if we need to sync more from Gmail
        // Sync if: column has Gmail label AND MongoDB doesn't have enough data AND Gmail sync not done
        const needsMore = skip + pageSize > total;
        const hasGmailLabel = col.gmailLabel && col.gmailLabel.trim();
        const gmailNotDone = !gmailDoneMap[col.id];

        if (needsMore && hasGmailLabel && gmailNotDone && gmail) {
          this.logger.log(
            `[On-demand sync] Column "${col.name}": need more emails, syncing from Gmail...`,
          );

          // Sync more emails from Gmail for this column using Gmail pageToken
          const currentGmailPageToken = gmailPageTokenMap[col.id] || undefined;
          const syncResult = await this.syncGmailLabelToColumnOnDemand(
            userId,
            col.id,
            col.gmailLabel,
            gmail,
            pageSize, // Sync exactly pageSize (10) emails per scroll
            currentGmailPageToken,
          );

          // Update Gmail pageToken for next request
          gmailPageTokenMap[col.id] = syncResult.nextGmailPageToken;

          // Update gmailDone if no more emails from Gmail
          if (!syncResult.hasMore) {
            gmailDoneMap[col.id] = true;
          }

          // Recount after sync
          total = await this.emailItemModel.countDocuments(baseQuery);
        }

        // Fetch paginated items from MongoDB
        let items = await this.emailItemModel
          .find(baseQuery)
          .sort({ receivedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .lean();

        // Process items - wake up expired snoozed emails
        items = await Promise.all(
          items.map(async (item) => {
            // Handle snoozed emails
            if (item.status === EmailStatus.SNOOZED) {
              const snoozeUntil = item.snoozeUntil
                ? new Date(item.snoozeUntil)
                : null;

              if (snoozeUntil && Number.isFinite(snoozeUntil.getTime())) {
                if (snoozeUntil.getTime() > now.getTime()) {
                  // Still snoozed - hide it
                  return null;
                }

                // Snooze expired - wake it up
                const restoreTo = item.originalStatus ?? EmailStatus.INBOX;
                await this.emailItemModel.updateOne(
                  { userId: uid, messageId: item.messageId },
                  {
                    $set: { status: restoreTo },
                    $unset: { snoozeUntil: 1, originalStatus: 1 },
                  },
                );
                return {
                  ...item,
                  status: restoreTo,
                  snoozeUntil: undefined,
                  originalStatus: undefined,
                  hasAttachments: item.hasAttachments ?? false,
                };
              } else {
                // No valid snoozeUntil -> hide it
                return null;
              }
            }

            return {
              ...item,
              hasAttachments: item.hasAttachments ?? false,
            };
          }),
        );

        // Filter out nulls (hidden snoozed items)
        const filteredItems = items.filter((i) => i !== null);

        return {
          status: col.id,
          items: filteredItems,
          total,
          gmailDone: gmailDoneMap[col.id] || !hasGmailLabel, // Mark as done if no Gmail label
        };
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

    // Update gmailDoneMap from columnData
    for (const col of columnData) {
      gmailDoneMap[col.status] = col.gmailDone;
    }

    // Check if there are more items for any column
    // hasMore = true if ANY column has more data in MongoDB OR can sync more from Gmail
    const hasMore = columns.some((col) => {
      const skip = skipMap[col.id] || 0;
      const total = totalMap[col.id] || 0;
      const hasMoreInMongo = skip + pageSize < total;
      const canSyncMoreFromGmail = !gmailDoneMap[col.id] && col.gmailLabel;
      return hasMoreInMongo || canSyncMoreFromGmail;
    });

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
      nextPageToken = Buffer.from(
        JSON.stringify({
          skip: nextSkipMap,
          gmailDone: gmailDoneMap,
          gmailPageToken: gmailPageTokenMap,
        }),
      ).toString('base64');
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

  /**
   * On-demand sync: fetch emails from Gmail label and insert into MongoDB
   * Uses Gmail pageToken for proper pagination
   * Returns { synced: number, hasMore: boolean, nextGmailPageToken: string | null }
   */
  private async syncGmailLabelToColumnOnDemand(
    userId: string,
    columnId: string,
    gmailLabel: string,
    gmail: any,
    maxResults: number,
    gmailPageToken?: string,
  ): Promise<{
    synced: number;
    hasMore: boolean;
    nextGmailPageToken: string | null;
  }> {
    const uid = new Types.ObjectId(userId);

    // Resolve label name -> label id
    const labelList = await gmail.users.labels.list({ userId: 'me' });
    const labels = (labelList.data.labels ?? []) as Array<{
      id?: string;
      name?: string;
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
      return nameToId.get(v.toLowerCase()) ?? '';
    };

    const labelId = resolveLabelId(gmailLabel);
    if (!labelId) {
      return { synced: 0, hasMore: false, nextGmailPageToken: null };
    }

    try {
      const isSnoozed = labelId === 'SNOOZED';

      // Use Gmail pageToken for pagination
      const response = await gmail.users.messages.list({
        userId: 'me',
        ...(isSnoozed ? { q: 'is:snoozed' } : { labelIds: [labelId] }),
        maxResults,
        ...(gmailPageToken ? { pageToken: gmailPageToken } : {}),
      });

      const messages = response.data.messages || [];
      let synced = 0;

      for (const msg of messages) {
        if (!msg.id) continue;

        // Check if email already exists
        const existing = await this.emailItemModel.findOne({
          userId: uid,
          messageId: msg.id,
        });

        if (!existing) {
          // New email - fetch details and insert
          const detail = await gmail.users.messages
            .get({ userId: 'me', id: msg.id, format: 'full' })
            .catch(() => null);

          if (!detail) continue;

          const headers = detail.data.payload?.headers ?? [];
          const fromRaw = this.getHeader(headers, 'From');
          const subject = this.getHeader(headers, 'Subject') || '(No subject)';
          const snippet = detail.data.snippet || subject;
          const from = this.parseAddress(fromRaw);

          // Detect attachments - exclude inline images
          const hasAttachments = this.detectAttachments(detail.data.payload);

          let receivedAt: Date | undefined;
          if (detail.data.internalDate) {
            receivedAt = new Date(parseInt(detail.data.internalDate, 10));
          }

          await this.emailItemModel.create({
            userId: uid,
            provider: 'gmail',
            messageId: msg.id,
            mailboxId: labelId,
            senderName: from.name,
            senderEmail: from.email,
            subject,
            snippet,
            threadId: detail.data.threadId,
            status: columnId,
            hasAttachments,
            receivedAt,
          });

          synced++;

          // Generate embedding in background
          this.generateAndStoreEmbedding(userId, msg.id).catch((err) =>
            this.logger.error('Failed to generate embedding for', msg.id, err),
          );
        }
      }

      // Check if Gmail has more messages
      const hasMore = !!response.data.nextPageToken;
      const nextGmailPageToken = response.data.nextPageToken || null;

      this.logger.log(
        `[On-demand sync] Synced ${synced} new emails, hasMore=${hasMore}, nextToken=${nextGmailPageToken ? 'yes' : 'no'}`,
      );
      return { synced, hasMore, nextGmailPageToken };
    } catch (error) {
      this.logger.error('On-demand sync failed:', error);
      return { synced: 0, hasMore: false, nextGmailPageToken: null };
    }
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

  /**
   * Sync emails from a Gmail label into a specific column
   * Used when creating/updating columns with Gmail label mapping
   */
  async syncGmailLabelToColumn(
    userId: string,
    columnId: string,
    gmailLabel: string,
    maxResults = 50,
  ) {
    if (!gmailLabel || !gmailLabel.trim()) {
      return { synced: 0, message: 'No Gmail label specified' };
    }

    const gmail = await this.getGmailClient(userId);
    const uid = new Types.ObjectId(userId);

    // Resolve label name -> label id
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

    const virtualLabels = new Set(['SNOOZED']);

    const resolveLabelId = (value: string) => {
      const v = value.trim();
      if (!v) return '';
      if (systemLabelIds.has(v)) return v;
      if (virtualLabels.has(v)) return v;
      if (/^Label_/.test(v)) return v;
      return nameToId.get(v.toLowerCase()) ?? '';
    };

    const labelId = resolveLabelId(gmailLabel);
    if (!labelId) {
      this.logger.warn(
        `Gmail label "${gmailLabel}" not found. Skipping sync for column ${columnId}.`,
      );
      return { synced: 0, message: `Label "${gmailLabel}" not found in Gmail` };
    }

    try {
      // SNOOZED uses query instead of labelId
      const isSnoozed = labelId === 'SNOOZED';

      const response = await gmail.users.messages.list({
        userId: 'me',
        ...(isSnoozed ? { q: 'is:snoozed' } : { labelIds: [labelId] }),
        maxResults,
      });

      const messages = response.data.messages || [];
      let synced = 0;

      for (const msg of messages) {
        if (!msg.id) continue;

        // Check if email already exists in MongoDB
        const existing = await this.emailItemModel.findOne({
          userId: uid,
          messageId: msg.id,
        });

        if (existing) {
          // Email exists - only update status if it's still in default INBOX status
          // Don't override if user has manually moved it to another column
          if (existing.status === EmailStatus.INBOX && columnId !== 'INBOX') {
            await this.emailItemModel.updateOne(
              { userId: uid, messageId: msg.id },
              { $set: { status: columnId } },
            );
            synced++;
          }
        } else {
          // New email - sync from Gmail and set status to this column
          const detail = await gmail.users.messages
            .get({ userId: 'me', id: msg.id, format: 'full' })
            .catch(() => null);

          if (!detail) continue;

          const headers = detail.data.payload?.headers ?? [];
          const fromRaw = this.getHeader(headers, 'From');
          const subject = this.getHeader(headers, 'Subject') || '(No subject)';
          const snippet = detail.data.snippet || subject;
          const from = this.parseAddress(fromRaw);

          // Detect attachments - exclude inline images
          const hasAttachments = this.detectAttachments(detail.data.payload);

          // Parse receivedAt
          let receivedAt: Date | undefined;
          if (detail.data.internalDate) {
            receivedAt = new Date(parseInt(detail.data.internalDate, 10));
          }

          await this.emailItemModel.create({
            userId: uid,
            provider: 'gmail',
            messageId: msg.id,
            mailboxId: labelId,
            senderName: from.name,
            senderEmail: from.email,
            subject,
            snippet,
            threadId: detail.data.threadId,
            status: columnId, // Set status to column ID
            hasAttachments,
            receivedAt,
          });

          synced++;

          // Generate embedding in background
          this.generateAndStoreEmbedding(userId, msg.id).catch((err) =>
            this.logger.error('Failed to generate embedding for', msg.id, err),
          );
        }
      }

      this.logger.log(
        `Synced ${synced} emails from Gmail label "${gmailLabel}" to column "${columnId}"`,
      );
      return { synced, message: `Synced ${synced} emails from ${gmailLabel}` };
    } catch (error) {
      this.logger.error(
        `Failed to sync Gmail label "${gmailLabel}" to column:`,
        error,
      );
      return { synced: 0, message: 'Failed to sync from Gmail' };
    }
  }

  async updateKanbanColumns(
    userId: string,
    columns: KanbanColumnConfig[],
  ): Promise<KanbanColumnConfig[]> {
    // Get old columns to detect new Gmail label mappings
    const oldColumns = await this.getKanbanColumns(userId);
    const oldLabelMap = new Map(
      oldColumns.map((c) => [c.id, c.gmailLabel || '']),
    );

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

    // Sync emails from Gmail for columns with new/changed Gmail label mappings
    for (const col of saved) {
      const oldLabel = oldLabelMap.get(col.id) || '';
      const newLabel = col.gmailLabel || '';

      // Skip if label hasn't changed or is empty
      if (oldLabel === newLabel || !newLabel) continue;

      // Skip INBOX column (it's the default, no need to sync)
      if (col.id === 'INBOX') continue;

      // New or changed Gmail label - sync emails in background
      this.logger.log(
        `Column "${col.name}" has new Gmail label "${newLabel}". Syncing emails...`,
      );
      this.syncGmailLabelToColumn(userId, col.id, newLabel, 50).catch((err) =>
        this.logger.error(`Failed to sync label ${newLabel}:`, err),
      );
    }

    return saved;
  }
}
