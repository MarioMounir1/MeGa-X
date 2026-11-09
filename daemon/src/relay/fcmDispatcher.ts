import { FcmNotificationPayload, FcmPushSender } from './mobileRelayServer';

export interface FcmDispatcherConfig {
  /**
   * Optional Firebase Cloud Messaging HTTP endpoint or custom relay webhook URL.
   */
  webhookUrl?: string;
  /**
   * Optional Bearer / Server token for authenticating with FCM.
   */
  authToken?: string;
  /**
   * Target mobile device registration token or topic (default: 'megax-mobile-controller').
   */
  targetTopicOrToken?: string;
  /**
   * Whether to log push notifications to console when running in local/dry-run mode.
   */
  logToConsole?: boolean;
}

/**
 * Concrete Firebase Cloud Messaging (FCM) Push Dispatcher for MeGa X.
 * Formats interactive approval notifications (APPROVE / ROLLBACK) and dispatches
 * them via HTTP POST when configured, or logs locally in dry-run mode.
 */
export class FcmDispatcher {
  private readonly config: Required<
    Pick<FcmDispatcherConfig, 'targetTopicOrToken' | 'logToConsole'>
  > &
    FcmDispatcherConfig;
  private readonly history: FcmNotificationPayload[] = [];

  constructor(config: FcmDispatcherConfig = {}) {
    this.config = {
      webhookUrl: config.webhookUrl ?? process.env.MEGAX_FCM_WEBHOOK_URL,
      authToken: config.authToken ?? process.env.MEGAX_FCM_AUTH_TOKEN,
      targetTopicOrToken:
        config.targetTopicOrToken ??
        process.env.MEGAX_FCM_TARGET ??
        'megax-mobile-controller',
      logToConsole: config.logToConsole ?? false,
    };
  }

  public getDispatchedHistory(): FcmNotificationPayload[] {
    return [...this.history];
  }

  /**
   * Builds the standard FCM envelope including Android/iOS interactive click actions.
   */
  public buildFcmEnvelope(payload: FcmNotificationPayload): Record<string, unknown> {
    return {
      message: {
        topic: this.config.targetTopicOrToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
        android: {
          priority: 'HIGH',
          notification: {
            click_action: 'MEGAX_APPROVAL_ACTION',
            channel_id: 'megax_security_gate',
          },
        },
        apns: {
          payload: {
            aps: {
              category: 'MEGAX_APPROVAL_CATEGORY',
              'content-available': 1,
            },
          },
        },
      },
    };
  }

  /**
   * Sends the FCM push notification or records it in dry-run mode.
   */
  public async send(payload: FcmNotificationPayload): Promise<void> {
    this.history.push(payload);

    if (this.config.logToConsole) {
      console.log(
        `📲 [FCM Push Dispatched -> ${this.config.targetTopicOrToken}] ${payload.title}: ${payload.body}`
      );
    }

    if (!this.config.webhookUrl) {
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const res = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.buildFcmEnvelope(payload)),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`FCM Dispatch failed (${res.status}): ${errText}`);
    }
  }

  /**
   * Returns a bound FcmPushSender callback ready for MobileRelayServer.
   */
  public createSender(): FcmPushSender {
    return (payload: FcmNotificationPayload) => this.send(payload);
  }
}

