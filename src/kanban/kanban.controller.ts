import {
    Body,
    Controller,
    Get,
    Patch,
    Post,
    Param,
    Query,
    Req,
    UseGuards,
    BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KanbanService } from './kanban.service';
import { EmailStatus } from './schemas/email-item.chema';

@Controller('api/kanban')
@UseGuards(JwtAuthGuard)
export class KanbanController {
    constructor(private readonly kanban: KanbanService) { }

    private getUserId(req: Request) {
        const u: any = (req as any).user;
        const id = u?.sub ?? u?.userId ?? u?.id ?? u?._id;
        if (!id) throw new BadRequestException('Missing user in request');
        return id;
    }

    @Get('board')
    async getBoard(
        @Req() req: Request,
        @Query('label') label?: string,
    ) {
        const userId = this.getUserId(req);
        const data = await this.kanban.getBoard(userId, label);
        return { status: 'success', data };
    }

    @Patch('items/:messageId/status')
    async updateStatus(
        @Req() req: Request,
        @Param('messageId') messageId: string,
        @Body() body: { status: EmailStatus },
    ) {
        const userId = this.getUserId(req);
        const updated = await this.kanban.updateStatus(userId, messageId, body.status);
        return { status: 'success', data: updated };
    }

    @Post('items/:messageId/snooze')
    async snooze(
        @Req() req: Request,
        @Param('messageId') messageId: string,
        @Body() body: { until: string },
    ) {
        const userId = this.getUserId(req);
        const updated = await this.kanban.snooze(userId, messageId, body.until);
        return { status: 'success', data: updated };
    }

    @Post('items/:messageId/summarize')
    async summarize(
        @Req() req: Request,
        @Param('messageId') messageId: string,
    ) {
        const userId = this.getUserId(req);
        const result = await this.kanban.summarize(userId, messageId);
        return { status: 'success', data: result };
    }
}
