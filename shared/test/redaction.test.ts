import { describe, expect, it } from 'vitest';
import { pacificParts, redactSecrets } from '../src/index';

const ACCESS_CODE = '11112222-3333-4444-5555-666677778888';

describe('redactSecrets', () => {
    it('strips the configured access code', () => {
        const message = `WSDOT returned HTTP 500 for apiaccesscode ${ACCESS_CODE}`;
        expect(redactSecrets(message, ACCESS_CODE)).not.toContain(ACCESS_CODE);
    });

    it('strips the query parameter even without the configured code', () => {
        const url = `https://www.wsdot.wa.gov/Ferries/API/Vessels/rest/vessellocations?apiaccesscode=${ACCESS_CODE}`;
        const redacted = redactSecrets(url);

        expect(redacted).not.toContain(ACCESS_CODE);
        expect(redacted).toBe(
            'https://www.wsdot.wa.gov/Ferries/API/Vessels/rest/vessellocations?apiaccesscode=[redacted]'
        );
    });

    it('strips the traveler information spelling of the parameter', () => {
        const url = `https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode=${ACCESS_CODE}`;
        expect(redactSecrets(url)).toBe(
            'https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode=[redacted]'
        );
    });

    it('strips the code from an Error stack', () => {
        const error = new Error(`fetch failed for https://example.com/x?apiaccesscode=${ACCESS_CODE}&foo=1`);
        const redacted = redactSecrets(error, ACCESS_CODE);

        expect(redacted).not.toContain(ACCESS_CODE);
        expect(redacted).toContain('&foo=1');
    });

    it('handles objects and empty values', () => {
        expect(redactSecrets({ url: `?apiaccesscode=${ACCESS_CODE}` })).not.toContain(ACCESS_CODE);
        expect(redactSecrets(null)).toBe('');
    });
});

describe('pacificParts', () => {
    it('formats midnight as hour 0, not 24', () => {
        const parts = pacificParts('2026-09-01T07:00:00.000Z');

        expect(parts?.hourLocal).toBe(0);
        expect(parts?.serviceDate).toBe('2026-09-01');
    });

    it('keeps a late evening sailing on its own service date', () => {
        const parts = pacificParts('2026-09-02T06:30:00.000Z');

        expect(parts?.serviceDate).toBe('2026-09-01');
        expect(parts?.hourLocal).toBe(23);
        expect(parts?.weekday).toBe(2);
    });

    it('follows the spring forward transition', () => {
        const before = pacificParts('2026-03-08T09:30:00.000Z');
        const after = pacificParts('2026-03-08T10:30:00.000Z');

        expect(before?.hourLocal).toBe(1);
        expect(after?.hourLocal).toBe(3);
    });

    it('returns null for an unparsable value', () => {
        expect(pacificParts('not a date')).toBeNull();
    });
});
