import { useDelayedLoading } from '../hooks/useDelayedLoading';

export function LoadingSpinner({ isLoading, label = 'Loading ferry data' }: { isLoading: boolean; label?: string }) {
    const show = useDelayedLoading(isLoading);
    if (!show) return null;

    return (
        <div className="loading-spinner" role="status" aria-label={label}>
            <span className="loading-spinner-ring" aria-hidden="true" />
            <span className="sr-only">{label}</span>
        </div>
    );
}
