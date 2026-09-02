import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@ferry-tracker/shared';

interface ThemeContextValue {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeKey = 'ferry-tracker-theme';
const legacyAccentKey = 'ferry-tracker-accent';
const darkQuery = '(prefers-color-scheme: dark)';

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(themeKey);
    return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(darkQuery).matches);
  const theme = resolveTheme(preference, systemDark);

  useEffect(() => {
    try { localStorage.removeItem(legacyAccentKey); } catch { /* Legacy cleanup can fail without blocking themes. */ }
  }, []);

  useEffect(() => {
    const query = window.matchMedia(darkQuery);
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
    const themeColors: Record<ResolvedTheme, string> = { light: '#f9fafb', dark: '#111827', midnight: '#020617' };
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
  }, [theme]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    try { localStorage.setItem(themeKey, value); } catch { /* The setting remains active for this tab. */ }
  };
  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}