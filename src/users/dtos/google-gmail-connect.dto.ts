import { IsString } from 'class-validator';

export class GoogleGmailConnectDto {
    @IsString()
    code: string;
}
