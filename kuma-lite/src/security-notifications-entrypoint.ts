import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { deliverSecurityAlert, type SecurityDeliveryResult } from './security-notifications';

/** Only a service binding targeting this named entrypoint receives this capability. */
export class SecurityNotifications extends WorkerEntrypoint<Env> {
  async sendSecurityAlert(alert: unknown): Promise<SecurityDeliveryResult> {
    return deliverSecurityAlert(this.env, alert);
  }
}
