import { createHash } from 'node:crypto';

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/** Stable stringify so key order in the WSDOT payload never changes a hash. */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
