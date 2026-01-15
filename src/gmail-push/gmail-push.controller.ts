import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  BadRequestException,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { GmailPushService } from './gmail-push.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserData } from '../common/decorators/current-user.decorator';
import { ApiResponseDto } from '../common/dtos/api-response.dto';
import { GmailPushGateway } from './gmail-push.gateway';

interface PubSubMessage {
  message: {
    data: string; // Base64 encoded JSON
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

@Controller('api/gmail')
export class GmailPushController {
  private readonly logger = new Logger(GmailPushController.name);

  constructor(
    private readonly gmailPushService: GmailPushService,
    private readonly gmailPushGateway: GmailPushGateway,
  ) {}

  /**
   * Start Gmail watch for push notifications
   * User must call this after connecting Gmail
   */
  @Post('watch/start')
  @UseGuards(JwtAuthGuard)
  async startWatch(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<{ historyId: string; expiration: string }>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');

    const result = await this.gmailPushService.startWatch(user.userId);

    return ApiResponseDto.success(
      {
        historyId: result.historyId,
        expiration: result.expiration.toISOString(),
      },
      'Gmail watch started successfully',
    );
  }

  /**
   * Stop Gmail watch for push notifications
   */
  @Post('watch/stop')
  @UseGuards(JwtAuthGuard)
  async stopWatch(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<null>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');

    await this.gmailPushService.stopWatch(user.userId);

    return ApiResponseDto.success(null, 'Gmail watch stopped successfully');
  }

  /**
   * Webhook endpoint for Google Pub/Sub push notifications
   * This endpoint receives notifications from Google Cloud Pub/Sub
   *
   * IMPORTANT: This endpoint should NOT require authentication
   * Google Pub/Sub will send POST requests to this endpoint
   */
  @Post('webhook')
  @HttpCode(200) // Always return 200 to acknowledge receipt
  async handleWebhook(
    @Body() body: PubSubMessage,
  ): Promise<{ status: string }> {
    this.logger.log(`Webhook received: ${JSON.stringify(body)}`);

    try {
      // Validate Pub/Sub message format
      if (!body?.message?.data) {
        this.logger.warn('Invalid Pub/Sub message format');
        return { status: 'invalid' };
      }

      // Decode base64 data
      const decodedData = Buffer.from(body.message.data, 'base64').toString(
        'utf-8',
      );
      const notification = JSON.parse(decodedData);

      this.logger.log(
        `Received Gmail notification for ${notification.emailAddress}, historyId: ${notification.historyId}`,
      );

      // Process the notification
      const result =
        await this.gmailPushService.processNotification(notification);

      if (result) {
        // Always notify connected clients via WebSocket
        // Even if changes.length === 0, frontend should know there's an update
        this.gmailPushGateway.notifyUser(result.userId, {
          type: 'gmail_update',
          changes: result.changes,
          historyId: result.newHistoryId,
        });

        this.logger.log(
          `Processed ${result.changes.length} changes for user ${result.userId}, notified via WebSocket`,
        );
      } else {
        this.logger.warn('No result from processNotification');
      }

      return { status: 'ok' };
    } catch (error: any) {
      this.logger.error(`Error processing webhook: ${error.message}`);
      // Still return 200 to prevent Pub/Sub from retrying
      return { status: 'error' };
    }
  }

  /**
   * Health check for Gmail push service
   */
  @Get('watch/status')
  @UseGuards(JwtAuthGuard)
  async getWatchStatus(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<{ isActive: boolean; expiration?: string }>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');

    // This is a simplified status check
    // In production, you might want to store and check the actual watch status
    return ApiResponseDto.success({
      isActive: true,
      expiration: undefined, // Could be retrieved from user document
    });
  }
}
