import { Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { AuthModule } from 'src/auth/auth.module';
import { UsersModule } from 'src/users/users.module';

@Module({
    imports: [AuthModule, UsersModule],
    controllers: [MailController],
    providers: [MailService],
})
export class MailModule { }


