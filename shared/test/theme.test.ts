import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_PREFERENCE, isThemePreference, resolveTheme } from '../src/theme';

describe('theme preferences', () => {
  it('defaults to midnight', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('midnight');
  });

  it('resolves system preferences from the color scheme', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('midnight');
  });

  it('rejects unsupported stored preferences', () => {
    expect(isThemePreference('sepia')).toBe(false);
  });
});