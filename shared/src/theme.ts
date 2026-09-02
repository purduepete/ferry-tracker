export const THEME_PREFERENCES = ['system', 'light', 'dark', 'midnight'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';
export const DEFAULT_ACCENT_COLOR = '#0f766e';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value as ThemePreference);
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'midnight' : 'light';
  return preference;
}