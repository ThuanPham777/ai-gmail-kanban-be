import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GmailPushService } from './gmail-push.service';

@Injectable()
export class GmailPushCron {
  private readonly logger = new Logger(GmailPushCron.name);

  constructor(private readonly gmailPushService: GmailPushService) {}

  /**
   * Renew Gmail watches every 6 hours
   * Gmail watch expires after 7 days, so renewing every 6 hours ensures
   * we never miss notifications
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async renewGmailWatches() {
    this.logger.log('Starting Gmail watch renewal cron job');

    try {
      await this.gmailPushService.renewExpiringWatches();
      this.logger.log('Gmail watch renewal completed');
    } catch (error: any) {
      this.logger.error(`Gmail watch renewal failed: ${error.message}`);
    }
  }
}
