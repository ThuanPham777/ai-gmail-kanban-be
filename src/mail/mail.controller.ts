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

@Controller('api')
@UseGuards(JwtAuthGuard)
export class MailController {
    constructor(private readonly mail: MailService) { }

    @Get('mailboxes')
    async getMailboxes(): Promise<any> {
        const mailboxes = await this.mail.getMailboxes();
        return {
            status: 'success',
            data: mailboxes,
        };
    }

    @Get('mailboxes/:id/emails')
    async getMailboxEmails(
        @Param('id') mailboxId: string,
        @Query('page') page = '1',
        @Query('limit') limit = '20',
        @Query('pageSize') pageSize?: string,
    ): Promise<any> {
        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || Number(pageSize) || 20;
        const result = await this.mail.getEmailsByMailbox(mailboxId, pageNum, limitNum);
        return {
            status: 'success',
            ...result,
        };
    }

    @Get('emails/:id')
    async getEmailDetail(@Param('id') emailId: string): Promise<any> {
        const email = await this.mail.getEmailById(emailId);
        return {
            status: 'success',
            data: email,
        };
    }

    @Post('emails/send')
    async sendEmail(
        @Body() body: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
    ) {
        const messageId = await this.mail.sendEmail(body);
        return {
            status: 'success',
            message: 'Email sent successfully',
            messageId,
        };
    }

    @Post('emails/:id/reply')
    async replyEmail(
        @Param('id') emailId: string,
        @Body() body: { body: string; replyAll?: boolean },
    ) {
        if (!body.body?.trim()) {
            throw new BadRequestException('Reply body is required');
        }
        const messageId = await this.mail.replyToEmail(emailId, body.body, body.replyAll);
        return {
            status: 'success',
            message: 'Reply sent successfully',
            messageId,
        };
    }

    @Post('emails/:id/modify')
    async modifyEmail(
        @Param('id') emailId: string,
        @Body() body: {
            markRead?: boolean;
            markUnread?: boolean;
            star?: boolean;
            unstar?: boolean;
            delete?: boolean;
        },
    ) {
        await this.mail.modifyEmail(emailId, body);
        return {
            status: 'success',
            message: 'Email modified successfully',
        };
    }

    @Get('attachments/:id')
    async getAttachment(
        @Param('id') attachmentId: string,
        @Query('emailId') emailId: string,
        @Res() res: Response,
    ) {
        if (!emailId) {
            throw new BadRequestException('emailId query parameter is required');
        }

        const attachment = await this.mail.getAttachment(emailId, attachmentId);

        res.setHeader('Content-Type', attachment.mimeType);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${attachment.filename}"`
        );

        // ✅ Gửi buffer thẳng ra response
        return res.send(attachment.data);
    }
}


