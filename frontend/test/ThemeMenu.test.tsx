// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ThemeMenu } from '../src/theme/ThemeMenu';

const storage = new Map<string, string>();

beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
            setItem: (key: string, value: string) => storage.set(key, value),
        },
    });
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    });
});

function renderMenu() {
    render(
        <ThemeProvider>
            <ThemeMenu />
        </ThemeProvider>
    );
}

describe('ThemeMenu', () => {
    it('uses midnight by default and persists a selected theme', async () => {
        const user = userEvent.setup();
        renderMenu();
        expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Appearance' }));
        expect(screen.getByRole('group', { name: 'Theme' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Midnight' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByLabelText('Accent')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Light' }));
        expect(localStorage.getItem('ferry-tracker-theme')).toBe('light');
        await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    });

    it('removes the legacy accent and supports wrapping arrow keys', async () => {
        localStorage.setItem('ferry-tracker-accent', '#ffffff');
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole('button', { name: 'Appearance' }));
        const midnight = screen.getByRole('button', { name: 'Midnight' });
        act(() => midnight.focus());
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'System' })).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('button', { name: 'Light' })).toHaveFocus();
        await user.keyboard('{ArrowLeft}');
        expect(screen.getByRole('button', { name: 'System' })).toHaveFocus();
        expect(localStorage.getItem('ferry-tracker-accent')).toBeNull();
    });

    it('supports Home, End and activation with Space and Enter', async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole('button', { name: 'Appearance' }));
        act(() => screen.getByRole('button', { name: 'Midnight' }).focus());
        await user.keyboard('{Home}');
        expect(screen.getByRole('button', { name: 'Light' })).toHaveFocus();
        expect(localStorage.getItem('ferry-tracker-theme')).toBe('light');
        await user.keyboard('{End}');
        expect(screen.getByRole('button', { name: 'System' })).toHaveFocus();
        expect(localStorage.getItem('ferry-tracker-theme')).toBe('system');
        act(() => screen.getByRole('button', { name: 'Light' }).focus());
        await user.keyboard(' ');
        expect(localStorage.getItem('ferry-tracker-theme')).toBe('light');
        act(() => screen.getByRole('button', { name: 'Midnight' }).focus());
        await user.keyboard('{Enter}');
        expect(localStorage.getItem('ferry-tracker-theme')).toBe('midnight');
    });

    it('has one Tab stop and lets Tab leave the group', async () => {
        const user = userEvent.setup();
        render(
            <ThemeProvider>
                <ThemeMenu />
                <button type="button">Outside</button>
            </ThemeProvider>
        );
        await user.tab();
        expect(screen.getByRole('button', { name: 'Appearance' })).toHaveFocus();
        await user.keyboard('{Enter}');
        await user.tab();
        expect(screen.getByRole('button', { name: 'Midnight' })).toHaveFocus();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('dismisses on Escape with focus return and on outside pointer interaction', async () => {
        const user = userEvent.setup();
        renderMenu();
        const trigger = screen.getByRole('button', { name: 'Appearance' });
        await user.click(trigger);
        act(() => screen.getByRole('button', { name: 'Midnight' }).focus());
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        await user.click(trigger);
        await user.click(document.body);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
