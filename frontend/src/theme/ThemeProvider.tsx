import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  type ThemePreference,
} from '@ferry-tracker/shared';

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeKey = 'ferry-tracker-theme';
const legacyAccentKey = 'ferry-tracker-accent';

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(themeKey);
    return value === 'dark' ? 'midnight' : isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    try { localStorage.removeItem(legacyAccentKey); } catch { /* Legacy cleanup can fail without blocking themes. */ }
  }, []);

  useEffect(() => {
    const theme = preference === 'system' ? (systemDark ? 'midnight' : 'light') : preference;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.remove('light', 'dark', 'theme-midnight');
    root.classList.add(...(theme === 'light' ? ['light'] : ['dark', 'theme-midnight']));
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
    root.style.backgroundColor = theme === 'light' ? '#ffffff' : '#0f172a';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#0f172a');
  }, [preference, systemDark]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    try { localStorage.setItem(themeKey, value); } catch { /* The setting remains active for this tab. */ }
  };
  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}