// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Help, HintButton } from '../src/components/InfoBox';
import { SHOW_TOOLTIPS } from '../src/siteSettings';

describe('tooltips switched off', () => {
    it('defaults to hiding tooltips', () => {
        expect(SHOW_TOOLTIPS).toBe(false);
    });

    it('keeps control hints closed on hover and focus but leaves them as descriptions', async () => {
        const user = userEvent.setup();
        render(<HintButton hint="Refresh ferry data">Refresh</HintButton>);
        const button = screen.getByRole('button', { name: 'Refresh' });
        await user.hover(button);
        expect(screen.queryByRole('tooltip')).toBeNull();
        act(() => button.focus());
        expect(screen.queryByRole('tooltip')).toBeNull();
        const description = document.getElementById(button.getAttribute('aria-describedby')!);
        expect(description).toHaveTextContent('Refresh ferry data');
    });

    it('still opens Info icon boxes', async () => {
        const user = userEvent.setup();
        render(<Help help="How this estimate is calculated">Estimated arrival</Help>);
        await user.hover(screen.getByRole('button', { name: 'Details information' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('How this estimate is calculated');
    });
});
