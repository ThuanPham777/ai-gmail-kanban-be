// src/ai/ai.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as crypto from 'crypto';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: OpenAI;
  private model: string;
  private embeddingModel: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.getOrThrow<string>('OPENAI_API_KEY');
    this.client = new OpenAI({ apiKey });
    this.model =
      this.config.get<string>('OPENAI_MODEL_SUMMARY') ?? 'gpt-4o-mini';
    this.embeddingModel =
      this.config.get<string>('OPENAI_EMBEDDING_MODEL') ??
      'text-embedding-3-small';
  }

  /**
   * Common email stop words and noise to filter out
   */
  private readonly emailStopWords = new Set([
    'fwd',
    'fw',
    're',
    'reply',
    'forwarded',
    'original',
    'message',
    'sent',
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'date',
    'wrote',
    'said',
    'mailto',
    'href',
    'http',
    'https',
    'www',
    'unsubscribe',
    'click',
    'here',
    'view',
    'browser',
    'email',
    'copyright',
    'reserved',
    'rights',
    'privacy',
    'policy',
    'terms',
    'conditions',
    'disclaimer',
    'confidential',
  ]);

  /**
   * Normalize and clean text for better embedding quality
   */
  private normalizeText(text: string): string {
    if (!text) return '';

    return (
      text
        // Normalize unicode characters
        .normalize('NFKC')
        // Remove email addresses (keep display names)
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
        // Remove URLs but keep descriptive parts
        .replace(/https?:\/\/[^\s]+/g, '')
        // Remove special characters but keep meaningful punctuation
        .replace(/[^\w\s.,!?;:'-]/g, ' ')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        // Remove very short tokens (likely noise)
        .split(' ')
        .filter((word) => word.length > 1)
        .join(' ')
        .trim()
        .toLowerCase()
    );
  }

  /**
   * Extract meaningful keywords from text
   */
  private extractKeywords(text: string, maxKeywords = 20): string[] {
    if (!text) return [];

    const words = text.toLowerCase().split(/\s+/);
    const wordFreq = new Map<string, number>();

    for (const word of words) {
      // Skip stop words and short words
      if (this.emailStopWords.has(word) || word.length < 3) continue;
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }

    // Sort by frequency and return top keywords
    return Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word]) => word);
  }

  stripHtml(html: string) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\/?[^>]+(>|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  hashText(text: string) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  async summarizeEmail(input: {
    subject?: string;
    fromEmail?: string;
    fromName?: string;
    bodyHtml?: string;
    bodyText?: string;
  }) {
    const rawText =
      input.bodyText?.trim() ||
      (input.bodyHtml ? this.stripHtml(input.bodyHtml) : '');

    const safeText = rawText.slice(0, 8000);
    const bodyHash = this.hashText(safeText || '');

    if (!safeText) {
      return {
        summary: 'No content to summarize.',
        bodyHash,
        model: this.model,
      };
    }

    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert email summarizer. Create a concise, professional summary of the email content. ' +
            'Focus on the main points, key information, and context. ' +
            'Use 2-4 bullet points for clarity. Keep it brief and informative.',
        },
        {
          role: 'user',
          content: [
            `From: ${input.fromName ?? ''} <${input.fromEmail ?? ''}>`,
            `Subject: ${input.subject ?? ''}`,
            `Body: ${safeText}`,
          ].join('\n'),
        },
      ],
      temperature: 0.2,
    });

    const summary =
      res.choices?.[0]?.message?.content?.trim() || 'Summary unavailable.';

    return { summary, bodyHash, model: this.model };
  }

  /**
   * Generate embeddings for text using OpenAI embedding model
   * Enhanced with text preprocessing for better quality
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error('Text cannot be empty for embedding generation');
    }

    // Normalize and clean the text
    const normalized = this.normalizeText(text);

    // Truncate text to avoid token limits (8191 tokens for text-embedding-3-small)
    const truncated = normalized.slice(0, 8000);

    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: truncated,
    });

    return response.data[0].embedding;
  }

  /**
   * Generate embedding from email content with enhanced structured format
   * Uses semantic-aware text formatting for better retrieval accuracy
   */
  async generateEmailEmbedding(input: {
    subject?: string;
    fromEmail?: string;
    fromName?: string;
    snippet?: string;
    summary?: string;
    bodyText?: string;
  }): Promise<number[]> {
    // Build a semantically rich document representation
    // Structure: [Sender Context] [Topic/Subject] [Content Summary] [Keywords]

    const parts: string[] = [];

    // 1. Sender context - who sent this email
    if (input.fromName) {
      parts.push(`From: ${input.fromName}`);
    }

    // 2. Subject line - main topic (weighted heavily)
    if (input.subject) {
      const cleanSubject = input.subject
        .replace(/^(re:|fwd?:|fw:)\s*/gi, '')
        .trim();
      if (cleanSubject) {
        // Repeat subject to give it more weight
        parts.push(`Subject: ${cleanSubject}`);
        parts.push(`Topic: ${cleanSubject}`);
      }
    }

    // 3. Summary - AI-generated understanding of email content
    if (input.summary && input.summary !== 'No content to summarize.') {
      parts.push(`Summary: ${input.summary}`);
    }

    // 4. Snippet - preview text (often contains key information)
    if (input.snippet) {
      const cleanSnippet = this.normalizeText(input.snippet);
      if (cleanSnippet.length > 20) {
        parts.push(`Content: ${cleanSnippet}`);
      }
    }

    // 5. Body content if available (extract key content)
    if (input.bodyText) {
      const cleanBody = this.normalizeText(input.bodyText);
      // Extract keywords from body for better semantic matching
      const keywords = this.extractKeywords(cleanBody, 15);
      if (keywords.length > 0) {
        parts.push(`Keywords: ${keywords.join(', ')}`);
      }
    }

    const text = parts.join('. ').trim();

    if (!text) {
      // Fallback to basic concatenation if no structured content
      const fallbackParts = [
        input.subject || '',
        input.fromName || '',
        input.snippet || '',
        input.summary || '',
      ].filter(Boolean);
      return this.generateEmbedding(fallbackParts.join(' '));
    }

    this.logger.debug(
      `Generated email embedding text: ${text.slice(0, 200)}...`,
    );

    return this.generateEmbedding(text);
  }

  /**
   * Generate embedding for search query with query expansion
   * Handles short queries better by understanding search intent
   */
  async generateQueryEmbedding(query: string): Promise<number[]> {
    if (!query || !query.trim()) {
      throw new Error('Query cannot be empty');
    }

    const normalizedQuery = query.trim().toLowerCase();

    // For short queries, try to expand with semantic context
    // This helps match queries like "meeting" with emails about "schedule", "appointment", etc.
    let enrichedQuery = normalizedQuery;

    // Add common query patterns for better matching
    // Format: "search for emails about: [query]. Looking for: [query]"
    // This primes the embedding model to understand search intent
    if (normalizedQuery.length < 50) {
      enrichedQuery = `Email search query: ${normalizedQuery}. Looking for emails about: ${normalizedQuery}. Topic: ${normalizedQuery}`;
    }

    this.logger.debug(
      `Query embedding: "${normalizedQuery}" -> "${enrichedQuery.slice(0, 100)}..."`,
    );

    return this.generateEmbedding(enrichedQuery);
  }

  /**
   * Batch generate embeddings for multiple texts
   * More efficient than calling generateEmbedding multiple times
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Normalize and truncate all texts
    const normalizedTexts = texts
      .map((text) => this.normalizeText(text).slice(0, 8000))
      .filter((text) => text.length > 0);

    if (normalizedTexts.length === 0) {
      return [];
    }

    // OpenAI supports batch embedding
    const response = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: normalizedTexts,
    });

    return response.data.map((item) => item.embedding);
  }
}
