import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { useNotifications } from '../useNotifications';

interface NotificationControlProps {
    notifications: ReturnType<typeof useNotifications>;
    kind: 'catch' | 'disruption';
}

export function NotificationControl({ notifications, kind }: NotificationControlProps) {
    const descriptionId = useId();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setOpen(false);
            if (containerRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        };
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('pointerdown', dismiss);
            document.removeEventListener('keydown', escape);
        };
    }, [open]);
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
        <div
            className="notification-control"
            ref={containerRef}
            onMouseLeave={() => {
                if (!containerRef.current?.contains(document.activeElement)) setOpen(false);
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
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
            <button
                type="button"
                className="notification-info"
                ref={triggerRef}
                aria-label="Pushover notification information"
                aria-describedby={descriptionId}
                aria-expanded={open}
                aria-controls={descriptionId}
                onMouseEnter={() => setOpen(true)}
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
            >
                <Info size={14} aria-hidden="true" />
            </button>
            <div id={descriptionId} role="tooltip" className={`notification-description${open ? ' is-open' : ''}`}>
                <strong>Pushover notifications</strong>
                <span>{explanation} Shared across browsers.</span>
                <span className={notifications.error ? 'notification-error' : undefined} role="status">
                    {status}
                </span>
            </div>
        </div>
    );
}
