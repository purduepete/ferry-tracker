import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_PREFERENCE, isThemePreference } from '../src/theme';

describe('theme preferences', () => {
    it('defaults to midnight', () => {
        expect(DEFAULT_THEME_PREFERENCE).toBe('midnight');
    });

    it('rejects unsupported stored preferences, including the retired ones', () => {
        expect(isThemePreference('sepia')).toBe(false);
        expect(isThemePreference('dark')).toBe(false);
        expect(isThemePreference('system')).toBe(true);
    });
});
