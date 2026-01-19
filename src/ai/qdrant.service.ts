import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: any;
  private readonly collectionName = 'email_embeddings';
  private clientReady: Promise<void>;

  constructor(private readonly config: ConfigService) {
    this.clientReady = this.initializeClient();
  }

  private async initializeClient() {
    try {
      const { QdrantClient } = await import('@qdrant/js-client-rest');
      const url =
        this.config.get<string>('QDRANT_URL') || 'http://localhost:6333';
      const apiKey = this.config.get<string>('QDRANT_API_KEY');

      this.client = new QdrantClient({
        url,
        apiKey,
      });
      this.logger.log('Qdrant client initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Qdrant client', error);
    }
  }

  async onModuleInit() {
    await this.clientReady;
    await this.ensureCollection();
  }

  private async ensureCollection() {
    try {
      await this.clientReady;
      if (!this.client) {
        this.logger.warn(
          'Qdrant client not available, skipping collection creation',
        );
        return;
      }
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName,
      );

      if (!exists) {
        this.logger.log(`Creating collection: ${this.collectionName}`);
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: 1536, // OpenAI text-embedding-3-small dimension
            distance: 'Cosine',
          },
        });
        this.logger.log(`Collection ${this.collectionName} created`);
      }
    } catch (error) {
      this.logger.error('Failed to ensure collection', error);
    }
  }

  async upsertEmbedding(
    messageId: string,
    userId: string,
    embedding: number[],
    metadata: {
      subject?: string;
      senderName?: string;
      senderEmail?: string;
      snippet?: string;
      summary?: string;
      createdAt?: Date;
    },
  ) {
    try {
      await this.clientReady;
      if (!this.client) return false;

      // Convert messageId to UUID format if needed
      // Qdrant requires either unsigned integer or UUID format
      const pointId = this.convertToValidPointId(messageId);

      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: embedding,
            payload: {
              userId,
              messageId, // Keep original messageId in payload for reference
              ...metadata,
              createdAt:
                metadata.createdAt?.toISOString() || new Date().toISOString(),
            },
          },
        ],
      });
      return true;
    } catch (error) {
      this.logger.error('Failed to upsert embedding', error);
      return false;
    }
  }

  /**
   * Convert a messageId to a valid Qdrant point ID (UUID format)
   * Qdrant requires either an unsigned integer or a UUID.
   * This creates a deterministic UUID-shaped ID derived from the messageId.
   */
  private convertToValidPointId(messageId: string): string {
    // Check if it's already a valid UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(messageId)) {
      return messageId;
    }

    // For non-UUID strings (like Gmail message IDs or hex strings),
    // hash deterministically and format as a UUID (8-4-4-4-12).
    // Note: this is *not* a standard UUID v5 implementation, but it is valid UUID format.

    const hex = createHash('sha256')
      .update(messageId)
      .digest('hex')
      .slice(0, 32);
    const chars = hex.split('');

    // Set version nibble to 4 (UUID v4-style)
    chars[12] = '4';

    // Set variant to RFC 4122 (8..b)
    const variantNibble = parseInt(chars[16], 16);
    chars[16] = ((variantNibble & 0x3) | 0x8).toString(16);

    const v = chars.join('');
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
  }

  async searchSimilar(
    userId: string,
    queryEmbedding: number[],
    limit = 10,
    scoreThreshold = 0.5,
  ) {
    try {
      await this.clientReady;
      if (!this.client) return [];

      // Use search with prefetch for better recall
      // This helps find more relevant results by doing a broader initial search
      const results = await this.client.search(this.collectionName, {
        vector: queryEmbedding,
        filter: {
          must: [
            {
              key: 'userId',
              match: { value: userId },
            },
          ],
        },
        limit: limit * 2, // Get more candidates for better filtering
        score_threshold: scoreThreshold,
        with_payload: true,
        // Enable exact search for better accuracy (at cost of speed)
        params: {
          exact: false, // Use HNSW for speed, set true for better accuracy on small datasets
          hnsw_ef: 128, // Higher value = better recall, default is usually 64
        },
      });

      // Post-process results: normalize scores and filter
      const processedResults = results
        .filter((r) => r.score >= scoreThreshold)
        .slice(0, limit)
        .map((r) => ({
          messageId: r.payload?.messageId as string,
          score: r.score,
          subject: r.payload?.subject as string,
          senderName: r.payload?.senderName as string,
          senderEmail: r.payload?.senderEmail as string,
          snippet: r.payload?.snippet as string,
          summary: r.payload?.summary as string,
          createdAt: r.payload?.createdAt as string,
        }));

      return processedResults;
    } catch (error) {
      this.logger.error('Failed to search similar', error);
      return [];
    }
  }

  async deleteEmbedding(messageId: string) {
    try {
      await this.clientReady;
      if (!this.client) return false;

      const pointId = this.convertToValidPointId(messageId);

      await this.client.delete(this.collectionName, {
        wait: true,
        points: [pointId],
      });
      return true;
    } catch (error) {
      this.logger.error('Failed to delete embedding', error);
      return false;
    }
  }

  async getUniqueContacts(userId: string, limit = 100) {
    try {
      await this.clientReady;
      if (!this.client) return [];

      // Use scroll to get all points for the user (in batches if needed)
      const allPoints = [];
      let offset = null;

      do {
        const results = await this.client.scroll(this.collectionName, {
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
            ],
          },
          limit: Math.min(limit * 3, 500), // Get more points to ensure unique contacts
          offset,
          with_payload: true,
        });

        allPoints.push(...results.points);
        offset = results.next_page_offset;

        // Break if we have enough unique contacts or no more results
        if (!offset || allPoints.length >= limit * 3) break;
      } while (offset);

      const contacts = new Map<string, { name: string; email: string }>();

      allPoints.forEach((point) => {
        const email = point.payload?.senderEmail as string;
        const name = point.payload?.senderName as string;
        if (email && !contacts.has(email)) {
          contacts.set(email, { name: name || email, email });
        }
      });

      return Array.from(contacts.values()).slice(0, limit);
    } catch (error) {
      this.logger.error('Failed to get unique contacts', error);
      return [];
    }
  }
}
