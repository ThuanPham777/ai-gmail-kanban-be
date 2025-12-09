import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

@Injectable()
export class GoogleAuthService {
    private readonly clientId: string;
    private readonly clientSecret: string;

    constructor(private readonly config: ConfigService) {
        this.clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
        this.clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');
    }

    private createOAuthClient() {
        return new OAuth2Client({
            clientId: this.clientId,
            clientSecret: this.clientSecret,
        });
    }

    // Flow 1: One Tap / ID token login
    async verifyCredential(credential: string): Promise<TokenPayload> {
        const client = new OAuth2Client(this.clientId);
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: this.clientId,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) {
            throw new UnauthorizedException('Invalid Google credential');
        }
        return payload;
    }

    // Flow 2: GIS Code Client for Gmail scopes
    async exchangeCodeForTokens(code: string) {
        if (!code) throw new BadRequestException('Missing authorization code');

        const client = this.createOAuthClient();

        const { tokens } = await client.getToken({
            code,
            redirect_uri: 'postmessage',
        });

        if (!tokens.id_token) {
            throw new BadRequestException('Missing id_token from Google');
        }

        const ticket = await client.verifyIdToken({
            idToken: tokens.id_token,
            audience: this.clientId,
        });

        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) {
            throw new UnauthorizedException('Invalid Google identity in token');
        }

        return { identity: payload, tokens };
    }
}
