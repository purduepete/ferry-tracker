import { describe, expect, it } from 'vitest';
import { parseWsdotDate, spaceCount, terminalBasicSchema } from '../src/wsdot';

describe('WSDOT contracts', () => {
  it('parses WSDOT millisecond dates with offsets', () => {
    expect(parseWsdotDate('/Date(1788280200000-0700)/')).toBe('2026-09-01T16:30:00.000Z');
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