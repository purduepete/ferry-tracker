// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterSelect } from '../src/components/FilterSelect';

const options = [
  { value: 7, label: 'Seattle' },
  { value: 3, label: 'Bainbridge Island' },
];

// jsdom has no PointerEvent, and fireEvent's fallback drops clientX/clientY.
function touchAt(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  return event;
}

describe('FilterSelect', () => {
  it('selects options through the listbox', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect ariaLabel="Terminal" options={options} value={7} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('option', { name: 'Seattle' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: 'Bainbridge Island' }));
    expect(onChange).toHaveBeenCalledWith(3);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('commits a touch on pointerup, since iOS may never send the click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect ariaLabel="Terminal" options={options} value={7} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    const option = screen.getByRole('option', { name: 'Bainbridge Island' });
    fireEvent(option, touchAt('pointerdown', 40, 120));
    fireEvent(option, touchAt('pointerup', 42, 123));

    expect(onChange).toHaveBeenCalledWith(3);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('leaves the menu open when a touch scrolls the list instead of tapping a row', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect ariaLabel="Terminal" options={options} value={7} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    const option = screen.getByRole('option', { name: 'Bainbridge Island' });
    fireEvent(option, touchAt('pointerdown', 40, 200));
    fireEvent(option, touchAt('pointerup', 40, 120));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('supports keyboard navigation and selection', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect ariaLabel="Terminal" options={options} value={7} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Terminal' });
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith(3);
  });
});