import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, readPushoverCredentials } from '../src/config';

describe('server host configuration', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('listens on all interfaces by default', () => {
        vi.stubEnv('HOST', '');
        expect(getConfig().host).toBe('0.0.0.0');
    });

    it('accepts an explicit host override', () => {
        vi.stubEnv('HOST', '192.168.1.20');
        expect(getConfig().host).toBe('192.168.1.20');
    });

    it('reads Pushover credentials from a configured file and adds them to secrets', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'ferry-pushover-'));
        const file = path.join(directory, 'pushover.json');
        try {
            expect(readPushoverCredentials(undefined)).toBeNull();
            writeFileSync(file, JSON.stringify({ user: 'user-key', token: 'app-token' }));
            vi.stubEnv('PUSHOVER_CREDENTIAL_FILE', file);
            const config = getConfig();
            expect(config.notifications).toMatchObject({ userKey: 'user-key', appToken: 'app-token' });
            expect(config.secrets).toContain('user-key');
            expect(config.secrets).toContain('app-token');
            writeFileSync(file, JSON.stringify({ user: 'user-key', token: '' }));
            expect(() => readPushoverCredentials(file)).toThrow('nonempty user and token');
            expect(() => readPushoverCredentials(path.join(directory, 'missing.json'))).toThrow('Cannot read');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
