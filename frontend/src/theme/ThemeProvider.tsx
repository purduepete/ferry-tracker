import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@ferry-tracker/shared';

interface ThemeContextValue {
  preference: ThemePreference;
  theme: ResolvedTheme;
  accent: string;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeKey = 'ferry-tracker-theme';
const accentKey = 'ferry-tracker-accent';
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
  const [accent, setAccentState] = useState(() => {
    try { return localStorage.getItem(accentKey) ?? DEFAULT_ACCENT_COLOR; } catch { return DEFAULT_ACCENT_COLOR; }
  });
  const theme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const query = window.matchMedia(darkQuery);
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--accent', accent);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f7f5' : '#101a1e');
  }, [accent, theme]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    try { localStorage.setItem(themeKey, value); } catch { /* The setting remains active for this tab. */ }
  };
  const setAccent = (value: string) => {
    setAccentState(value);
    try { localStorage.setItem(accentKey, value); } catch { /* The setting remains active for this tab. */ }
  };

  return <ThemeContext.Provider value={{ preference, theme, accent, setPreference, setAccent }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}