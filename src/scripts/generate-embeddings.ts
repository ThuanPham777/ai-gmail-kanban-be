/**
 * Embedding Generation Script
 *
 * This script generates embeddings for emails.
 *
 * Modes:
 *   - Default: Only emails WITHOUT embeddings (incremental)
 *   - --regenerate-all: ALL emails including existing (full refresh)
 *
 * Usage:
 *   npx ts-node src/scripts/generate-embeddings.ts [options]
 *   # or after build:
 *   node dist/scripts/generate-embeddings.js [options]
 *
 * Options:
 *   --regenerate-all    Regenerate ALL embeddings (use after upgrading embedding logic)
 *   --dry-run           Show what would be updated without making changes
 *   --user-id=<id>      Only process for a specific user
 *   --batch-size=<n>    Number of emails per batch (default: 50)
 *   --delay=<ms>        Delay between API calls in ms (default: 500)
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { KanbanService } from '../kanban/kanban.service';
import { Model } from 'mongoose';
import { EmailItemDocument } from '../kanban/schemas/email-item.schema';

interface ScriptOptions {
  regenerateAll: boolean;
  dryRun: boolean;
  userId?: string;
  batchSize: number;
  delay: number;
}

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    regenerateAll: false,
    dryRun: false,
    batchSize: 50,
    delay: 500,
  };

  for (const arg of args) {
    if (arg === '--regenerate-all') {
      options.regenerateAll = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--user-id=')) {
      options.userId = arg.split('=')[1];
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1], 10) || 50;
    } else if (arg.startsWith('--delay=')) {
      options.delay = parseInt(arg.split('=')[1], 10) || 500;
    }
  }

  return options;
}

async function bootstrap() {
  const logger = new Logger('EmbeddingScript');
  const options = parseArgs();

  logger.log('='.repeat(60));
  logger.log('Embedding Generation Script');
  logger.log('='.repeat(60));

  const mode = options.regenerateAll ? 'REGENERATE ALL' : 'NEW ONLY';
  logger.log(`Mode: ${mode}`);
  logger.log(`Options: ${JSON.stringify(options, null, 2)}`);

  if (options.dryRun) {
    logger.warn('DRY RUN MODE - No changes will be made');
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  const kanbanService = app.get(KanbanService);
  const EmailModel = app.get<Model<EmailItemDocument>>('EmailItemModel');

  // Build query based on mode
  const query: any = {};

  if (options.userId) {
    query.userId = options.userId;
    logger.log(`Filtering by user: ${options.userId}`);
  }

  // If not regenerating all, only get emails without embeddings
  if (!options.regenerateAll) {
    query.$or = [{ hasEmbedding: { $exists: false } }, { hasEmbedding: false }];
  }

  // Count total emails
  const totalCount = await EmailModel.countDocuments(query);
  logger.log(`Found ${totalCount} emails to process`);

  if (totalCount === 0) {
    logger.log('No emails to process. Exiting.');
    await app.close();
    return;
  }

  if (options.dryRun) {
    // In dry run, just show statistics
    const allQuery = options.userId ? { userId: options.userId } : {};
    const totalAll = await EmailModel.countDocuments(allQuery);
    const withEmbedding = await EmailModel.countDocuments({
      ...allQuery,
      hasEmbedding: true,
    });
    const withoutEmbedding = totalAll - withEmbedding;

    logger.log('\n--- Statistics ---');
    logger.log(`Total emails: ${totalAll}`);
    logger.log(`With embedding: ${withEmbedding}`);
    logger.log(`Without embedding: ${withoutEmbedding}`);
    logger.log(`Would process: ${totalCount}`);
    logger.log('\nNo changes made (dry run)');

    await app.close();
    return;
  }

  let processed = 0;
  let success = 0;
  let failed = 0;
  const errors: { messageId: string; error: string }[] = [];

  // Process in batches
  let skip = 0;
  while (skip < totalCount) {
    const batch = await EmailModel.find(query)
      .skip(skip)
      .limit(options.batchSize)
      .select('userId messageId subject hasEmbedding')
      .lean();

    if (batch.length === 0) break;

    logger.log(
      `\nProcessing batch ${Math.floor(skip / options.batchSize) + 1}...`,
    );

    for (const email of batch) {
      processed++;
      const progress = `[${processed}/${totalCount}]`;

      try {
        const userId = email.userId.toString();
        await kanbanService.generateAndStoreEmbedding(userId, email.messageId);
        success++;

        const subject = email.subject?.slice(0, 40) || 'No subject';
        logger.log(`${progress} ✓ ${email.messageId} - "${subject}..."`);

        // Rate limit
        if (options.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delay));
        }
      } catch (error: any) {
        failed++;
        const errorMsg = error.message || 'Unknown error';
        errors.push({ messageId: email.messageId, error: errorMsg });
        logger.error(`${progress} ✗ ${email.messageId}: ${errorMsg}`);
      }
    }

    skip += options.batchSize;
  }

  // Print summary
  logger.log('\n' + '='.repeat(60));
  logger.log('SUMMARY');
  logger.log('='.repeat(60));
  logger.log(`Mode: ${mode}`);
  logger.log(`Total processed: ${processed}`);
  logger.log(`Success: ${success}`);
  logger.log(`Failed: ${failed}`);
  if (processed > 0) {
    logger.log(`Success rate: ${((success / processed) * 100).toFixed(1)}%`);
  }

  if (errors.length > 0 && errors.length <= 10) {
    logger.log('\nErrors:');
    errors.forEach((e) => logger.log(`  - ${e.messageId}: ${e.error}`));
  } else if (errors.length > 10) {
    logger.log(`\nFirst 10 errors (${errors.length} total):`);
    errors
      .slice(0, 10)
      .forEach((e) => logger.log(`  - ${e.messageId}: ${e.error}`));
  }

  await app.close();
}

bootstrap().catch((err) => {
  Logger.error('Bootstrap failed', err);
  process.exit(1);
});
