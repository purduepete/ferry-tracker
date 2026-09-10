import { describe, expect, it } from 'vitest';
import { cameraImageUrl, isFerryCamera, parseWsdotDate, spaceCount, terminalBasicSchema } from '../src/wsdot';

describe('WSDOT contracts', () => {
  it('parses WSDOT millisecond dates with offsets', () => {
    expect(parseWsdotDate('/Date(1788280200000-0700)/')).toBe('2026-09-01T16:30:00.000Z');
  });

  it('accepts only WSDOT-hosted camera images over https', () => {
    expect(cameraImageUrl('https://images.wsdot.wa.gov/wsf/colman/colman.jpg')).toBe('https://images.wsdot.wa.gov/wsf/colman/colman.jpg');
    expect(cameraImageUrl('https://images.wsdot.wa.gov/orflow/104vc02465.jpg')).toBe('https://images.wsdot.wa.gov/orflow/104vc02465.jpg');
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