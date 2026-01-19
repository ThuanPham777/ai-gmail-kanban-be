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
} from './schemas/email-item.schema';
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
      // Matches Gmail sidebar order
      const systemLabels = [
        'INBOX',
        'STARRED',
        'SENT',
        'DRAFT',
        'IMPORTANT',
        'SPAM',
        'TRASH',
        'UNREAD',
        // Categories
        'CATEGORY_SOCIAL',
        'CATEGORY_PROMOTIONS',
        'CATEGORY_UPDATES',
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

      // Add virtual labels (not real Gmail labels, use query instead)
      const virtualLabels = [
        { id: 'SNOOZED', name: 'Snoozed' },
        { id: 'SCHEDULED', name: 'Scheduled' },
        { id: 'ALL_MAIL', name: 'All Mail' },
      ];

      for (const vLabel of virtualLabels) {
        processedLabels.push({
          id: vLabel.id,
          name: vLabel.name,
          type: 'virtual',
        });
      }

      return processedLabels.sort((a, b) => {
        // System labels first, then alphabetically
        if (a.type === 'system' && b.type !== 'system') return -1;
        if (a.type !== 'system' && b.type === 'system') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      this.logger.error('Failed to fetch Gmail labels', error);
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
        'CATEGORY_SOCIAL',
        'CATEGORY_PROMOTIONS',
        'CATEGORY_UPDATES',
      ]);

      // Virtual labels that use query instead of labelId
      const virtualLabels = new Set(['SNOOZED', 'SCHEDULED', 'ALL_MAIL']);

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
      this.logger.error('Gmail Label Validation Error', error);
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
    // Fuzzy search: lower score = better match (0 = perfect match)
    return results
      .map((r) => ({
        ...(r.item as any),
        hasAttachments: (r.item as any).hasAttachments ?? false,
        _score: r.score ?? 0,
        _searchType: 'fuzzy' as const,
      }))
      .sort((a, b) => (a._score ?? 0) - (b._score ?? 0));
  }

  /**
   * Semantic search using vector embeddings in Qdrant
   * Finds emails by conceptual relevance, not just keyword matching
   * Also includes fuzzy matches for keyword relevance to ensure comprehensive results
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
      let semanticResults = await this.qdrant.searchSimilar(
        userId,
        queryEmbedding,
        limit * 2, // Get more results to filter
        0.5, // Better threshold for meaningful semantic matches
      );

      this.logger.log(
        `Semantic search for "${query}": found ${semanticResults.length} results with threshold 0.5`,
      );

      if (semanticResults.length === 0) {
        // If no results with 0.5, try with lower threshold
        this.logger.log(
          `No results with threshold 0.5, trying 0.3 for query: ${query}`,
        );
        semanticResults = await this.qdrant.searchSimilar(
          userId,
          queryEmbedding,
          limit * 2,
          0.3,
        );
      }

      // Log top semantic results for debugging
      semanticResults.slice(0, 3).forEach((r, i) => {
        this.logger.log(
          `Semantic result ${i + 1}: score=${r.score?.toFixed(4)}, subject="${r.subject?.slice(0, 50)}"`,
        );
      });

      // Also get fuzzy search results for keyword matching
      // This ensures we don't miss emails that have exact keyword matches but may not have embeddings
      const fuzzyResults = await this.searchItems(userId, query, limit);
      const fuzzyMessageIds = new Set(
        fuzzyResults.map((r: any) => r.messageId),
      );

      this.logger.log(
        `Fuzzy search found ${fuzzyResults.length} additional results for keyword matching`,
      );

      // Enrich semantic results with MongoDB data
      const semanticMessageIds = semanticResults.map((r) => r.messageId);
      const items = await this.emailItemModel
        .find({
          userId: new Types.ObjectId(userId),
          messageId: { $in: semanticMessageIds },
        })
        .select(
          '_id userId provider mailboxId messageId threadId subject senderName senderEmail snippet summary status originalStatus snoozeUntil lastSummarizedAt hasAttachments createdAt updatedAt',
        )
        .lean()
        .exec();

      // Create lookup map
      const itemMap = new Map(items.map((item) => [item.messageId, item]));

      const enrichedSemantic = [];
      const semanticMessageIdSet = new Set<string>();

      for (const result of semanticResults) {
        const item = itemMap.get(result.messageId);
        if (item) {
          // Ensure score is always a valid number between 0 and 1
          const score =
            typeof result.score === 'number' && !isNaN(result.score)
              ? Math.max(0, Math.min(1, result.score))
              : 0;
          enrichedSemantic.push({
            ...item,
            hasAttachments: item.hasAttachments ?? false,
            _score: score,
            _searchType: 'semantic' as const,
          });
          semanticMessageIdSet.add(result.messageId);
        }
      }

      // Add fuzzy results that are not already in semantic results
      // These are emails that match keywords but may not have embeddings
      const additionalFuzzyResults = fuzzyResults.filter(
        (r: any) => !semanticMessageIdSet.has(r.messageId),
      );

      // Combine results: semantic first (sorted by score DESC), then fuzzy (sorted by score ASC inverted)
      const combined = [...enrichedSemantic];

      // For fuzzy results not in semantic, convert score for proper ranking
      // Fuzzy score: 0 = perfect match, 1 = worst match
      // We convert to a comparable scale with semantic (0-1 where higher = better)
      for (const fuzzyItem of additionalFuzzyResults) {
        const fuzzyScore = (fuzzyItem as any)._score ?? 0;
        // Convert fuzzy score to semantic-comparable score
        // Perfect fuzzy match (0) becomes ~0.95, worst (1) becomes ~0.3
        const convertedScore = Math.max(0.3, 1 - fuzzyScore * 0.7);
        combined.push({
          ...fuzzyItem,
          _score: convertedScore,
          _searchType: 'fuzzy' as const,
        });
      }

      // Sort by score descending (higher score = better match)
      combined.sort(
        (a, b) => ((b as any)._score || 0) - ((a as any)._score || 0),
      );

      this.logger.log(
        `Returning ${Math.min(combined.length, limit)} combined results (${enrichedSemantic.length} semantic + ${additionalFuzzyResults.length} fuzzy) for query: ${query}`,
      );

      // Return top results
      return combined.slice(0, limit);
    } catch (error) {
      this.logger.error('Semantic search error:', error);
      // Fallback to fuzzy search if semantic search fails
      return this.searchItems(userId, query, limit);
    }
  }

  /**
   * Get auto-suggestions for search based on contacts, subjects, and keywords
   * Requires at least 2 characters to trigger suggestions
   */
  async getSearchSuggestions(userId: string, query: string, limit = 5) {
    if (!query || query.trim().length < 2) {
      return [];
    }

    const uid = new Types.ObjectId(userId);
    const q = query.trim().toLowerCase();

    // 1. Get contacts from MongoDB (more reliable than Qdrant-only)
    const contactsFromDb = await this.emailItemModel
      .find({ userId: uid })
      .select('senderName senderEmail')
      .lean()
      .exec();

    // Deduplicate contacts
    const contactMap = new Map<string, { name: string; email: string }>();
    contactsFromDb.forEach((email) => {
      const emailAddr = (email as any).senderEmail?.toLowerCase();
      if (emailAddr && !contactMap.has(emailAddr)) {
        contactMap.set(emailAddr, {
          name: (email as any).senderName || emailAddr,
          email: emailAddr,
        });
      }
    });
    const contacts = Array.from(contactMap.values());

    // Filter contacts by query - prioritize startsWith, then includes
    const exactContactMatches = contacts.filter(
      (c) =>
        c.name.toLowerCase().startsWith(q) ||
        c.email.toLowerCase().startsWith(q),
    );
    const partialContactMatches = contacts.filter(
      (c) =>
        !exactContactMatches.includes(c) &&
        (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)),
    );

    const contactSuggestions = [
      ...exactContactMatches,
      ...partialContactMatches,
    ]
      .slice(0, 2)
      .map((c) => ({
        type: 'contact' as const,
        text: c.name,
        value: c.email,
      }));

    // 2. Get subject suggestions (full subjects that match)
    const matchingEmails = await this.emailItemModel
      .find({
        userId: uid,
        $or: [
          { subject: { $regex: q, $options: 'i' } },
          { snippet: { $regex: q, $options: 'i' } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('subject snippet')
      .lean()
      .exec();

    // Get unique subjects that contain the query
    const subjectSet = new Set<string>();
    const subjectSuggestions: {
      type: 'subject';
      text: string;
      value: string;
    }[] = [];

    for (const email of matchingEmails) {
      const subject = (email as any).subject;
      if (
        subject &&
        subject.toLowerCase().includes(q) &&
        !subjectSet.has(subject.toLowerCase()) &&
        subjectSuggestions.length < 2
      ) {
        subjectSet.add(subject.toLowerCase());
        subjectSuggestions.push({
          type: 'subject' as const,
          text: subject.length > 50 ? subject.slice(0, 50) + '...' : subject,
          value: subject,
        });
      }
    }

    // 3. Extract meaningful keywords/phrases from matching emails
    const keywordCounts = new Map<string, number>();
    const phrasePattern = new RegExp(`\\b([\\w-]*${q}[\\w-]*)\\b`, 'gi');

    matchingEmails.forEach((email) => {
      const text = `${(email as any).subject || ''} ${(email as any).snippet || ''}`;
      const matches = text.match(phrasePattern);
      if (matches) {
        matches.forEach((match) => {
          const word = match.toLowerCase();
          if (word.length >= 3 && word !== q) {
            keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
          }
        });
      }
    });

    // Sort keywords by frequency and exact match preference
    const sortedKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => {
        // Prioritize words that start with query
        const aStarts = a[0].startsWith(q) ? 2 : 0;
        const bStarts = b[0].startsWith(q) ? 2 : 0;
        // Then exact match
        const aExact = a[0] === q ? 1 : 0;
        const bExact = b[0] === q ? 1 : 0;
        if (aStarts + aExact !== bStarts + bExact)
          return bStarts + bExact - (aStarts + aExact);
        // Then by frequency
        return b[1] - a[1];
      })
      .filter(([word]) => word !== q) // Don't suggest the exact query
      .map(([word]) => word);

    const remainingSlots =
      limit - contactSuggestions.length - subjectSuggestions.length;
    const keywordSuggestions = sortedKeywords
      .slice(0, Math.max(1, remainingSlots))
      .map((k) => ({
        type: 'keyword' as const,
        text: k,
        value: k,
      }));

    // 4. Combine suggestions with proper ordering:
    // - Contacts first (people search is common)
    // - Then subjects (specific email search)
    // - Then keywords (topic search)
    const combined = [
      ...contactSuggestions,
      ...subjectSuggestions,
      ...keywordSuggestions,
    ];

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
      // Build list params based on label type
      // Virtual labels use query, INBOX uses category:primary
      const isInbox = labelId === 'INBOX';
      const isSnoozed = labelId === 'SNOOZED';
      const isScheduled = labelId === 'SCHEDULED';
      const isAllMail = labelId === 'ALL_MAIL';

      let listParams: { q?: string; labelIds?: string[] } = {};
      if (isInbox) {
        listParams = { q: 'in:inbox category:primary' };
      } else if (isSnoozed) {
        listParams = { q: 'is:snoozed' };
      } else if (isScheduled) {
        listParams = { q: 'is:scheduled' };
      } else if (isAllMail) {
        listParams = { q: 'in:all' };
      } else {
        listParams = { labelIds: [labelId] };
      }

      const list = await gmail.users.messages.list({
        userId: 'me',
        ...listParams,
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

      const isUnread = (detail.data.labelIds ?? []).includes('UNREAD');

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
            unread: isUnread,
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

    // Decode pageToken to get cursor (receivedAt) and Gmail sync state for each column
    // Using cursor-based pagination instead of skip-based to handle data changes correctly
    let cursorMap: Record<string, string | null> = {}; // receivedAt ISO string cursor per column
    let gmailDoneMap: Record<string, boolean> = {}; // Track if Gmail sync is complete for each column
    let gmailPageTokenMap: Record<string, string | null> = {}; // Track Gmail API pageToken for each column

    columns.forEach((col) => {
      cursorMap[col.id] = null; // null = start from beginning (newest)
      gmailDoneMap[col.id] = false;
      gmailPageTokenMap[col.id] = null;
    });

    if (pageToken) {
      try {
        const decoded = JSON.parse(
          Buffer.from(pageToken, 'base64').toString('utf-8'),
        );
        // Support both old skip-based and new cursor-based tokens
        if (decoded.cursor) {
          cursorMap = decoded.cursor;
        }
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
        const cursor = cursorMap[col.id]; // receivedAt ISO string or null

        // Build query for this column using cursor-based pagination
        const baseQuery: any = {
          userId: uid,
          status: col.id,
        };

        // Add cursor condition if we have one (fetch emails OLDER than cursor)
        if (cursor) {
          baseQuery.receivedAt = { $lt: new Date(cursor) };
        }

        // Count total items with this status in MongoDB (for hasMore check)
        const totalInColumn = await this.emailItemModel.countDocuments({
          userId: uid,
          status: col.id,
        });

        // Count items matching cursor query (items we can still fetch)
        const itemsAfterCursor =
          await this.emailItemModel.countDocuments(baseQuery);

        // Check if we need to sync more from Gmail
        // Sync if: column has Gmail label AND not enough items after cursor AND Gmail sync not done
        const needsMore = itemsAfterCursor < pageSize;
        const hasGmailLabel = col.gmailLabel && col.gmailLabel.trim();
        const gmailNotDone = !gmailDoneMap[col.id];

        if (needsMore && hasGmailLabel && gmailNotDone && gmail) {
          this.logger.log(
            `[On-demand sync] Column "${col.name}": need more emails (${itemsAfterCursor} available, need ${pageSize}), syncing from Gmail...`,
          );

          // Find the oldest email in DB for this column to use as date anchor
          // This ensures we fetch emails OLDER than what we already have
          const oldestEmailInDb = await this.emailItemModel
            .findOne({ userId: uid, status: col.id })
            .sort({ receivedAt: 1 }) // oldest first
            .select('receivedAt')
            .lean();

          // Sync more emails from Gmail for this column
          // Pass the oldest date to fetch emails older than our DB cache
          const currentGmailPageToken = gmailPageTokenMap[col.id] || undefined;
          const syncResult = await this.syncGmailLabelToColumnOnDemand(
            userId,
            col.id,
            col.gmailLabel,
            gmail,
            pageSize, // Sync exactly pageSize (10) emails per scroll
            currentGmailPageToken,
            oldestEmailInDb?.receivedAt, // Pass oldest date for smarter sync
          );

          // Update Gmail pageToken for next request
          gmailPageTokenMap[col.id] = syncResult.nextGmailPageToken;

          // Update gmailDone if no more emails from Gmail
          if (!syncResult.hasMore) {
            gmailDoneMap[col.id] = true;
          }
        }

        // Fetch paginated items from MongoDB using cursor (no skip!)
        let items = await this.emailItemModel
          .find(baseQuery)
          .sort({ receivedAt: -1, createdAt: -1 })
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

        // Get the oldest receivedAt from this batch for cursor
        const oldestItem = filteredItems[filteredItems.length - 1];
        const nextCursor = oldestItem?.receivedAt
          ? new Date(oldestItem.receivedAt).toISOString()
          : null;

        return {
          status: col.id,
          items: filteredItems,
          totalInColumn,
          nextCursor,
          gmailDone: gmailDoneMap[col.id] || !hasGmailLabel, // Mark as done if no Gmail label
        };
      }),
    );

    const data = columnData.reduce(
      (acc, { status, items }) => ({ ...acc, [status]: items }),
      {} as Record<string, any[]>,
    );

    const totalMap = columnData.reduce(
      (acc, { status, totalInColumn }) => ({ ...acc, [status]: totalInColumn }),
      {} as Record<string, number>,
    );

    // Build next cursor map from column results
    const nextCursorMap: Record<string, string | null> = {};
    for (const col of columnData) {
      // Only update cursor if we got items (otherwise keep the old cursor)
      nextCursorMap[col.status] = col.nextCursor || cursorMap[col.status];
      gmailDoneMap[col.status] = col.gmailDone;
    }

    // Check if this page actually returned any items
    const thisPageHasItems = columnData.some((col) => col.items.length > 0);

    // Check if there are more items for any column
    // hasMore = true if:
    // 1. ANY column returned a full page (might have more in DB)
    // 2. OR ANY column can still sync from Gmail (even if DB is exhausted)
    const canSyncMoreFromGmail = columns.some(
      (col) => !gmailDoneMap[col.id] && col.gmailLabel?.trim(),
    );

    const hasMore =
      // If we got items, check if any column has more
      (thisPageHasItems &&
        columns.some((col) => {
          const colData = columnData.find((c) => c.status === col.id);
          const returnedFullPage = (colData?.items.length || 0) >= pageSize;
          return returnedFullPage;
        })) ||
      // OR if Gmail still has more to sync (even if DB is exhausted)
      canSyncMoreFromGmail;

    // Generate next page token using cursor-based pagination
    let nextPageToken: string | null = null;
    if (hasMore) {
      nextPageToken = Buffer.from(
        JSON.stringify({
          cursor: nextCursorMap,
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
   * Uses Gmail pageToken for pagination, or falls back to date-based query
   * @param oldestDateInDb - If provided and no pageToken, fetch emails older than this date
   * Returns { synced: number, hasMore: boolean, nextGmailPageToken: string | null }
   */
  private async syncGmailLabelToColumnOnDemand(
    userId: string,
    columnId: string,
    gmailLabel: string,
    gmail: any,
    maxResults: number,
    gmailPageToken?: string,
    oldestDateInDb?: Date,
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
      // Build list params based on label type
      const isInbox = labelId === 'INBOX';
      const isSnoozed = labelId === 'SNOOZED';
      const isScheduled = labelId === 'SCHEDULED';
      const isAllMail = labelId === 'ALL_MAIL';

      let listParams: { q?: string; labelIds?: string[] } = {};
      if (isInbox) {
        listParams = { q: 'in:inbox category:primary' };
      } else if (isSnoozed) {
        listParams = { q: 'is:snoozed' };
      } else if (isScheduled) {
        listParams = { q: 'is:scheduled' };
      } else if (isAllMail) {
        listParams = { q: 'in:all' };
      } else {
        listParams = { labelIds: [labelId] };
      }

      // If we have emails in DB but no pageToken, add date filter to get OLDER emails
      // This prevents re-fetching emails we already have
      if (!gmailPageToken && oldestDateInDb) {
        const beforeDate = new Date(oldestDateInDb);
        // Gmail search uses YYYY/MM/DD format
        const dateStr = `${beforeDate.getFullYear()}/${String(beforeDate.getMonth() + 1).padStart(2, '0')}/${String(beforeDate.getDate()).padStart(2, '0')}`;

        // Add "before:" filter to existing query
        if (listParams.q) {
          listParams.q = `${listParams.q} before:${dateStr}`;
        } else {
          listParams = { q: `before:${dateStr}` };
          // Also add label filter if using labelIds approach
          if (
            labelId &&
            !['INBOX', 'SNOOZED', 'SCHEDULED', 'ALL_MAIL'].includes(labelId)
          ) {
            listParams.q = `label:${gmailLabel} before:${dateStr}`;
          }
        }

        this.logger.log(
          `[On-demand sync] Using date filter: before:${dateStr} (oldest in DB: ${oldestDateInDb.toISOString()})`,
        );
      }

      // Use Gmail pageToken for pagination
      const response = await gmail.users.messages.list({
        userId: 'me',
        ...listParams,
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

          const isUnread = (detail.data.labelIds ?? []).includes('UNREAD');

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

          try {
            await this.emailItemModel.create({
              userId: uid,
              provider: 'gmail',
              messageId: msg.id,
              mailboxId: labelId,
              unread: isUnread,
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
              this.logger.error(
                'Failed to generate embedding for',
                msg.id,
                err,
              ),
            );
          } catch (err: any) {
            // Ignore duplicate key error (E11000) - email was inserted by another parallel sync
            // This happens when same email belongs to multiple labels being synced simultaneously
            if (err?.code === 11000) {
              this.logger.debug(
                `Email ${msg.id} already exists (inserted by parallel sync), skipping`,
              );
            } else {
              throw err; // Re-throw other errors
            }
          }
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
            this.logger.warn(`Label "${v}" not found in Gmail. Using as-is.`);
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
      this.logger.error('Failed to generate embedding after summary', err),
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

    const virtualLabels = new Set(['SNOOZED', 'SCHEDULED', 'ALL_MAIL']);

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
      // Build list params based on label type
      const isInbox = labelId === 'INBOX';
      const isSnoozed = labelId === 'SNOOZED';
      const isScheduled = labelId === 'SCHEDULED';
      const isAllMail = labelId === 'ALL_MAIL';

      let listParams: { q?: string; labelIds?: string[] } = {};
      if (isInbox) {
        listParams = { q: 'in:inbox category:primary' };
      } else if (isSnoozed) {
        listParams = { q: 'is:snoozed' };
      } else if (isScheduled) {
        listParams = { q: 'is:scheduled' };
      } else if (isAllMail) {
        listParams = { q: 'in:all' };
      } else {
        listParams = { labelIds: [labelId] };
      }

      const response = await gmail.users.messages.list({
        userId: 'me',
        ...listParams,
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

          const isUnread = (detail.data.labelIds ?? []).includes('UNREAD');

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
            unread: isUnread,
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

    // Handle orphaned emails when columns are deleted
    // Strategy: Only migrate to columns that have Gmail label mappings
    // Columns without Gmail labels are "manual-only" - should not receive auto-migrated emails
    const allowedStatusIds = new Set(saved.map((c) => c.id));
    const uid = new Types.ObjectId(userId);

    // Find columns with Gmail labels (these are "email source" columns)
    const columnsWithLabels = saved.filter((c) => c.gmailLabel?.trim());

    // Get deleted columns
    const deletedColumns = oldColumns.filter(
      (c) => !allowedStatusIds.has(c.id),
    );

    if (deletedColumns.length > 0) {
      for (const deletedCol of deletedColumns) {
        const count = await this.emailItemModel.countDocuments({
          userId: uid,
          status: deletedCol.id,
        });

        if (count === 0) continue;

        // Determine migration target:
        // 1. Prefer INBOX column if it exists and has a Gmail label
        // 2. Otherwise, use first column with Gmail label
        // 3. If NO column has Gmail label, DO NOT migrate - leave emails orphaned
        //    (they won't show up but can be recovered if user creates column with same ID or INBOX)
        const migrationTarget =
          columnsWithLabels.find((c) => c.id === 'INBOX') ||
          columnsWithLabels[0];

        if (migrationTarget) {
          await this.emailItemModel.updateMany(
            { userId: uid, status: deletedCol.id },
            { $set: { status: migrationTarget.id } },
          );

          this.logger.log(
            `Migrated ${count} emails from deleted column "${deletedCol.name}" to "${migrationTarget.name}"`,
          );
        } else {
          // No suitable migration target - leave emails orphaned
          // They won't appear on the board but remain in DB for potential recovery
          this.logger.warn(
            `No suitable column to migrate ${count} emails from deleted column "${deletedCol.name}". ` +
              `Emails remain orphaned (status: "${deletedCol.id}"). ` +
              `Create a column with Gmail label or recreate the deleted column to recover them.`,
          );
        }
      }
    }

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

  /**
   * ============================================================
   * GMAIL PUSH SYNC - Sync Gmail state changes to Kanban MongoDB
   * ============================================================
   * This method is called when Gmail Push notification is received.
   * It syncs the email state (read/unread, labels, deleted) from Gmail
   * to MongoDB to keep Kanban data consistent with Gmail.
   */

  /**
   * Sync Gmail state changes to Kanban MongoDB
   * Called by GmailPushController when receiving push notifications
   *
   * Handles:
   * 1. New messages (messageAdded) - Add to Kanban if in INBOX
   * 2. Deleted messages (messageDeleted) - Remove from Kanban
   * 3. Label changes (labelAdded/labelRemoved) - Update status/unread in Kanban
   *
   * @param userId - User's MongoDB ObjectId string
   * @param changes - Array of Gmail history changes
   * @returns Summary of sync operations
   */
  async syncGmailChangesToKanban(
    userId: string,
    changes: Array<{
      type: 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';
      messageId: string;
      threadId?: string;
      labelIds?: string[];
    }>,
  ): Promise<{
    added: number;
    deleted: number;
    updated: number;
    errors: number;
  }> {
    const uid = new Types.ObjectId(userId);
    const result = { added: 0, deleted: 0, updated: 0, errors: 0 };

    if (!changes || changes.length === 0) {
      return result;
    }

    // Get Gmail client and user's Kanban column configuration
    let gmail: any;
    let columns: KanbanColumnConfig[];

    try {
      gmail = await this.getGmailClient(userId);
      columns = await this.getKanbanColumns(userId);
    } catch (error) {
      this.logger.error(
        `[GmailPushSync] Failed to initialize for user ${userId}:`,
        error,
      );
      return result;
    }

    // Build label -> column mapping
    const labelToColumn = new Map<string, string>();
    for (const col of columns) {
      if (col.gmailLabel?.trim()) {
        // Handle system labels directly
        const label = col.gmailLabel.trim().toUpperCase();
        labelToColumn.set(label, col.id);
        // Also map the original case
        labelToColumn.set(col.gmailLabel.trim(), col.id);
      }
    }

    // Process each change
    for (const change of changes) {
      try {
        switch (change.type) {
          case 'messageAdded':
            await this.handleMessageAdded(
              uid,
              gmail,
              change.messageId,
              columns,
              labelToColumn,
              result,
            );
            break;

          case 'messageDeleted':
            await this.handleMessageDeleted(uid, change.messageId, result);
            break;

          case 'labelAdded':
          case 'labelRemoved':
            await this.handleLabelChange(
              uid,
              gmail,
              change.messageId,
              change.labelIds || [],
              change.type,
              columns,
              labelToColumn,
              result,
            );
            break;
        }
      } catch (error) {
        this.logger.error(
          `[GmailPushSync] Error processing change ${change.type} for message ${change.messageId}:`,
          error,
        );
        result.errors++;
      }
    }

    this.logger.log(
      `[GmailPushSync] Completed for user ${userId}: ` +
        `added=${result.added}, deleted=${result.deleted}, ` +
        `updated=${result.updated}, errors=${result.errors}`,
    );

    return result;
  }

  /**
   * Handle new message added to Gmail
   * Adds to Kanban if it's in INBOX or matches a column's Gmail label
   */
  private async handleMessageAdded(
    uid: Types.ObjectId,
    gmail: any,
    messageId: string,
    columns: KanbanColumnConfig[],
    labelToColumn: Map<string, string>,
    result: { added: number; deleted: number; updated: number; errors: number },
  ): Promise<void> {
    // Check if already exists in MongoDB
    const existing = await this.emailItemModel.findOne({
      userId: uid,
      messageId,
    });

    if (existing) {
      // Already exists, skip
      return;
    }

    // Fetch message details from Gmail
    const detail = await gmail.users.messages
      .get({ userId: 'me', id: messageId, format: 'full' })
      .catch(() => null);

    if (!detail) {
      this.logger.warn(
        `[GmailPushSync] Could not fetch message ${messageId}, might be deleted`,
      );
      return;
    }

    const gmailLabels = detail.data.labelIds || [];

    // Determine which column this email belongs to
    let targetColumn = 'INBOX'; // Default

    // Check if email matches any column's Gmail label
    for (const label of gmailLabels) {
      const columnId = labelToColumn.get(label);
      if (columnId) {
        targetColumn = columnId;
        break;
      }
    }

    // Only add if it's in INBOX or a mapped column
    const isInInbox = gmailLabels.includes('INBOX');
    const hasMappedColumn = targetColumn !== 'INBOX' || isInInbox;

    if (!hasMappedColumn) {
      // Not relevant to Kanban
      return;
    }

    // Parse email metadata
    const isUnread = gmailLabels.includes('UNREAD');
    const headers = detail.data.payload?.headers ?? [];
    const fromRaw = this.getHeader(headers, 'From');
    const subject = this.getHeader(headers, 'Subject') || '(No subject)';
    const snippet = detail.data.snippet || subject;
    const from = this.parseAddress(fromRaw);
    const hasAttachments = this.detectAttachments(detail.data.payload);

    let receivedAt: Date | undefined;
    if (detail.data.internalDate) {
      receivedAt = new Date(parseInt(detail.data.internalDate, 10));
    }

    // Create new email item
    await this.emailItemModel.create({
      userId: uid,
      provider: 'gmail',
      messageId,
      mailboxId: 'INBOX',
      unread: isUnread,
      senderName: from.name,
      senderEmail: from.email,
      subject,
      snippet,
      threadId: detail.data.threadId,
      status: targetColumn,
      hasAttachments,
      receivedAt,
    });

    result.added++;

    // Generate embedding in background
    this.generateAndStoreEmbedding(uid.toString(), messageId).catch((err) =>
      this.logger.error(
        `[GmailPushSync] Failed to generate embedding for ${messageId}:`,
        err,
      ),
    );
  }

  /**
   * Handle message deleted from Gmail
   * Removes from Kanban MongoDB
   */
  private async handleMessageDeleted(
    uid: Types.ObjectId,
    messageId: string,
    result: { added: number; deleted: number; updated: number; errors: number },
  ): Promise<void> {
    const deleted = await this.emailItemModel.deleteOne({
      userId: uid,
      messageId,
    });

    if (deleted.deletedCount > 0) {
      result.deleted++;

      // Also remove from Qdrant vector store
      try {
        await this.qdrant.deleteEmbedding(messageId);
      } catch (err) {
        this.logger.warn(
          `[GmailPushSync] Failed to delete embedding for ${messageId}:`,
          err,
        );
      }
    }
  }

  /**
   * Handle label added/removed from Gmail message
   * Updates Kanban MongoDB accordingly:
   * - UNREAD label: Update unread status
   * - TRASH/SPAM: Remove from Kanban (treat as deleted)
   * - Column labels: Update status
   * - INBOX removed: Archive (may need to remove from Kanban)
   */
  private async handleLabelChange(
    uid: Types.ObjectId,
    gmail: any,
    messageId: string,
    changedLabels: string[],
    changeType: 'labelAdded' | 'labelRemoved',
    columns: KanbanColumnConfig[],
    labelToColumn: Map<string, string>,
    result: { added: number; deleted: number; updated: number; errors: number },
  ): Promise<void> {
    // Find existing email in MongoDB
    const existing = await this.emailItemModel.findOne({
      userId: uid,
      messageId,
    });

    // Handle TRASH/SPAM: Remove from Kanban
    if (
      changeType === 'labelAdded' &&
      (changedLabels.includes('TRASH') || changedLabels.includes('SPAM'))
    ) {
      if (existing) {
        await this.emailItemModel.deleteOne({ userId: uid, messageId });
        result.deleted++;

        // Also remove from Qdrant
        try {
          await this.qdrant.deleteEmbedding(messageId);
        } catch (err) {
          this.logger.warn(
            `[GmailPushSync] Failed to delete embedding for ${messageId}:`,
            err,
          );
        }
      }
      return;
    }

    // Handle UNREAD label change
    if (changedLabels.includes('UNREAD') && existing) {
      const newUnreadState = changeType === 'labelAdded';
      await this.emailItemModel.updateOne(
        { userId: uid, messageId },
        { $set: { unread: newUnreadState } },
      );
      result.updated++;
      return;
    }

    // Handle INBOX removal (archived)
    if (changeType === 'labelRemoved' && changedLabels.includes('INBOX')) {
      // Email was archived in Gmail
      // Check if we have an "Archive" column (gmailLabel = "")
      const archiveColumn = columns.find((c) => c.gmailLabel === '');

      if (archiveColumn && existing) {
        // Move to archive column
        await this.emailItemModel.updateOne(
          { userId: uid, messageId },
          { $set: { status: archiveColumn.id } },
        );
        result.updated++;
      } else if (existing) {
        // No archive column - just keep in current status
        // Or optionally remove from Kanban
        // For now, keep it in current column
      }
      return;
    }

    // Handle column label changes
    for (const label of changedLabels) {
      const columnId = labelToColumn.get(label);

      if (columnId && changeType === 'labelAdded') {
        if (existing) {
          // Update status to new column
          await this.emailItemModel.updateOne(
            { userId: uid, messageId },
            { $set: { status: columnId } },
          );
          result.updated++;
        } else {
          // Email doesn't exist in Kanban - fetch and add it
          await this.handleMessageAdded(
            uid,
            gmail,
            messageId,
            columns,
            labelToColumn,
            result,
          );
        }
        return;
      }
    }

    // If email exists but no specific handling, refetch current state from Gmail
    if (existing) {
      try {
        const detail = await gmail.users.messages
          .get({ userId: 'me', id: messageId, format: 'metadata' })
          .catch(() => null);

        if (detail) {
          const gmailLabels = detail.data.labelIds || [];
          const isUnread = gmailLabels.includes('UNREAD');

          // Determine correct column based on current Gmail labels
          let newStatus = existing.status;
          for (const label of gmailLabels) {
            const columnId = labelToColumn.get(label);
            if (columnId) {
              newStatus = columnId;
              break;
            }
          }

          // Check if in INBOX
          if (gmailLabels.includes('INBOX') && newStatus === existing.status) {
            newStatus = 'INBOX';
          }

          // Update if changed
          if (isUnread !== existing.unread || newStatus !== existing.status) {
            await this.emailItemModel.updateOne(
              { userId: uid, messageId },
              { $set: { unread: isUnread, status: newStatus } },
            );
            result.updated++;
          }
        }
      } catch (err) {
        this.logger.warn(
          `[GmailPushSync] Failed to refetch message ${messageId}:`,
          err,
        );
      }
    }
  }
}
