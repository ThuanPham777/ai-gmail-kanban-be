import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KanbanController } from './kanban.controller';
import { KanbanService } from './kanban.service';
import { UsersModule } from '../users/users.module';
import { EmailItem, EmailItemSchema } from './schemas/email-item.schema';
import { KanbanCron } from './kanban.cron';
import { AiModule } from 'src/ai/ai.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailItem.name, schema: EmailItemSchema },
    ]),
    UsersModule,
    AiModule,
  ],
  controllers: [KanbanController],
  providers: [KanbanService, KanbanCron],
  exports: [KanbanService], // Export để GmailPushModule có thể inject
})
export class KanbanModule {}
