import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KanbanService } from './kanban.service';

@Injectable()
export class KanbanCron {
  constructor(private readonly kanban: KanbanService) {}

  // chạy mỗi 5 phút để wake snoozed emails (reduced frequency to save memory)
  @Cron('*/5 * * * *')
  async wake() {
    // Allow disabling cron via env for constrained hosts
    if (process.env.DISABLE_CRON === 'true') {
      console.log('[Cron] Disabled via DISABLE_CRON=true');
      return;
    }

    try {
      const result = await this.kanban.wakeExpiredSnoozed();
      if (result.woke > 0) {
        console.log(`[Cron] Woke ${result.woke} snoozed emails`);
      }
    } catch (err) {
      console.error('[Cron] Failed to wake snoozed emails:', err);
    }
  }
}
