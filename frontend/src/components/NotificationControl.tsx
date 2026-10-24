import { useId } from 'react';
import { InfoBox } from './InfoBox';
import type { useNotifications } from '../useNotifications';

interface NotificationControlProps {
    notifications: ReturnType<typeof useNotifications>;
    kind: 'catch' | 'disruption';
}

export function NotificationControl({ notifications, kind }: NotificationControlProps) {
    const descriptionId = useId();
    const explanation =
        kind === 'catch'
            ? 'Leave-by alert for each sailing on this route, using the delay estimate when available.'
            : 'Alerts when offload traffic starts and clears. Overlapping offloads count as one episode.';
    const status = notifications.error
        ? notifications.error
        : notifications.loading
          ? 'Checking notification availability...'
          : !notifications.available
            ? 'Pushover is unavailable. Configure the server credentials to enable alerts.'
            : notifications.busy
              ? 'Saving notification preferences...'
              : notifications.uncertain
                ? 'Delivery could not be confirmed. This event will not be sent again.'
                : notifications.enabled
                  ? 'Monitoring on the server, including when this page is closed.'
                  : 'Notifications are off.';
    return (
        <div className="notification-control">
            <label className="notification-label">
                <input
                    type="checkbox"
                    checked={notifications.enabled}
                    disabled={notifications.disabled}
                    aria-describedby={descriptionId}
                    onChange={(event) => notifications.setEnabled(event.target.checked)}
                />
                <span>Notify via Pushover</span>
            </label>
            <InfoBox
                heading="Pushover notifications"
                label="Pushover notification information"
                descriptionId={descriptionId}
            >
                <span>{explanation} Shared across browsers.</span>
                <span className={notifications.error ? 'notification-error' : undefined} role="status">
                    {status}
                </span>
            </InfoBox>
        </div>
    );
}
