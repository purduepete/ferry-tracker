import { expect, test, type Page } from '@playwright/test';

const at = (time: string) => new Date(`2026-09-06T${time}-07:00`).toISOString();
const sailing = {
    vesselId: 18,
    vesselName: 'Tacoma',
    departingTime: at('11:35:00'),
    arrivingTime: null,
    departingTerminalId: 3,
    arrivingTerminalId: 7,
    isCancelled: false,
    driveUpSpaceCount: 180,
    reservableSpaceCount: null,
    maxSpaceCount: 197,
    spaceAvailable: true,
    actualDeparture: null,
    raw: {},
};

async function catchFixture(page: Page, docked = false, startAt = '11:21:00') {
    const now = at(docked ? '11:41:00' : startAt);
    // An installed clock keeps ticking, so start a minute early and let pauseAt land exactly on now.
    await page.clock.install({ time: new Date(Date.parse(now) - 60_000) });
    await page.clock.pauseAt(new Date(now));
    const vessel = {
        id: 18,
        name: 'Tacoma',
        vesselClass: 'Jumbo Mark II',
        departingTerminalId: docked ? 3 : 7,
        arrivingTerminalId: docked ? 7 : 3,
        departingTerminalName: docked ? 'Bainbridge Island' : 'Seattle',
        arrivingTerminalName: docked ? 'Seattle' : 'Bainbridge Island',
        atDock: docked,
        speed: docked ? 0 : 14,
        inService: true,
        scheduledDeparture: docked ? sailing.departingTime : at('10:30:00'),
        leftDock: null,
        eta: docked ? null : at('11:47:00'),
        updatedAt: now,
        raw: {},
    };
    // The reload below destroys the context this reads the fake clock from, so keep the last good read.
    let clockNow = now;
    await page.route('**/api/vessels', async (route) => {
        try {
            clockNow = await page.evaluate(() => new Date(Date.now()).toISOString());
        } catch {
            /* navigation in flight */
        }
        const fetchedAt = clockNow;
        await route.fulfill({ json: { data: [{ ...vessel, updatedAt: fetchedAt }], fetchedAt, source: 'fixture' } });
    });
    await page.route('**/api/schedule?*', (route) =>
        route.fulfill({
            json: {
                data: [sailing, { ...sailing, vesselId: 19, vesselName: 'Wenatchee', departingTime: at('12:20:00') }],
                fetchedAt: now,
                source: 'fixture',
            },
        })
    );
    await page.goto('/');
    await page.evaluate(
        (trafficMinutes) => {
            localStorage.setItem(
                'ferry-tracker-catch-overrides',
                JSON.stringify({ '3-7': { trafficMinutes, queueMinutes: 15 } })
            );
            localStorage.setItem(
                'ferry-tracker-settings',
                JSON.stringify({ catchSoonMinutes: 7, catchImminentMinutes: 5 })
            );
        },
        docked ? 0 : 15
    );
    await page.reload();
    await page.getByRole('tab', { name: 'Catch' }).click();
    await expect
        .poll(async () => {
            await page.clock.runFor(1600);
            return page.locator('.countdown-headline').isVisible();
        })
        .toBe(true);
}

test('Catch shows both leave-by times and advances after the estimated traffic cutoff', async ({ page }) => {
    await catchFixture(page);
    const headline = page.locator('.countdown-headline');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('0 min');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('Leave by 11:05');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('11 min');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('Queue remaining');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toHaveClass(/is-imminent/);
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('Leave by 11:17');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('11:47 sailing');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('11:35 sailing');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' }).locator('.countdown-value')).toHaveCSS(
        'font-weight',
        '400'
    );
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toHaveClass(/is-muted/);
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).not.toHaveClass(/is-muted/);
    await page.clock.runFor(11 * 60000 + 15000);
    await expect(headline).toContainText('12:20 sailing');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toHaveCount(0);
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('Leave by 11:50');
});

test('Catch switches from yellow to red queue remaining and retires after zero', async ({ page }) => {
    await catchFixture(page, false, '11:16:00');
    const headline = page.locator('.countdown-headline');
    const estimated = headline.getByRole('group', { name: 'Estimated leave by' });
    await expect(estimated.locator('.countdown-value')).toHaveText('1 min');
    await expect(estimated).toHaveClass(/is-soon/);
    await expect(estimated).not.toContainText('Queue remaining');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('Queue remaining');
    for (const [time, minutes] of [
        ['11:17:00', 15],
        ['11:18:00', 14],
        ['11:32:00', 0],
    ] as const) {
        const elapsed = await page.evaluate(() => Date.now());
        await page.clock.runFor(Date.parse(at(time)) - elapsed);
        await expect(estimated.locator('.countdown-value')).toHaveText(`${minutes} min`);
        await expect(estimated).toHaveClass(/is-imminent/);
        await expect(estimated).toContainText('Queue remaining');
    }
    await page.clock.runFor(15000);
    await expect(headline).toContainText('12:20 sailing');
    await expect(headline).not.toContainText('Queue remaining');
});

