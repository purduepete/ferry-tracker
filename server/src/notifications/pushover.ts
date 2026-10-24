export interface PushResult {
    status: 'accepted' | 'failed' | 'uncertain';
    retryAfterMs?: number;
}
export class PushoverSender {
    constructor(
        private readonly appToken: string,
        private readonly userKey: string,
        private readonly request: typeof fetch = fetch
    ) {}
    async send(title: string, message: string): Promise<PushResult> {
        try {
            const response = await this.request('https://api.pushover.net/1/messages.json', {
                method: 'POST',
                body: new URLSearchParams({
                    token: this.appToken,
                    user: this.userKey,
                    title: title.slice(0, 250),
                    message: message.slice(0, 1024),
                }),
                signal: AbortSignal.timeout(10_000),
            });
            const body = (await response.json()) as { status?: unknown };
            if (response.ok && body.status === 1) return { status: 'accepted' };
            // A confirmed rejection is safe to retry once. A 5xx or malformed response may
            // follow delivery and must remain uncertain.
            if (response.status === 429 && body.status === 0) {
                const header = response.headers.get('retry-after');
                const seconds = Number(header);
                const delay =
                    header && Number.isFinite(seconds)
                        ? seconds * 1000
                        : header
                          ? Date.parse(header) - Date.now()
                          : 30_000;
                return {
                    status: 'failed',
                    retryAfterMs: Math.max(15_000, Math.min(120_000, Number.isFinite(delay) ? delay : 30_000)),
                };
            }
            if (response.status >= 500) return { status: 'uncertain' };
            return { status: body.status === 0 ? 'failed' : 'uncertain' };
        } catch {
            return { status: 'uncertain' };
        }
    }
}
