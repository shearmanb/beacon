// Pluggable notification channels. Discord is first-class today; email/SMS/push
// are drop-in later by implementing this interface and registering an instance.

import type { Alert } from "@beacon/shared";

export interface NotificationChannel {
  readonly name: string;
  send(siteName: string, alert: Alert): Promise<void>;
}
