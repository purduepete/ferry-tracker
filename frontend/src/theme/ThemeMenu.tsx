import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { THEME_PREFERENCES, type ThemePreference } from '@ferry-tracker/shared';
import { useTheme } from './ThemeProvider';

const labels: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  midnight: 'Midnight',
};

export function ThemeMenu() {
  const { preference, accent, setPreference, setAccent } = useTheme();
  return (
    <details className="theme-menu">
      <summary title="Appearance" aria-label="Appearance"><Palette size={18} /></summary>
      <div className="theme-popover">
        <span className="control-label">Theme</span>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEME_PREFERENCES.map((value) => (
            <button key={value} type="button" role="radio" aria-checked={preference === value} onClick={() => setPreference(value)}>
              {value === 'system' ? <Monitor size={15} /> : value === 'light' ? <Sun size={15} /> : <Moon size={15} />}
              {labels[value]}
            </button>
          ))}
        </div>
        <label className="accent-control">
          <span>Accent</span>
          <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} />
        </label>
      </div>
    </details>
  );
}