import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { KanbanModule } from '../kanban/kanban.module';
import { GmailPushService } from './gmail-push.service';
import { GmailPushController } from './gmail-push.controller';
import { GmailPushGateway } from './gmail-push.gateway';
import { GmailPushCron } from './gmail-push.cron';

@Module({
  imports: [UsersModule, AuthModule, KanbanModule],
  controllers: [GmailPushController],
  providers: [GmailPushService, GmailPushGateway, GmailPushCron],
  exports: [GmailPushService, GmailPushGateway],
})
export class GmailPushModule {}
