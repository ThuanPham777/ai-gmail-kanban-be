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
  constructor(private readonly kanban: KanbanService) {}

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
    @Query('pageToken') pageToken?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = this.getUserId(req);
    const pageSize = limit ? parseInt(limit, 10) : 20;
    const result = await this.kanban.getBoard(
      userId,
      label,
      pageToken,
      pageSize,
    );
    return { status: 'success', ...result };
  }

  @Get('search')
  async search(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = this.getUserId(req);
    const l = limit ? parseInt(limit, 10) : 50;
    const data = await this.kanban.searchItems(userId, q ?? '', l);
    return { status: 'success', data };
  }

  @Post('search/semantic')
  async semanticSearch(
    @Req() req: Request,
    @Body() body: { query: string; limit?: number },
  ) {
    const userId = this.getUserId(req);
    const data = await this.kanban.semanticSearch(
      userId,
      body.query,
      body.limit ?? 20,
    );
    return { status: 'success', data };
  }

  @Get('search/suggestions')
  async searchSuggestions(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = this.getUserId(req);
    const l = limit ? parseInt(limit, 10) : 5;
    const data = await this.kanban.getSearchSuggestions(userId, q ?? '', l);
    return { status: 'success', data };
  }

  @Post('items/:messageId/generate-embedding')
  async generateEmbedding(
    @Req() req: Request,
    @Param('messageId') messageId: string,
  ) {
    const userId = this.getUserId(req);
    const result = await this.kanban.generateAndStoreEmbedding(
      userId,
      messageId,
    );
    return { status: 'success', data: result };
  }

  @Patch('items/:messageId/status')
  async updateStatus(
    @Req() req: Request,
    @Param('messageId') messageId: string,
    @Body() body: { status: EmailStatus; gmailLabel?: string },
  ) {
    const userId = this.getUserId(req);
    const updated = await this.kanban.updateStatus(
      userId,
      messageId,
      body.status,
      body.gmailLabel,
    );
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
  async summarize(@Req() req: Request, @Param('messageId') messageId: string) {
    const userId = this.getUserId(req);
    const result = await this.kanban.summarize(userId, messageId);
    return { status: 'success', data: result };
  }

  @Get('columns')
  async getColumns(@Req() req: Request) {
    const userId = this.getUserId(req);
    const columns = await this.kanban.getKanbanColumns(userId);
    return { status: 'success', data: columns };
  }

  @Post('columns')
  async updateColumns(@Req() req: Request, @Body() body: { columns: any[] }) {
    const userId = this.getUserId(req);
    const columns = await this.kanban.updateKanbanColumns(userId, body.columns);
    return { status: 'success', data: columns };
  }
}
