import { expect, test, type Page } from '@playwright/test';

const at = (time: string) => new Date(`2026-09-06T${time}-07:00`).toISOString();
const sailing = {
  vesselId: 18, vesselName: 'Tacoma', departingTime: at('11:35:00'), arrivingTime: null,
  departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false,
  driveUpSpaceCount: 180, reservableSpaceCount: null, maxSpaceCount: 197, spaceAvailable: true,
  actualDeparture: null, raw: {},
};

async function catchFixture(page: Page, docked = false) {
  const now = at(docked ? '11:41:00' : '11:21:00');
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  const vessel = {
    id: 18, name: 'Tacoma', vesselClass: 'Jumbo Mark II', departingTerminalId: docked ? 3 : 7,
    arrivingTerminalId: docked ? 7 : 3, departingTerminalName: docked ? 'Bainbridge Island' : 'Seattle',
    arrivingTerminalName: docked ? 'Seattle' : 'Bainbridge Island',
    atDock: docked, speed: docked ? 0 : 14, inService: true,
    scheduledDeparture: docked ? sailing.departingTime : at('10:30:00'), leftDock: null,
    eta: docked ? null : at('11:47:00'), updatedAt: now, raw: {},
  };
  await page.route('**/api/vessels', async (route) => {
    const fetchedAt = await page.evaluate(() => new Date(Date.now()).toISOString());
    await route.fulfill({ json: { data: [{ ...vessel, updatedAt: fetchedAt }], fetchedAt, source: 'fixture' } });
  });
  await page.route('**/api/schedule?*', (route) => route.fulfill({ json: {
    data: [sailing, { ...sailing, vesselId: 19, vesselName: 'Wenatchee', departingTime: at('12:20:00') }],
    fetchedAt: now, source: 'fixture',
  } }));
  await page.goto('/');
  await page.evaluate((trafficMinutes) => {
    localStorage.setItem('ferry-tracker-catch-overrides', JSON.stringify({ '3-7': { trafficMinutes, queueMinutes: 15 } }));
  }, docked ? 0 : 15);
  await page.reload();
  await page.getByRole('tab', { name: 'Catch' }).click();
  await expect.poll(async () => {
    await page.clock.runFor(1600);
    return page.locator('.countdown-headline').isVisible();
  }).toBe(true);
}

test('Catch shows both leave-by times and advances after the estimated traffic cutoff', async ({ page }) => {
  await catchFixture(page);
  const headline = page.locator('.countdown-headline');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('-16 min');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('Leave by 11:05');
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('-4 min');
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('Leave by 11:17');
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('11:47 sailing');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('11:35 sailing');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' }).locator('.countdown-value')).toHaveCSS('font-weight', '400');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toHaveClass(/is-muted/);
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).not.toHaveClass(/is-muted/);
  await page.clock.runFor(11 * 60000 + 15000);
  await expect(headline).toContainText('12:20 sailing');
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toHaveCount(0);
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toContainText('Leave by 11:50');
});

test('Catch keeps delayed Then rows paired', async ({ page }) => {
  await catchFixture(page);
  await page.route('**/api/schedule?*', (route) => route.fulfill({ json: {
    data: [{ ...sailing, vesselId: 20, departingTime: at('11:40:00') }, { ...sailing, departingTime: at('11:45:00') }],
    fetchedAt: at('11:21:00'), source: 'fixture',
  } }));
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await page.clock.runFor(1600);
  const later = page.locator('.countdown-later li');
  await expect(later.getByRole('group', { name: 'Scheduled leave by' })).toContainText('-6 min');
  await expect(later.getByRole('group', { name: 'Estimated leave by' })).toContainText('-4 min');
  await expect(later.getByRole('group', { name: 'Estimated leave by' })).toContainText('11:47 sailing');
});

test('Catch dims docked Scheduled values with readable contrast across themes and widths', async ({ page }, testInfo) => {
  await catchFixture(page, true);
  const headline = page.locator('.countdown-headline');
  await expect(headline.getByRole('group', { name: 'Scheduled leave by' })).toHaveClass(/is-muted/);
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('Estimated (delay so far)');
  await expect(headline.getByRole('group', { name: 'Estimated leave by' })).toContainText('-15 min');
  for (const theme of ['light', 'dark', 'midnight']) {
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: new RegExp(`^${theme}$`, 'i') }).click();
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
      const contrast = await headline.evaluate((element) => {
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
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
  await page.getByRole('button', { name: /Padding/ }).click();
  await page.getByRole('button', { name: 'Catch traffic' }).click();
  await page.getByRole('option', { name: '15 min', exact: true }).evaluate((element: HTMLElement) => element.click());
  await expect(headline).toContainText('12:20 sailing');
  await expect(headline.locator('.is-muted')).toHaveCount(0);
});