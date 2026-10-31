// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const bootstrap = readFileSync('frontend/public/theme-init.js', 'utf8');

describe('pre-paint and runtime theme agreement', () => {
    it('applies the theme before requesting the font stylesheet', () => {
        const html = readFileSync('frontend/index.html', 'utf8');
        const theme = html.indexOf('<script src="/theme-init.js">');
        const font = html.indexOf('https://fonts.googleapis.com/css2');
        expect(theme).toBeGreaterThanOrEqual(0);
        expect(font).toBeGreaterThan(theme);
    });

    it.each([null, 'invalid', 'dark', 'light', 'midnight', 'system'])('restores %s in both OS modes', (stored) => {
        for (const dark of [false, true]) {
            localStorage.clear();
            if (stored) localStorage.setItem('ferry-tracker-theme', stored);
            window.matchMedia = vi
                .fn()
                .mockReturnValue({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() });
            document.head.innerHTML = '<meta name="theme-color">';
            new Function(bootstrap)();
            const before = document.documentElement.outerHTML.split('<body')[0];
            const view = render(
                <ThemeProvider>
                    <span />
                </ThemeProvider>
            );
            expect(document.documentElement.outerHTML.split('<body')[0]).toBe(before);
            view.unmount();
        }
    });

    it.each(['system', 'light', 'midnight'])('tracks OS changes only for %s', (preference) => {
        localStorage.setItem('ferry-tracker-theme', preference);
        let listener: (event: { matches: boolean }) => void = () => {};
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: (_: string, callback: typeof listener) => {
                listener = callback;
            },
            removeEventListener: vi.fn(),
        });
        render(
            <ThemeProvider>
                <span />
            </ThemeProvider>
        );
        act(() => listener({ matches: true }));
        expect(document.documentElement.dataset.theme).toBe(preference === 'system' ? 'midnight' : preference);
        act(() => listener({ matches: false }));
        expect(document.documentElement.dataset.theme).toBe(preference === 'system' ? 'light' : preference);
    });
});
