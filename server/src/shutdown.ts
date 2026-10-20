import { existsSync } from 'node:fs';

export function installShutdown(
    shutdown: () => Promise<void>,
    stopFile = process.env.SOLUTIONDEPLOY_STOP_FILE,
    exists: (path: string) => boolean = existsSync
) {
    let completion: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
        if (!completion) {
            completion = Promise.resolve().then(shutdown);
            if (timer) clearInterval(timer);
            const cleanup = () => {
                process.off('SIGINT', request);
                process.off('SIGTERM', request);
            };
            void completion.then(cleanup, cleanup);
        }
        return completion;
    };
    const request = () => {
        void stop().catch((error: unknown) => {
            console.error('Graceful shutdown failed:', error);
            process.exitCode = 1;
        });
    };
    process.on('SIGINT', request);
    process.on('SIGTERM', request);
    if (stopFile) {
        timer = setInterval(() => {
            if (exists(stopFile)) request();
        }, 250);
        timer.unref();
    }
    return stop;
}
