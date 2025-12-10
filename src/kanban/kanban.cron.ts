import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KanbanService } from './kanban.service';

@Injectable()
export class KanbanCron {
    constructor(private readonly kanban: KanbanService) { }

    // chạy mỗi phút để wake snoozed emails
    @Cron('*/1 * * * *')
    async wake() {
        await this.kanban.wakeExpiredSnoozed();
    }
}