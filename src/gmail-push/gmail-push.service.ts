import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, gmail_v1 } from 'googleapis';
import { UsersService } from '../users/users.service';

export interface GmailHistoryChange {
  type: 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';
  messageId: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailNotificationPayload {
  emailAddress: string;
  historyId: string;
}

@Injectable()
export class GmailPushService {
  private readonly logger = new Logger(GmailPushService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Get Gmail OAuth2 client for a user
   */
  private async getGmailClient(userId: string): Promise<gmail_v1.Gmail> {
    const { refreshToken } =
      await this.usersService.getGmailRefreshToken(userId);

    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });

    return google.gmail({ version: 'v1', auth: oAuth2Client });
  }

  /**
   * Start watching Gmail mailbox for push notifications
   * Gmail Watch expires after 7 days, need to renew periodically
   */
  async startWatch(userId: string): Promise<{
    historyId: string;
    expiration: Date;
  }> {
    const gmail = await this.getGmailClient(userId);
    const topicName = this.config.getOrThrow<string>('GMAIL_PUBSUB_TOPIC');

    try {
      const response = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName,
          labelIds: ['INBOX'], // Watch INBOX changes
          labelFilterBehavior: 'include',
        },
      });

      const historyId = response.data.historyId!;
      // Expiration is in milliseconds
      const expirationMs = parseInt(response.data.expiration!, 10);
      const expiration = new Date(expirationMs);

      // Save watch data to user document
      await this.usersService.updateGmailWatch(userId, {
        historyId,
        watchExpiration: expiration,
      });

      this.logger.log(
        `Started Gmail watch for user ${userId}, expires at ${expiration.toISOString()}`,
      );

      return { historyId, expiration };
    } catch (error: any) {
      this.logger.error(
        `Failed to start Gmail watch for user ${userId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Stop watching Gmail mailbox
   */
  async stopWatch(userId: string): Promise<void> {
    try {
      const gmail = await this.getGmailClient(userId);
      await gmail.users.stop({ userId: 'me' });

      // Clear watch data
      await this.usersService.updateGmailWatch(userId, {
        historyId: '',
        watchExpiration: new Date(0),
      });

      this.logger.log(`Stopped Gmail watch for user ${userId}`);
    } catch (error: any) {
      this.logger.error(
        `Failed to stop Gmail watch for user ${userId}: ${error.message}`,
      );
    }
  }

  /**
   * Process Pub/Sub notification and get history changes
   */
  async processNotification(notification: GmailNotificationPayload): Promise<{
    userId: string;
    changes: GmailHistoryChange[];
    newHistoryId: string;
  } | null> {
    const { emailAddress, historyId: newHistoryId } = notification;

    // Find user by email
    const user = await this.usersService.findByEmailWithGmail(emailAddress);
    if (!user || !user.gmail?.refreshToken) {
      this.logger.warn(`No user found for email: ${emailAddress}`);
      return null;
    }

    const userId = (user as any)._id.toString();
    const startHistoryId = user.gmail.historyId;

    if (!startHistoryId) {
      // First notification, just update historyId
      await this.usersService.updateGmailHistoryId(userId, newHistoryId);
      this.logger.log(
        `First notification for user ${userId}, set historyId to ${newHistoryId}`,
      );
      return { userId, changes: [], newHistoryId };
    }

    try {
      const gmail = await this.getGmailClient(userId);
      const changes = await this.getHistoryChanges(
        gmail,
        startHistoryId,
        newHistoryId,
      );

      // Update historyId after processing
      await this.usersService.updateGmailHistoryId(userId, newHistoryId);

      return { userId, changes, newHistoryId };
    } catch (error: any) {
      // If historyId is too old (expired), reset and start fresh
      if (error.code === 404 || error.message?.includes('historyId')) {
        this.logger.warn(
          `History expired for user ${userId}, resetting historyId`,
        );
        await this.usersService.updateGmailHistoryId(userId, newHistoryId);
        return { userId, changes: [], newHistoryId };
      }
      throw error;
    }
  }

  /**
   * Get history changes between two historyIds
   */
  private async getHistoryChanges(
    gmail: gmail_v1.Gmail,
    startHistoryId: string,
    endHistoryId: string,
  ): Promise<GmailHistoryChange[]> {
    const changes: GmailHistoryChange[] = [];
    let pageToken: string | undefined;

    do {
      const response = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: [
          'messageAdded',
          'messageDeleted',
          'labelAdded',
          'labelRemoved',
        ],
        pageToken,
      });

      const history = response.data.history || [];

      for (const h of history) {
        // Messages added
        if (h.messagesAdded) {
          for (const msg of h.messagesAdded) {
            if (msg.message?.id) {
              changes.push({
                type: 'messageAdded',
                messageId: msg.message.id,
                threadId: msg.message.threadId,
                labelIds: msg.message.labelIds || [],
              });
            }
          }
        }

        // Messages deleted
        if (h.messagesDeleted) {
          for (const msg of h.messagesDeleted) {
            if (msg.message?.id) {
              changes.push({
                type: 'messageDeleted',
                messageId: msg.message.id,
                threadId: msg.message.threadId,
              });
            }
          }
        }

        // Labels added
        if (h.labelsAdded) {
          for (const msg of h.labelsAdded) {
            if (msg.message?.id) {
              changes.push({
                type: 'labelAdded',
                messageId: msg.message.id,
                threadId: msg.message.threadId,
                labelIds: msg.labelIds || [],
              });
            }
          }
        }

        // Labels removed
        if (h.labelsRemoved) {
          for (const msg of h.labelsRemoved) {
            if (msg.message?.id) {
              changes.push({
                type: 'labelRemoved',
                messageId: msg.message.id,
                threadId: msg.message.threadId,
                labelIds: msg.labelIds || [],
              });
            }
          }
        }
      }

      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    this.logger.debug(
      `Found ${changes.length} changes between historyId ${startHistoryId} and ${endHistoryId}`,
    );

    return changes;
  }

  /**
   * Renew watch for all users with expiring watches
   * Called by cron job
   */
  async renewExpiringWatches(): Promise<void> {
    // Renew watches expiring in the next 24 hours
    const expirationThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const users =
      await this.usersService.findUsersWithExpiringWatch(expirationThreshold);

    this.logger.log(`Found ${users.length} users with expiring Gmail watches`);

    for (const user of users) {
      try {
        const userId = (user as any)._id.toString();
        await this.startWatch(userId);
        this.logger.log(`Renewed Gmail watch for user ${userId}`);
      } catch (error: any) {
        this.logger.error(
          `Failed to renew watch for user ${user.email}: ${error.message}`,
        );
      }
    }
  }
}
