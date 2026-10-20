export const THEME_PREFERENCES = ['light', 'midnight', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'midnight';

export function isThemePreference(value: unknown): value is ThemePreference {
    return typeof value === 'string' && THEME_PREFERENCES.includes(value as ThemePreference);
}
