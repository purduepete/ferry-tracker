import { expect, test, type Page } from '@playwright/test';

const at = (time: string) => `2026-09-07T${time}-07:00`;
const sailing = {
    vesselId: 18,
    vesselName: 'Tacoma',
    actualArrival: null as string | null,
    actualDeparture: null,
    departingTime: at('10:20:00'),
    arrivingTime: null,
    departingTerminalId: 7,
    arrivingTerminalId: 3,
    isCancelled: false,
    driveUpSpaceCount: null,
    reservableSpaceCount: null,
    maxSpaceCount: null,
    spaceAvailable: false,
    raw: {},
};

async function openDisruption(page: Page) {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Disruption', exact: true }).click();
    await expect(page.locator('.countdown-value')).toBeVisible();
}

test('Disruption uses schedule, live ETA, observed landing, then the next sailing', async ({ page }) => {
    await page.clock.setFixedTime(new Date(at('10:00:00')));
    let underway = false;
    let actualArrival: string | null = null;
    await page.route('**/api/vessels', (route) =>
        route.fulfill({
            json: {
                source: 'fixture',
                fetchedAt: at('10:00:00'),
                data: underway
                    ? [
                          {
                              id: 18,
                              name: 'Tacoma',
                              departingTerminalId: 7,
                              arrivingTerminalId: 3,
                              atDock: false,
                              eta: at('11:10:00'),
                              leftDock: null,
                              scheduledDeparture: sailing.departingTime,
                          },
                      ]
                    : [],
            },
        })
    );
    await page.route('**/api/schedule?*', (route) =>
        route.fulfill({
            json: {
                source: 'fixture',
                fetchedAt: at('10:00:00'),
                data: [
                    { ...sailing, actualArrival },
                    { ...sailing, departingTime: at('12:00:00') },
                ],
            },
        })
    );
    await openDisruption(page);
    const headline = page.locator('.countdown-headline');
    await expect(headline).toContainText('65 min');
    await expect(headline).toContainText('Scheduled estimate');

    underway = true;
    await page.clock.setFixedTime(new Date(at('10:30:00')));
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(headline).toContainText('50 min');
    await expect(headline).not.toContainText('Scheduled estimate');
    await expect(page.locator('.countdown-later li')).toHaveCount(1);

    underway = false;
    actualArrival = at('11:10:00');
    await page.clock.setFixedTime(new Date(at('11:26:00')));
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(headline).toContainText('9 min left');
    await expect(headline).not.toContainText('Scheduled estimate');

    await page.clock.setFixedTime(new Date(at('11:35:00')));
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(headline).toContainText('70 min');
    await expect(headline).toContainText('Scheduled estimate');
});

for (const vesselId of [null, 19]) {
    test(`Disruption replaces scheduled vessel ${vesselId} with the live boat on the same slot`, async ({ page }) => {
        await page.clock.setFixedTime(new Date(at('11:06:00')));
        await page.route('**/api/vessels', (route) =>
            route.fulfill({
                json: {
                    source: 'fixture',
                    fetchedAt: at('11:06:00'),
                    data: [
                        {
                            id: 18,
                            name: 'Tacoma',
                            departingTerminalId: 7,
                            arrivingTerminalId: 3,
                            atDock: false,
                            eta: at('11:10:00'),
                            leftDock: null,
                            scheduledDeparture: sailing.departingTime,
                        },
                    ],
                },
            })
        );
        await page.route('**/api/schedule?*', (route) =>
            route.fulfill({
                json: {
                    source: 'fixture',
                    fetchedAt: at('11:06:00'),
                    data: [{ ...sailing, vesselId }],
                },
            })
        );
        await openDisruption(page);
        await expect(page.locator('.countdown-value')).toHaveText('14 min');
        await expect(page.locator('.countdown-headline')).not.toContainText('Scheduled estimate');
        await expect(page.locator('.countdown-card')).not.toContainText('Ongoing');
        await expect(page.locator('.countdown-later li')).toHaveCount(0);
    });
}

test('Disruption shows the next morning schedule during the overnight gap', async ({ page }) => {
    await page.clock.setFixedTime(new Date(at('23:50:43')));
    await page.route('**/api/vessels', (route) => route.fulfill({ json: { data: [], source: 'fixture' } }));
    await page.route('**/api/schedule?*', (route) =>
        route.fulfill({
            json: {
                data: [{ ...sailing, departingTime: '2026-09-08T05:30:00-07:00' }],
                source: 'fixture',
            },
        })
    );
    await openDisruption(page);
    await expect(page.locator('.countdown-headline')).toContainText('385 min');
    await expect(page.locator('.countdown-headline')).toContainText('Scheduled estimate');
});

test('scheduled Disruption fits all themes and supported widths', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(at('10:00:00')));
    await page.route('**/api/vessels', (route) => route.fulfill({ json: { data: [], source: 'fixture' } }));
    await page.route('**/api/schedule?*', (route) => route.fulfill({ json: { data: [sailing], source: 'fixture' } }));
    await openDisruption(page);
    for (const theme of ['light', 'midnight']) {
        await page.getByRole('button', { name: 'Appearance' }).click();
        await page.getByRole('button', { name: new RegExp(`^${theme}$`, 'i') }).click();
        await page.keyboard.press('Escape');
        for (const width of [390, 767, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(page.locator('.countdown-headline')).toContainText('Scheduled estimate');
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            expect(
                await page
                    .locator('.countdown-card')
                    .evaluate((card) =>
                        [...card.querySelectorAll<HTMLElement>('.countdown-at, .countdown-value, dd')].every(
                            (element) => element.scrollWidth <= element.clientWidth
                        )
                    )
            ).toBe(true);
            if (width === 390 || width === 1440)
                await page.screenshot({
                    path: testInfo.outputPath(`disruption-${theme}-${width}.png`),
                    fullPage: true,
                });
        }
    }
});
