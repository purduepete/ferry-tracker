// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterSelect } from '../src/components/FilterSelect';

const options = [
  { value: 7, label: 'Seattle' },
  { value: 3, label: 'Bainbridge Island' },
];

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
    fireEvent.pointerUp(option, { pointerType: 'touch' });

    expect(onChange).toHaveBeenCalledWith(3);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
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