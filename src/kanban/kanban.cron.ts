import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KanbanService } from './kanban.service';

@Injectable()
export class KanbanCron {
  private readonly logger = new Logger(KanbanCron.name);

  constructor(private readonly kanban: KanbanService) {}

  // chạy mỗi 1 phút để wake snoozed emails (reduced frequency to save memory)
  @Cron('*/1 * * * *')
  async wake() {
    try {
      const result = await this.kanban.wakeExpiredSnoozed();
      if (result.woke > 0) {
        this.logger.log(`Woke ${result.woke} snoozed emails`);
      }
    } catch (err) {
      this.logger.error('Failed to wake snoozed emails:', err);
    }
  }
}
