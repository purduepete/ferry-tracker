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
  await page.getByRole('button', { name: 'Origin' }).click();
  await expect.poll(() => page.getByRole('listbox', { name: 'Origin' }).evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('thin');
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
  await expect(page.getByRole('button', { name: 'Origin' })).toContainText('Bainbridge Island');
  await expect(page.getByRole('button', { name: 'Destination' })).toContainText('Seattle');
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
  await expect(page.getByRole('tab', { name: 'Catch' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Catch' })).toBeVisible();
});

test('sets favorite terminals and their order from Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Settings' }).click();    await page.getByRole('button', { name: /Favorite terminals/ }).click();  await page.getByRole('button', { name: 'Add Seattle to favorites' }).click();
  await page.getByRole('button', { name: 'Add Bainbridge Island to favorites' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-favorite-terminals'))).toBe('[7,3]');

  const grip = page.getByRole('button', { name: 'Reorder Bainbridge Island' });
  const from = (await grip.boundingBox())!;
  const target = (await page.getByRole('button', { name: 'Reorder Seattle' }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-favorite-terminals'))).toBe('[3,7]');

  // The same move without a pointer, because the grip has to work from the keyboard too.
  await page.getByRole('button', { name: 'Reorder Seattle' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-favorite-terminals'))).toBe('[7,3]');

  await page.reload();
  await page.getByRole('button', { name: 'Origin' }).click();
  await expect(page.getByRole('option').first()).toHaveAccessibleName('Seattle');
  await expect(page.getByRole('option').nth(1)).toHaveAccessibleName('Bainbridge Island');
});

test('saves a favorite route and drives the Catch tab with it', async ({ page }) => {
  await page.goto('/');

  // Seeded on the first visit, and one click puts that route in the selectors.
  await expect(page.locator('.route-chip')).toHaveText(['BI → SEA', 'SEA → BI']);
  await page.getByRole('button', { name: 'BI → SEA' }).click();
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
  await expect(page.getByRole('button', { name: 'BI → SEA' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Favorite routes/ }).click();
  await page.getByRole('textbox', { name: 'Label for Bainbridge Island to Seattle' }).fill('Morning');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-favorite-routes'))).toContain('Morning');

  await page.getByRole('button', { name: 'Reorder Seattle to Bainbridge Island' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.favorite-route-list li')).toHaveCount(2);
  await expect(page.locator('.favorite-route-list .favorite-pair').first()).toHaveText('Seattle to Bainbridge Island');

  await page.getByRole('tab', { name: 'Catch' }).click();
  await expect(page.getByRole('heading', { name: 'SEA → BI' })).toBeVisible();
  await page.getByRole('group', { name: 'Catch route' }).getByRole('button', { name: 'Morning' }).click();
  await expect(page.getByRole('heading', { name: 'Morning' })).toBeVisible();

  // The choice outlives the reload, so the phone opens on the route it was left on.
  await page.reload();
  await page.getByRole('tab', { name: 'Catch' }).click();
  await expect(page.getByRole('heading', { name: 'Morning' })).toBeVisible();
});

test('overrides the Catch padding for one route and resets it back to the settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Catch' }).click();

  await expect(page.getByRole('button', { name: 'Catch traffic' })).toHaveText('15 min');
  await expect(page.locator('.catch-timing-total')).toHaveText('30 min padding');
  await expect(page.getByRole('button', { name: 'Use settings' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Catch traffic' }).click();
  await page.getByRole('option', { name: '40 min' }).click();
  await page.getByRole('button', { name: 'Catch queue' }).click();
  await page.getByRole('option', { name: '5 min', exact: true }).click();
  await expect(page.locator('.catch-timing-total')).toHaveText('45 min padding for this route');

  // The other favorite route is untouched by the one that was overridden.
  await page.getByRole('group', { name: 'Catch route' }).getByRole('button', { name: 'SEA → BI' }).click();
  await expect(page.locator('.catch-timing-total')).toHaveText('30 min padding');

  await page.reload();
  await page.getByRole('tab', { name: 'Catch' }).click();
  await page.getByRole('group', { name: 'Catch route' }).getByRole('button', { name: 'BI → SEA' }).click();
  await expect(page.locator('.catch-timing-total')).toHaveText('45 min padding for this route');

  await page.getByRole('button', { name: 'Use settings' }).click();
  await expect(page.locator('.catch-timing-total')).toHaveText('30 min padding');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-catch-overrides'))).toBe('{}');
});

test('reopens on the terminal and destination chosen before the reload', async ({ page }) => {  await page.goto('/');
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Bainbridge Island' }).click();
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ferry-tracker-last-route'))).toBe('{"terminalId":3,"destinationId":7}');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Origin' })).toContainText('Bainbridge Island');
  await expect(page.getByRole('button', { name: 'Destination' })).toContainText('Seattle');
  await expect(page.locator('.schedule-node h2')).toHaveText('Bainbridge Island to Seattle');
});

test('collapses the routes view to the sailings schedule at any width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Sailings only' });
  await expect(page.locator('.terminal-node')).toBeVisible();

  // "Bainbridge Island" is the longest terminal name, so it decides whether the compact row clips.
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Bainbridge Island' }).click();
  await expect(page.locator('.selectors .filter-select-trigger span').first()).toHaveText('Bainbridge Island');
  const clipped = await page.locator('.selectors .filter-select-trigger span').evaluateAll((spans) => spans.filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent ?? ''));
  expect(clipped).toEqual([]);

  await toggle.click();
  await expect(page.locator('.schedule-node')).toBeVisible();
  await expect(page.locator('.terminal-node')).toBeHidden();
  await expect(page.locator('.vessel-stack')).toBeHidden();
  await expect(page.locator('.relationship-link').first()).toBeHidden();
  await expect(page.getByRole('button', { name: 'Day' })).toBeHidden();
  // The favorite chips replace the selectors on a phone, which is the whole point of the mode.
  await expect(page.getByRole('button', { name: 'Origin' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Destination' })).toBeHidden();
  await expect(page.locator('.route-chip').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Neither the tab bar nor the band slides under the navbar, so both stay reachable from anywhere
  // in the schedule. Assert the relationship rather than an exact offset: the fixture schedule is
  // sometimes short enough that there is nothing to scroll, and both then sit at their natural spot.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => {
    const band = document.querySelector('.selection-band')!.getBoundingClientRect();
    const tabs = document.querySelector('.tabs')!.getBoundingClientRect();
    const header = document.querySelector('.app-header')!.getBoundingClientRect();
    return tabs.top >= header.bottom - 2 && band.top >= tabs.bottom - 2 && band.bottom <= window.innerHeight;
  })).toBe(true);
  await expect(page.getByRole('tab', { name: 'Catch' })).toBeInViewport();
  await expect(page.locator('.route-chip').first()).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Sailings and vessel positions' })).toBeAttached();
  // The title goes off screen rather than away, so its IDREF still resolves. The tab bar stays.
  await expect.poll(() => page.evaluate(() => document.querySelector('.route-title')!.getBoundingClientRect().height)).toBeLessThan(2);
  await expect.poll(() => page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().height)).toBeGreaterThan(40);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sailings only' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-node')).toBeHidden();

  // A desktop width keeps the collapse, the toggle and the selectors; only the phone concessions go.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.terminal-node')).toBeHidden();
  await expect(page.locator('.vessel-stack')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Day' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sailings only' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().height)).toBeGreaterThan(40);

  await page.getByRole('button', { name: 'Sailings only' }).click();
  await expect(page.locator('.terminal-node')).toBeVisible();
  await expect(page.locator('.schedule-node')).toBeVisible();
});

