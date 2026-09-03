import { expect, test } from '@playwright/test';

test('shows the terminal to ferry to schedule routes view without external network', async ({ page }) => {
  let sailingSpaceRequests = 0;
  let scheduleRequests = 0;
  let releaseChangedRoute!: () => void;
  const changedRouteGate = new Promise<void>((resolve) => { releaseChangedRoute = resolve; });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sailing-spaces') sailingSpaceRequests += 1;
    if (url.pathname === '/api/schedule') scheduleRequests += 1;
    if (url.pathname === '/api/schedule' && url.searchParams.get('departingTerminalId') === '3') await changedRouteGate;
    if (url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect.poll(() => page.getByRole('listbox', { name: 'Terminal' }).evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('thin');
  await page.getByRole('option', { name: 'Seattle' }).click();
  await expect(page.locator('.terminal-node h2')).toHaveText('Seattle');
  const tacomaVessel = page.locator('.vessel-node', { has: page.getByRole('heading', { name: 'Tacoma' }) });
  await expect(tacomaVessel).toBeVisible();
  await expect(tacomaVessel.getByText('Updated')).toBeVisible();
  await expect(page.getByText(/TerminalID|VesselID/)).toHaveCount(0);
  await expect(page.locator('.schedule-node h2')).toHaveText('Seattle to Bainbridge Island');
  await expect(page.getByText('176 drive-up / 202')).toBeVisible();
  await expect(page.getByText('Current vehicle-space reports')).toHaveCount(0);
  await expect(page.locator('.refresh-time')).toContainText('Last refresh');
  expect(sailingSpaceRequests).toBe(0);

  await page.getByRole('button', { name: 'Reverse route' }).click();
  await expect(page.getByRole('button', { name: 'Terminal' })).toContainText('Bainbridge Island');
  await expect(page.getByRole('button', { name: 'Associated destination' })).toContainText('Seattle');
  await expect(page.getByRole('status', { name: 'Loading updated ferry data' })).toBeAttached();
  await expect(page.locator('.view-loading-cover')).toBeVisible();
  await expect(page.getByText('176 drive-up / 202')).toBeAttached();
  releaseChangedRoute();
  const opacitySamples = await page.evaluate(() => new Promise<Array<{ cover: number; content: number }>>((resolve) => {
    const samples: Array<{ cover: number; content: number }> = [];
    const sample = () => {
      const cover = document.querySelector<HTMLElement>('.view-loading-cover');
      const content = document.querySelector<HTMLElement>('.view-content > :not(.view-loading-cover)');
      if (!cover || !content) {
        resolve(samples);
        return;
      }
      samples.push({
        cover: Number.parseFloat(getComputedStyle(cover).opacity),
        content: Number.parseFloat(getComputedStyle(content).opacity),
      });
      requestAnimationFrame(sample);
    };
    sample();
  }));
  expect(opacitySamples.some(({ cover, content }) => cover < 0.2 && content > 0.05 && content < 0.85), JSON.stringify(opacitySamples)).toBe(true);
  await expect(page.locator('.view-loading-cover')).toBeHidden();
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');

  const callsBeforeRefresh = scheduleRequests;
  const refreshStartedAt = Date.now();
  const refreshButton = page.getByRole('button', { name: 'Refresh data' });
  await refreshButton.click();
  // A manual refresh keeps the current view on screen and only marks the button busy.
  await expect(refreshButton).toHaveClass(/is-busy/);
  await expect(page.locator('.view-loading-cover')).toHaveCount(0);
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
  await expect(page.locator('.spin')).toHaveCount(0);
  await expect.poll(() => scheduleRequests).toBeGreaterThan(callsBeforeRefresh);
  await expect(refreshButton).not.toHaveClass(/is-busy/);
  expect(Date.now() - refreshStartedAt).toBeGreaterThanOrEqual(500);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('persists a selected theme and exposes semantic keyboard tabs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const routes = page.getByRole('tab', { name: 'Routes' });
  await routes.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Terminals' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Terminals' })).toBeVisible();
});

test('persists favorite terminals and sorts them first', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();
  await page.getByRole('button', { name: 'Add Seattle to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Seattle from favorites' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-favorite-terminals'))).toContain('7');

  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.getByRole('option').first()).toHaveAccessibleName('Seattle');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.getByRole('option').first()).toHaveAccessibleName('Seattle');
  await page.getByRole('option', { name: 'Seattle' }).click();
  await expect(page.getByRole('button', { name: 'Remove Seattle from favorites' })).toHaveAttribute('aria-pressed', 'true');
});

test('reopens on the terminal and destination chosen before the reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal' }).click();
  await page.getByRole('option', { name: 'Bainbridge Island' }).click();
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-last-route'))).toBe('{"terminalId":3,"destinationId":7}');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Terminal' })).toContainText('Bainbridge Island');
  await expect(page.getByRole('button', { name: 'Associated destination' })).toContainText('Seattle');
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
});

for (const width of [390, 767, 768, 1024, 1440]) {
  test(`keeps the explorer usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const columns = await page.locator('.relationship-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width < 1024 ? 1 : 5);

    const wrappedSailingRows = await page.locator('.sailing-list li > span').evaluateAll((elements) => elements.filter((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height > lineHeight * 1.5;
    }).map((element) => element.textContent ?? ''));
    expect(wrappedSailingRows, `wrapped at ${width}px`).toEqual([]);

    await page.getByRole('button', { name: 'Appearance' }).click();
    const bounds = await page.getByRole('dialog', { name: 'Appearance settings' }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  });
}