test('Catch keeps only the yellow time setting and a single padding total', async ({ page }) => {
    await catchFixture(page);
    await page.getByRole('button', { name: /Padding/ }).click();
    await expect(page.locator('.catch-timing').getByText('30 min', { exact: true })).toHaveCount(1);
    await expect(page.locator('.catch-timing-total')).toHaveCount(0);
    await page.getByRole('button', { name: 'Catch queue' }).click();
    await page.getByRole('option', { name: '20 min', exact: true }).click();
    await expect(page.getByRole('button', { name: /Padding/ })).toContainText('35 min');
    await page.getByRole('button', { name: 'Use settings', exact: true }).click();
    await expect(page.getByRole('button', { name: /Padding/ })).toContainText('30 min');
    await page.getByRole('button', { name: /Padding/ }).click();
    await expect(page.locator('.catch-timing').getByText('30 min', { exact: true })).toHaveCount(1);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByRole('button', { name: 'Catch red under' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Catch yellow under' })).toHaveText('7 min');
    await expect(page.getByRole('button', { name: 'Space red under' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disruption red under' })).toBeVisible();
});

test('Catch keeps delayed Then rows paired', async ({ page }) => {
    await catchFixture(page);
    await page.route('**/api/schedule?*', (route) =>
        route.fulfill({
            json: {
                data: [
                    { ...sailing, vesselId: 20, departingTime: at('11:40:00') },
                    { ...sailing, departingTime: at('11:45:00') },
                ],
                fetchedAt: at('11:21:00'),
                source: 'fixture',
            },
        })
    );
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await page.clock.runFor(1600);
    const later = page.locator('.countdown-later li');
    await expect(later.getByRole('group', { name: 'Scheduled leave by' })).toContainText('9 min');
    await expect(later.getByRole('group', { name: 'Estimated leave by' })).toContainText('11 min');
    await expect(later.getByText('Queue remaining', { exact: true })).toHaveCount(2);
    await expect(later.getByRole('group', { name: 'Estimated leave by' })).toContainText('11:47 sailing');
});

test('Catch dims docked Scheduled values with readable contrast across themes and widths', async ({
    page,
}, testInfo) => {
    await catchFixture(page, true);
    const headline = page.locator('.countdown-headline');
    await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toHaveClass(/is-muted/);
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('Estimated (delay so far)');
    await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('0 min');
    await page.getByRole('button', { name: /Padding/ }).click();
    for (const theme of ['light', 'midnight']) {
        await page.getByRole('button', { name: 'Appearance' }).click();
        await page.getByRole('button', { name: new RegExp(`^${theme}$`, 'i') }).click();
        await page.keyboard.press('Escape');
        for (const width of [390, 767, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            const geometry = await headline.evaluate((element) => {
                const values = [...element.querySelectorAll<HTMLElement>('.catch-time')];
                return {
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    fits: values.every((group) => group.scrollWidth <= group.clientWidth),
                    separated: values[0].getBoundingClientRect().right <= values[1].getBoundingClientRect().left,
                };
            });
            expect(geometry).toEqual({ overflow: false, fits: true, separated: true });
            const danger = await page.evaluate(() => {
                const probe = document.createElement('span');
                probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
                return probe.style.color;
            });
            await expect(
                headline.getByRole('group', { name: 'Estimated leave by' }).locator('.countdown-value')
            ).toHaveCSS('color', danger);
            const contrast = await headline.evaluate((element) => {
                const luminance = (color: string) => {
                    const channels = color
                        .match(/[\d.]+/g)!
                        .slice(0, 3)
                        .map(Number)
                        .map((value) => {
                            const channel = value / 255;
                            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                        });
                    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
                };
                const background = luminance(getComputedStyle(element.closest('.countdown-card')!).backgroundColor);
                return [...element.querySelectorAll('.is-muted > *')].map((text) => {
                    const foreground = luminance(getComputedStyle(text).color);
                    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
                });
            });
            for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
            if (width === 390 || width === 1440) {
                await page.screenshot({ path: testInfo.outputPath(`catch-${theme}-${width}.png`), fullPage: true });
            }
        }
    }
    await page.getByRole('button', { name: 'Catch traffic' }).click();
    await page.getByRole('option', { name: '15 min', exact: true }).evaluate((element: HTMLElement) => element.click());
    await expect(headline).toContainText('12:20 sailing');
    await expect(headline.locator('.is-muted')).toHaveCount(0);
});
