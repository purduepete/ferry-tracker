import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Monitor, Palette, Sparkles, Sun } from 'lucide-react';
import { THEME_PREFERENCES, type ThemePreference } from '@ferry-tracker/shared';
import { useTheme } from './ThemeProvider';
import { HintButton } from '../components/InfoBox';

const labels: Record<ThemePreference, string> = {
    system: 'System',
    light: 'Light',
    midnight: 'Midnight',
};

export function ThemeMenu() {
    const { preference, setPreference } = useTheme();
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
    }, [open]);

    const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
            return;
        }
        if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-theme-option]')) return;
        const currentIndex = THEME_PREFERENCES.indexOf(preference);
        const offset =
            event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const nextIndex =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? THEME_PREFERENCES.length - 1
                  : (currentIndex + offset + THEME_PREFERENCES.length) % THEME_PREFERENCES.length;
        const next = THEME_PREFERENCES[nextIndex];
        setPreference(next);
        containerRef.current?.querySelector<HTMLButtonElement>(`[data-theme-option="${next}"]`)?.focus();
    };

    return (
        <div
            className="theme-menu"
            ref={containerRef}
            onKeyDown={handleKeys}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <HintButton
                ref={triggerRef}
                className="icon-button"
                type="button"
                hint="Appearance"
                aria-label="Appearance"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >
                <Palette size={18} />
            </HintButton>
            {open && (
                <div className="theme-popover" role="dialog" aria-label="Appearance settings">
                    <span className="control-label">Theme</span>
                    <div className="theme-segments" role="group" aria-label="Theme">
                        <span
                            className="theme-selection"
                            aria-hidden="true"
                            style={{ transform: `translateX(${THEME_PREFERENCES.indexOf(preference) * 100}%)` }}
                        />
                        {THEME_PREFERENCES.map((value) => (
                            <button
                                key={value}
                                data-theme-option={value}
                                tabIndex={preference === value ? 0 : -1}
                                type="button"
                                aria-label={labels[value]}
                                aria-pressed={preference === value}
                                onClick={() => setPreference(value)}
                            >
                                {value === 'system' ? (
                                    <Monitor size={15} />
                                ) : value === 'light' ? (
                                    <Sun size={15} />
                                ) : (
                                    <Sparkles size={15} />
                                )}
                                <span className="theme-option-label">{labels[value]}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
