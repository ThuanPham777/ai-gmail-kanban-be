import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MailService } from './mail.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserData } from '../common/decorators/current-user.decorator';
import {
  SendEmailDto,
  ReplyEmailDto,
  ModifyEmailDto,
  ForwardEmailDto,
} from './dtos/request';
import {
  MailboxesResponseDto,
  EmailListResponseDto,
  EmailDetailResponseDto,
  SendEmailResponseDto,
} from './dtos/response';
import { ApiResponseDto } from '../common/dtos/api-response.dto';

@Controller('api')
@UseGuards(JwtAuthGuard)
export class MailController {
  constructor(private readonly mail: MailService) {}

  @Get('mailboxes')
  async getMailboxes(
    @CurrentUser() user: CurrentUserData,
  ): Promise<ApiResponseDto<MailboxesResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const mailboxes = await this.mail.getMailboxes(user.userId);
    const response = MailboxesResponseDto.create(mailboxes);
    return ApiResponseDto.success(response);
  }

  @Get('mailboxes/:id/emails')
  async getMailboxEmails(
    @CurrentUser() user: CurrentUserData,
    @Param('id') mailboxId: string,
    @Query('page') page?: string,
    @Query('limit') limit = '20',
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<ApiResponseDto<EmailListResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const limitNum = Number(limit) || Number(pageSize) || 20;

    // If pageToken exists, use token-based pagination
    if (pageToken) {
      const result = await this.mail.getEmailsByMailboxWithToken(
        user.userId,
        mailboxId,
        pageToken,
        limitNum,
      );
      const response = EmailListResponseDto.create(result);
      return ApiResponseDto.success(response);
    }

    // Fallback: page-based (for backward compatibility)
    const pageNum = Number(page) || 1;
    const result = await this.mail.getEmailsByMailbox(
      user.userId,
      mailboxId,
      pageNum,
      limitNum,
    );
    const response = EmailListResponseDto.create(result);
    return ApiResponseDto.success(response);
  }

  @Get('emails/:id')
  async getEmailDetail(
    @CurrentUser() user: CurrentUserData,
    @Param('id') emailId: string,
  ): Promise<ApiResponseDto<EmailDetailResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const email = await this.mail.getEmailById(user.userId, emailId);
    const response = EmailDetailResponseDto.fromEmailDetail(email);
    return ApiResponseDto.success(response);
  }

  @Post('emails/send')
  async sendEmail(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SendEmailDto,
  ): Promise<ApiResponseDto<SendEmailResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    const messageId = await this.mail.sendEmail(user.userId, dto);
    const response = SendEmailResponseDto.create(messageId);
    return ApiResponseDto.success(response, 'Email sent successfully');
  }

  @Post('emails/:id/reply')
  async replyEmail(
    @CurrentUser() user: CurrentUserData,
    @Param('id') emailId: string,
    @Body() dto: ReplyEmailDto,
  ): Promise<ApiResponseDto<SendEmailResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    if (!dto.body?.trim())
      throw new BadRequestException('Reply body is required');

    const messageId = await this.mail.replyToEmail(
      user.userId,
      emailId,
      dto.body,
      dto.replyAll,
    );
    const response = SendEmailResponseDto.create(messageId);
    return ApiResponseDto.success(response, 'Reply sent successfully');
  }

  @Post('emails/:id/forward')
  async forwardEmail(
    @CurrentUser() user: CurrentUserData,
    @Param('id') emailId: string,
    @Body() dto: ForwardEmailDto,
  ): Promise<ApiResponseDto<SendEmailResponseDto>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');

    const messageId = await this.mail.forwardEmail(user.userId, emailId, dto);
    const response = SendEmailResponseDto.create(messageId);
    return ApiResponseDto.success(response, 'Email forwarded successfully');
  }

  @Post('emails/:id/modify')
  async modifyEmail(
    @CurrentUser() user: CurrentUserData,
    @Param('id') emailId: string,
    @Body() dto: ModifyEmailDto,
  ): Promise<ApiResponseDto<null>> {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    await this.mail.modifyEmail(user.userId, emailId, dto);
    return ApiResponseDto.success(null, 'Email modified successfully');
  }

  @Get('attachments/:id')
  async getAttachment(
    @CurrentUser() user: CurrentUserData,
    @Param('id') attachmentId: string,
    @Query('emailId') emailId: string,
    @Res() res: Response,
  ) {
    if (!user?.userId) throw new BadRequestException('User not authenticated');
    if (!emailId)
      throw new BadRequestException('emailId query parameter is required');

    const attachment = await this.mail.getAttachment(
      user.userId,
      emailId,
      attachmentId,
    );

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${attachment.filename}"`,
    );
    return res.send(attachment.data);
  }
}
