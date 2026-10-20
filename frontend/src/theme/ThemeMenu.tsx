import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Monitor, Palette, Sparkles, Sun } from 'lucide-react';
import { THEME_PREFERENCES, type ThemePreference } from '@ferry-tracker/shared';
import { useTheme } from './ThemeProvider';

const labels: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  midnight: 'Midnight',
};

export function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const closeFromKeyboard = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFromKeyboard();
      return;
    }
    const currentIndex = THEME_PREFERENCES.indexOf(preference);
    const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const next = THEME_PREFERENCES[(currentIndex + offset + THEME_PREFERENCES.length) % THEME_PREFERENCES.length];
    setPreference(next);
    requestAnimationFrame(() => containerRef.current?.querySelector<HTMLButtonElement>(`[data-theme-option="${next}"]`)?.focus());
  };

  return (
    <div className="theme-menu" ref={containerRef}>
      <button ref={triggerRef} className="icon-button" type="button" title="Appearance" aria-label="Appearance" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}><Palette size={18} /></button>
      {open && <div className="theme-popover" role="dialog" aria-label="Appearance settings" onKeyDown={handleKeys}>
        <span className="control-label">Theme</span>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEME_PREFERENCES.map((value) => (
            <button key={value} data-theme-option={value} tabIndex={preference === value ? 0 : -1} type="button" role="radio" aria-checked={preference === value} onClick={() => setPreference(value)}>
              {value === 'system' ? <Monitor size={15} /> : value === 'light' ? <Sun size={15} /> : <Sparkles size={15} />}
              {labels[value]}
            </button>
          ))}
        </div>
      </div>}
    </div>
  );
}