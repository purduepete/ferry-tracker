// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { Help, HintButton, InfoBox } from '../src/components/InfoBox';

vi.mock('../src/siteSettings', () => ({ SHOW_TOOLTIPS: true }));

describe('shared contextual help', () => {
    it('opens explanations only from their icon and supports keyboard, tap and dismissal', async () => {
        const user = userEvent.setup();
        render(
            <>
                <Help help="How this estimate is calculated">Estimated arrival</Help>
                <button>Outside</button>
            </>
        );
        const info = screen.getByRole('button', { name: 'Details information' });
        expect(screen.getByText('How this estimate is calculated')).toBeInTheDocument();
        await user.hover(screen.getByText('Estimated arrival'));
        expect(screen.queryByRole('tooltip')).toBeNull();
        await user.hover(info);
        expect(screen.getByRole('tooltip')).toHaveTextContent('How this estimate is calculated');
        expect(info).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
        await user.hover(screen.getByRole('tooltip'));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 160));
        });
        expect(info).toHaveAttribute('aria-expanded', 'true');
        await user.keyboard('{Escape}');
        expect(info).toHaveAttribute('aria-expanded', 'false');
        act(() => info.focus());
        expect(screen.getByRole('tooltip')).toBeInTheDocument();
        await user.tab();
        expect(screen.queryByRole('tooltip')).toBeNull();
        await user.click(info);
        expect(screen.getByRole('tooltip')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('tooltip')).toBeNull();
        await user.click(info);
        await user.click(screen.getByRole('button', { name: 'Outside' }));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('preserves action handlers, sortable keyboard behavior, existing descriptions and refs', async () => {
        const user = userEvent.setup();
        const click = vi.fn();
        const key = vi.fn();
        const ref = { current: null as HTMLButtonElement | null };
        render(
            <HintButton
                ref={ref}
                hint="Drag or use arrow keys"
                aria-describedby="existing"
                onClick={click}
                onKeyDown={key}
            >
                Reorder
            </HintButton>
        );
        const control = screen.getByRole('button', { name: 'Reorder' });
        expect(ref.current).toBe(control);
        await user.click(control);
        expect(click).toHaveBeenCalledOnce();
        await user.keyboard('{ArrowDown}');
        expect(key).toHaveBeenCalled();
        expect(control.getAttribute('aria-describedby')).toMatch(/^existing /);
        expect(control.querySelector('button')).toBeNull();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('keeps non-details hover help closed and opens it by click', async () => {
        const user = userEvent.setup();
        render(
            <div style={{ overflow: 'hidden' }}>
                <InfoBox heading="Crossing time">Estimated from recent crossings</InfoBox>
            </div>
        );
        await user.hover(screen.getByRole('button', { name: 'Crossing time information' }));
        expect(screen.queryByRole('tooltip')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Crossing time information' }));
        const tooltip = screen.getByRole('tooltip');
        expect(tooltip.parentElement).toBe(document.body);
        await waitFor(() => expect(tooltip.style.left).toBe('8px'));
        expect(tooltip.className).toContain('is-open');
    });

    it('keeps disabled-control explanations off hover and available by keyboard', async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <HintButton disabled hint="Choose a route first">
                Save route
            </HintButton>
        );
        const button = screen.getByRole('button', { name: 'Save route' });
        await user.hover(button);
        expect(screen.queryByRole('tooltip')).toBeNull();
        const description = document.getElementById(button.getAttribute('aria-describedby')!);
        expect(description).toHaveTextContent('Choose a route first');
        rerender(<HintButton hint="Save the route">Save route</HintButton>);
        expect(button).toBeEnabled();
        await user.tab();
        expect(button).toHaveFocus();
        expect(screen.getByRole('tooltip')).toHaveTextContent('Save the route');
    });

    it('opens a hint on hover and closes it when the pointer leaves', async () => {
        const user = userEvent.setup();
        render(<HintButton hint="Refresh ferry data">Refresh</HintButton>);
        const button = screen.getByRole('button', { name: 'Refresh' });
        await user.hover(button);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Refresh ferry data');
        await user.unhover(button);
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    });
});
