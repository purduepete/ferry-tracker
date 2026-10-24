export type NotificationScope = `catch:${number}:${number}` | 'disruption';

export interface CatchNotificationSettings {
    trafficMinutes: number;
    queueMinutes: number;
}

export interface DisruptionNotificationSettings {
    disruptionLeadMinutes: number;
    disruptionDurationMinutes: number;
}

export type NotificationSettings = CatchNotificationSettings | DisruptionNotificationSettings;
export type NotificationDeliveryStatus = 'idle' | 'armed' | 'accepted' | 'failed' | 'uncertain' | 'missed';

export interface NotificationSubscription {
    scope: NotificationScope;
    enabled: boolean;
    settings: NotificationSettings;
    status: NotificationDeliveryStatus;
    targetAt: string | null;
    lastEventAt: string | null;
    lastError: string | null;
}

export interface NotificationStatus {
    available: boolean;
    subscription: NotificationSubscription | null;
}

export interface NotificationUpdate {
    scope: NotificationScope;
    enabled: boolean;
    settings: NotificationSettings;
}
