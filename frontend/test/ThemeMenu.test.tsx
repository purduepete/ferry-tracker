// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
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
  render(<ThemeProvider><ThemeMenu /></ThemeProvider>);
}

describe('ThemeMenu', () => {
  it('uses midnight by default and persists a selected theme', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByLabelText('Accent')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(localStorage.getItem('ferry-tracker-theme')).toBe('light');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it('removes the legacy accent and supports radio arrow keys', async () => {
    localStorage.setItem('ferry-tracker-accent', '#ffffff');
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    const midnight = screen.getByRole('radio', { name: 'Midnight' });
    midnight.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('ferry-tracker-accent')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Appearance' });
    await user.click(trigger);
    screen.getByRole('radio', { name: 'Midnight' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Appearance settings' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside pointer interaction', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><ThemeMenu /><button type="button">Outside</button></ThemeProvider>);
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog', { name: 'Appearance settings' })).not.toBeInTheDocument();
  });
});