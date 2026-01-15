import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

interface SocketWithUser extends Socket {
  userId?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*', // Configure this properly in production
    credentials: true,
  },
  namespace: '/gmail',
})
export class GmailPushGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(GmailPushGateway.name);
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set of socketIds

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  afterInit() {
    this.logger.log('Gmail Push WebSocket Gateway initialized');
  }

  async handleConnection(client: SocketWithUser) {
    try {
      // Extract token from handshake
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(
          `Client ${client.id} connected without token, disconnecting`,
        );
        client.disconnect();
        return;
      }

      // Verify JWT token
      const secret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
      const payload = await this.jwtService.verifyAsync(token, { secret });
      const userId = payload.sub;

      if (!userId) {
        client.disconnect();
        return;
      }

      // Store socket association
      client.userId = userId;
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join user-specific room
      client.join(`user:${userId}`);

      this.logger.log(`Client ${client.id} connected for user ${userId}`);

      // Send confirmation
      client.emit('connected', {
        message: 'Connected to Gmail Push notifications',
        userId,
      });
    } catch (error: any) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: SocketWithUser) {
    const userId = client.userId;
    if (userId) {
      this.userSockets.get(userId)?.delete(client.id);
      if (this.userSockets.get(userId)?.size === 0) {
        this.userSockets.delete(userId);
      }
      this.logger.log(`Client ${client.id} disconnected for user ${userId}`);
    }
  }

  /**
   * Send notification to specific user
   */
  notifyUser(userId: string, data: any) {
    this.server.to(`user:${userId}`).emit('gmail_notification', data);
    this.logger.debug(`Sent notification to user ${userId}`);
  }

  /**
   * Check if user has any active connections
   */
  isUserConnected(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }

  /**
   * Handle ping from client (keep-alive)
   */
  @SubscribeMessage('ping')
  handlePing(client: SocketWithUser): string {
    return 'pong';
  }

  /**
   * Get connected users count (for monitoring)
   */
  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }
}
