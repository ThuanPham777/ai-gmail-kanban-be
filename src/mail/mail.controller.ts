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
  Req,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { MailService } from './mail.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@Controller('api')
@UseGuards(JwtAuthGuard)
export class MailController {
  constructor(private readonly mail: MailService) {}

  private getUserId(req: Request) {
    const u: any = (req as any).user;
    const id = u?.sub ?? u?.userId ?? u?.id ?? u?._id;
    if (!id) {
      throw new BadRequestException('Missing user in request');
    }
    return id;
  }

  @Get('mailboxes')
  async getMailboxes(@Req() req: Request): Promise<any> {
    const userId = this.getUserId(req);
    const mailboxes = await this.mail.getMailboxes(userId);
    return { status: 'success', data: mailboxes };
  }

  @Get('mailboxes/:id/emails')
  async getMailboxEmails(
    @Req() req: Request,
    @Param('id') mailboxId: string,
    @Query('page') page?: string,
    @Query('limit') limit = '20',
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<any> {
    const userId = this.getUserId(req);
    const limitNum = Number(limit) || Number(pageSize) || 20;

    // Nếu có pageToken, dùng nó thay vì page number
    if (pageToken) {
      const result = await this.mail.getEmailsByMailboxWithToken(
        userId,
        mailboxId,
        pageToken,
        limitNum,
      );
      return { status: 'success', ...result };
    }

    // Fallback: page-based (for backward compatibility)
    const pageNum = Number(page) || 1;
    const result = await this.mail.getEmailsByMailbox(
      userId,
      mailboxId,
      pageNum,
      limitNum,
    );
    return { status: 'success', ...result };
  }

  @Get('emails/:id')
  async getEmailDetail(
    @Req() req: Request,
    @Param('id') emailId: string,
  ): Promise<any> {
    const userId = this.getUserId(req);
    const email = await this.mail.getEmailById(userId, emailId);
    return { status: 'success', data: email };
  }

  @Post('emails/send')
  async sendEmail(
    @Req() req: Request,
    @Body()
    body: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
    },
  ) {
    const userId = this.getUserId(req);
    const messageId = await this.mail.sendEmail(userId, body);
    return { status: 'success', message: 'Email sent successfully', messageId };
  }

  @Post('emails/:id/reply')
  async replyEmail(
    @Req() req: Request,
    @Param('id') emailId: string,
    @Body() body: { body: string; replyAll?: boolean },
  ) {
    if (!body.body?.trim())
      throw new BadRequestException('Reply body is required');
    const userId = this.getUserId(req);

    const messageId = await this.mail.replyToEmail(
      userId,
      emailId,
      body.body,
      body.replyAll,
    );
    return { status: 'success', message: 'Reply sent successfully', messageId };
  }

  @Post('emails/:id/modify')
  async modifyEmail(
    @Req() req: Request,
    @Param('id') emailId: string,
    @Body()
    body: {
      markRead?: boolean;
      markUnread?: boolean;
      star?: boolean;
      unstar?: boolean;
      delete?: boolean;
    },
  ) {
    const userId = this.getUserId(req);
    await this.mail.modifyEmail(userId, emailId, body);
    return { status: 'success', message: 'Email modified successfully' };
  }

  @Get('attachments/:id')
  async getAttachment(
    @Req() req: Request,
    @Param('id') attachmentId: string,
    @Query('emailId') emailId: string,
    @Res() res: Response,
  ) {
    if (!emailId)
      throw new BadRequestException('emailId query parameter is required');
    const userId = this.getUserId(req);

    const attachment = await this.mail.getAttachment(
      userId,
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
