import { describe, expect, it } from 'vitest';
import {
    cameraImageUrl,
    isFerryCamera,
    parseWsdotDate,
    plainText,
    spaceCount,
    terminalBasicSchema,
} from '../src/wsdot';

describe('alert text', () => {
    it('drops markup and keeps the words readable', () => {
        expect(plainText('<p>The 4:40 sailing is <b>cancelled</b>.</p><p>Expect crowding.</p>')).toBe(
            'The 4:40 sailing is cancelled. Expect crowding.'
        );
    });

    it('turns a line break into a space rather than gluing two sentences together', () => {
        expect(plainText('Terminal closed.<br/>Use Edmonds.')).toBe('Terminal closed. Use Edmonds.');
    });

    it('decodes entities but never re-creates a tag the renderer would trust', () => {
        // The result is plain text that React escapes, so a smuggled tag stays inert.
        expect(plainText('Fares &amp; reservations')).toBe('Fares & reservations');
        expect(plainText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
    });

    it('returns null for markup that carries no words', () => {
        expect(plainText('<p> </p>')).toBeNull();
        expect(plainText(null)).toBeNull();
        expect(plainText(42)).toBeNull();
    });

    it('caps a runaway bulletin', () => {
        expect(plainText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}\u2026`);
    });
});

describe('WSDOT contracts', () => {
    it('parses WSDOT millisecond dates with offsets', () => {
        expect(parseWsdotDate('/Date(1788280200000-0700)/')).toBe('2026-09-01T16:30:00.000Z');
    });

    it('accepts only WSDOT-hosted camera images over https', () => {
        expect(cameraImageUrl('https://images.wsdot.wa.gov/wsf/colman/colman.jpg')).toBe(
            'https://images.wsdot.wa.gov/wsf/colman/colman.jpg'
        );
        expect(cameraImageUrl('https://images.wsdot.wa.gov/orflow/104vc02465.jpg')).toBe(
            'https://images.wsdot.wa.gov/orflow/104vc02465.jpg'
        );
        expect(cameraImageUrl('http://images.wsdot.wa.gov/wsf/colman.jpg')).toBeNull();
        expect(cameraImageUrl('https://flyykm.com/apps/webcam/')).toBeNull();
        expect(cameraImageUrl('https://images.wsdot.wa.gov.evil.test/wsf/colman.jpg')).toBeNull();
        expect(cameraImageUrl('not a url')).toBeNull();
        expect(cameraImageUrl(null)).toBeNull();
    });

    it('recognises a ferry camera by its road rather than its title', () => {
        expect(isFerryCamera({ CameraID: 1, CameraLocation: { RoadName: 'Ferries' } })).toBe(true);
        expect(isFerryCamera({ CameraID: 2, CameraLocation: { RoadName: 'SR 305' } })).toBe(false);
        expect(isFerryCamera({ CameraID: 3, Title: 'Ferry County Airport' })).toBe(false);
    });

    it('floors an oversold count at zero and leaves absence alone', () => {
        expect(spaceCount(-5)).toBe(0);
        expect(spaceCount(0)).toBe(0);
        expect(spaceCount(27)).toBe(27);
        expect(spaceCount(null)).toBeNull();
        expect(spaceCount(undefined)).toBeNull();
    });

    it('preserves undocumented source fields', () => {
        const parsed = terminalBasicSchema.parse({ TerminalID: 7, TerminalName: 'Seattle', NewField: 'visible' });
        expect(parsed.NewField).toBe('visible');
    });

    it('rejects records without relationship identifiers', () => {
        expect(() => terminalBasicSchema.parse({ TerminalName: 'Seattle' })).toThrow();
    });
});