test('drops the tab labels and the route selectors on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  // The label is clipped rather than removed, so the tab keeps the accessible name its panel points at.
  const catchTab = page.getByRole('tab', { name: 'Catch' });
  await expect(catchTab.locator('svg')).toBeVisible();
  await expect.poll(() => catchTab.locator('.tab-label').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(2);

  const tabsLeadTheBand = () => page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().bottom <= document.querySelector('.selection-band')!.getBoundingClientRect().top);
  await expect.poll(tabsLeadTheBand).toBe(true);

  await expect(page.getByRole('button', { name: 'Origin' })).toBeVisible();
  await catchTab.click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Destination' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Day' })).toBeHidden();
  await expect(page.getByRole('tabpanel', { name: 'Catch' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The padding controls stay on one row, so the total and the reset sit level with the selects.
  await page.getByRole('button', { name: 'Catch traffic' }).click();
  await page.getByRole('option', { name: '30 min' }).click();
  await expect.poll(() => page.evaluate(() => {
    const tops = [...document.querySelectorAll('.catch-timing > *')].map((element) => Math.round(element.getBoundingClientRect().bottom));
    return new Set(tops).size;
  })).toBe(1);
  await expect(page.getByRole('button', { name: 'Use settings' })).toBeVisible();
  await expect.poll(() => page.locator('.catch-timing-reset').evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeLessThan(50);
  await page.getByRole('button', { name: 'Use settings' }).click();

  await page.getByRole('tab', { name: 'Disruption' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeHidden();

  await page.getByRole('tab', { name: 'Routes' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeVisible();

  // Every phone tab that shows the selectors shows the compact ones, not only sailings-only Routes.
  const compactSelectors = () => page.evaluate(() => {
    const trigger = document.querySelector('.selectors .filter-select-trigger')!.getBoundingClientRect().height;
    const label = document.querySelector('.selectors label > span')!.getBoundingClientRect().height;
    const title = document.querySelector('.route-title')!.getBoundingClientRect().height;
    return { trigger: Math.round(trigger), labelShown: label > 1, titleShown: title > 1 };
  });
  expect(await compactSelectors()).toEqual({ trigger: 36, labelShown: false, titleShown: false });
  await page.getByRole('tab', { name: 'Sailings' }).click();
  await expect(page.getByRole('button', { name: 'Day' })).toBeVisible();
  expect(await compactSelectors()).toEqual({ trigger: 36, labelShown: false, titleShown: false });

  // Settings has no route, so the whole band goes.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Day' })).toBeHidden();

  // Desktop keeps the words and the selectors, but a routeless tab still drops the band.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Catch' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeHidden();
  await expect.poll(() => catchTab.locator('.tab-label').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(20);

  await page.getByRole('tab', { name: 'Routes' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toBeVisible();
  await expect.poll(tabsLeadTheBand).toBe(true);
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