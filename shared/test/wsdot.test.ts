import { describe, expect, it } from 'vitest';
import { parseWsdotDate, terminalBasicSchema } from '../src/wsdot';

describe('WSDOT contracts', () => {
  it('parses WSDOT millisecond dates with offsets', () => {
    expect(parseWsdotDate('/Date(1788280200000-0700)/')).toBe('2026-09-01T16:30:00.000Z');
  });

  it('preserves undocumented source fields', () => {
    const parsed = terminalBasicSchema.parse({ TerminalID: 7, TerminalName: 'Seattle', NewField: 'visible' });
    expect(parsed.NewField).toBe('visible');
  });

  it('rejects records without relationship identifiers', () => {
    expect(() => terminalBasicSchema.parse({ TerminalName: 'Seattle' })).toThrow();
  });
});