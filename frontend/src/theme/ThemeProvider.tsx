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
    return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);

  useEffect(() => {
    try { localStorage.removeItem(legacyAccentKey); } catch { /* Legacy cleanup can fail without blocking themes. */ }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = preference;
    document.documentElement.style.colorScheme = preference === 'light' ? 'light' : 'dark';
    const themeColors: Record<ThemePreference, string> = { light: '#f9fafb', midnight: '#020617' };
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[preference]);
  }, [preference]);

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