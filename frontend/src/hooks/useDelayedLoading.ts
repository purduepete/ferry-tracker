import { useEffect, useState } from 'react';

export function useDelayedLoading(isLoading: boolean, delayMs = 250): boolean {
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (!isLoading) {
            setShow(false);
            return;
        }
        const timer = window.setTimeout(() => setShow(true), delayMs);
        return () => window.clearTimeout(timer);
    }, [isLoading, delayMs]);

    return isLoading && show;
}
