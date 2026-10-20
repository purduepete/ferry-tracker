// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const alerts = [
    {
        id: 91001,
        title: 'Seattle / Bainbridge Island 4:40 p.m. sailing cancelled',
        text: 'The 4:40 p.m. sailing is cancelled for crewing.',
        type: 'Cancellation',
        publishedAt: '2026-09-01T15:00:00.000Z',
        allRoutes: false,
    },
];

function terminals(seattleAlerts: typeof alerts | [] = alerts) {
    return [
        {
            id: 7,
            name: 'Seattle',
            subjectName: 'seattle',
            latitude: 47.6,
            longitude: -122.3,
            city: 'Seattle',
            cameras: [],
            alerts: seattleAlerts,
            raw: [],
        },
        {
            id: 3,
            name: 'Bainbridge Island',
            subjectName: 'bainbridge',
            latitude: 47.62,
            longitude: -122.5,
            city: 'Bainbridge Island',
            cameras: [],
            alerts: [],
            raw: [],
        },
    ];
}

function json(data: unknown) {
    return Promise.resolve(
        new Response(JSON.stringify({ data, fetchedAt: '2026-09-01T16:00:00.000Z', source: 'fixture', raw: null }))
    );
}

function mockApi(list = terminals()) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.includes('/api/terminals')) return json(list);
        if (url.includes('/api/terminal-mates'))
            return json([
                {
                    departingTerminalId: 7,
                    departingTerminalName: 'Seattle',
                    arrivingTerminalId: 3,
                    arrivingTerminalName: 'Bainbridge Island',
                },
            ]);
        return json([]);
    });
}

describe('terminal alerts', () => {
    it('shows the alert text on the terminal card once the disclosure opens', async () => {
        mockApi();
        const user = userEvent.setup();
        render(
            <ThemeProvider>
                <App />
            </ThemeProvider>
        );

        await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
        const disclosure = await screen.findByRole('button', { name: /Alerts 1 service alert/ });
        expect(disclosure).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText(alerts[0].title)).toBeNull();

        await user.click(disclosure);
        expect(await screen.findByText(alerts[0].title)).toBeInTheDocument();
        expect(screen.getByText(alerts[0].text)).toBeInTheDocument();
    });

    it('shows a real alert type alongside the publish time', async () => {
        mockApi();
        const user = userEvent.setup();
        render(
            <ThemeProvider>
                <App />
            </ThemeProvider>
        );

        await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
        await user.click(await screen.findByRole('button', { name: /Alerts 1 service alert/ }));
        expect(await screen.findByText(/^Cancellation · /)).toBeInTheDocument();
    });

    it('drops the type when WSDOT sends its catch-all "All Alerts" label', async () => {
        mockApi(terminals([{ ...alerts[0], type: 'All Alerts' }]));
        const user = userEvent.setup();
        render(
            <ThemeProvider>
                <App />
            </ThemeProvider>
        );

        await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
        await user.click(await screen.findByRole('button', { name: /Alerts 1 service alert/ }));
        expect(await screen.findByText(alerts[0].title)).toBeInTheDocument();
        expect(screen.queryByText(/All Alerts/)).toBeNull();
    });

    it('marks the Sailings back-link without renaming it', async () => {
        mockApi();
        render(
            <ThemeProvider>
                <App />
            </ThemeProvider>
        );

        // The button keeps its exact accessible name; the count rides on the icon inside it.
        const link = await screen.findByRole('button', { name: 'Show the Seattle terminal card' });
        expect(await screen.findByRole('img', { name: '1 service alert' })).toBeInTheDocument();
        expect(link).toContainElement(screen.getByRole('img', { name: '1 service alert' }));
    });

    it('shows no alert marker when a terminal has none', async () => {
        mockApi(terminals([]));
        const user = userEvent.setup();
        render(
            <ThemeProvider>
                <App />
            </ThemeProvider>
        );

        await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
        await screen.findAllByText('Longitude');
        expect(screen.queryByRole('button', { name: /service alert/ })).toBeNull();
        expect(screen.queryByRole('img', { name: /service alert/ })).toBeNull();
    });
});
