import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KanbanService } from './kanban.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserData } from '../common/decorators/current-user.decorator';
import {
  UpdateStatusDto,
  SnoozeDto,
  ValidateLabelDto,
  SemanticSearchDto,
  UpdateColumnsDto,
} from './dtos/request';
import {
  KanbanBoardResponseDto,
  GmailLabelsResponseDto,
  ValidateLabelResponseDto,
  SearchResponseDto,
  SearchSuggestionsResponseDto,
  KanbanColumnsResponseDto,
  KanbanItemResponseDto,
} from './dtos/response';
import { ApiResponseDto } from '../common/dtos/api-response.dto';

@Controller('api/kanban')
@UseGuards(JwtAuthGuard)
export class KanbanController {
  constructor(private readonly kanban: KanbanService) {}

  @Get('board')
  async getBoard(
    @CurrentUser() user: CurrentUserData,
    @Query('pageToken') pageToken?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponseDto<KanbanBoardResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const pageSize = limit ? parseInt(limit, 10) : 20;
    const result = await this.kanban.getBoard(user.userId, pageToken, pageSize);
    const response = KanbanBoardResponseDto.create(result);
    return ApiResponseDto.success(response);
  }

  @Get('gmail-labels')
  async getGmailLabels(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<GmailLabelsResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const labels = await this.kanban.getAvailableGmailLabels(user.userId);
    const response = GmailLabelsResponseDto.create(labels);
    return ApiResponseDto.success(response);
  }

  @Post('validate-label')
  async validateLabel(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ValidateLabelDto,
  ): Promise<ApiResponseDto<ValidateLabelResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const result = await this.kanban.validateGmailLabel(
      user.userId,
      dto.labelName,
    );
    const response = ValidateLabelResponseDto.create(result);
    return ApiResponseDto.success(response);
  }

  @Get('search')
  async search(
    @CurrentUser() user: CurrentUserData,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponseDto<SearchResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const l = limit ? parseInt(limit, 10) : 50;
    const data = await this.kanban.searchItems(user.userId, q ?? '', l);
    const response = SearchResponseDto.create(data);
    return ApiResponseDto.success(response);
  }

  @Post('search/semantic')
  async semanticSearch(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SemanticSearchDto,
  ): Promise<ApiResponseDto<SearchResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const data = await this.kanban.semanticSearch(
      user.userId,
      dto.query,
      dto.limit ?? 20,
    );
    const response = SearchResponseDto.create(data);
    return ApiResponseDto.success(response);
  }

  @Get('search/suggestions')
  async searchSuggestions(
    @CurrentUser() user: CurrentUserData,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponseDto<SearchSuggestionsResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const l = limit ? parseInt(limit, 10) : 5;
    const data = await this.kanban.getSearchSuggestions(
      user.userId,
      q ?? '',
      l,
    );
    const response = SearchSuggestionsResponseDto.create(data);
    return ApiResponseDto.success(response);
  }

  @Post('items/:messageId/generate-embedding')
  async generateEmbedding(
    @CurrentUser() user: CurrentUserData,
    @Param('messageId') messageId: string,
  ): Promise<ApiResponseDto<any>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const result = await this.kanban.generateAndStoreEmbedding(
      user.userId,
      messageId,
    );
    return ApiResponseDto.success(result);
  }

  @Patch('items/:messageId/status')
  async updateStatus(
    @CurrentUser() user: CurrentUserData,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateStatusDto,
  ): Promise<ApiResponseDto<KanbanItemResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const updated = await this.kanban.updateStatus(
      user.userId,
      messageId,
      dto.status,
      dto.gmailLabel,
    );
    const response = KanbanItemResponseDto.fromEmailItem(updated);
    return ApiResponseDto.success(response);
  }

  @Post('items/:messageId/snooze')
  async snooze(
    @CurrentUser() user: CurrentUserData,
    @Param('messageId') messageId: string,
    @Body() dto: SnoozeDto,
  ): Promise<ApiResponseDto<KanbanItemResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const updated = await this.kanban.snooze(user.userId, messageId, dto.until);
    const response = KanbanItemResponseDto.fromEmailItem(updated);
    return ApiResponseDto.success(response);
  }

  @Post('items/:messageId/summarize')
  async summarize(
    @CurrentUser() user: CurrentUserData,
    @Param('messageId') messageId: string,
  ): Promise<ApiResponseDto<any>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const result = await this.kanban.summarize(user.userId, messageId);
    return ApiResponseDto.success(result);
  }

  @Get('columns')
  async getColumns(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<KanbanColumnsResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const columns = await this.kanban.getKanbanColumns(user.userId);
    const response = KanbanColumnsResponseDto.create(columns);
    return ApiResponseDto.success(response);
  }

  @Post('columns')
  async updateColumns(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateColumnsDto,
  ): Promise<ApiResponseDto<KanbanColumnsResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const columns = await this.kanban.updateKanbanColumns(
      user.userId,
      dto.columns,
    );
    const response = KanbanColumnsResponseDto.create(columns);
    return ApiResponseDto.success(response);
  }

  @Post('columns/:columnId/sync')
  async syncColumn(
    @CurrentUser() user: CurrentUserData,
    @Param('columnId') columnId: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponseDto<any>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');

    // Get column config to find Gmail label
    const columns = await this.kanban.getKanbanColumns(user.userId);
    const column = columns.find((c) => c.id === columnId);

    if (!column) {
      throw new BadRequestException(`Column "${columnId}" not found`);
    }

    if (!column.gmailLabel) {
      return ApiResponseDto.success({
        synced: 0,
        message: 'Column has no Gmail label mapped',
      });
    }

    const maxResults = limit ? parseInt(limit, 10) : 10;
    const result = await this.kanban.syncGmailLabelToColumn(
      user.userId,
      columnId,
      column.gmailLabel,
      maxResults,
    );

    return ApiResponseDto.success(result);
  }
}
