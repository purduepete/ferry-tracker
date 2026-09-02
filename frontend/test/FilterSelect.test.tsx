// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterSelect } from '../src/components/FilterSelect';

const options = [
  { value: 7, label: 'Seattle · 7' },
  { value: 3, label: 'Bainbridge Island · 3' },
];

describe('FilterSelect', () => {
  it('selects options through the listbox', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect ariaLabel="Terminal" options={options} value={7} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('option', { name: 'Seattle · 7' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: 'Bainbridge Island · 3' }));
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