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
  await expect(page.getByText('176 drv / 202')).toBeVisible();
  await expect(page.getByText('Current vehicle-space reports')).toHaveCount(0);
  await expect(page.locator('.refresh-time')).toContainText('Last refresh');
  expect(sailingSpaceRequests).toBe(0);

  await page.getByRole('button', { name: 'Reverse route' }).click();
  await expect(page.getByRole('button', { name: 'Origin' })).toContainText('Bainbridge Island');
  await expect(page.getByRole('button', { name: 'Destination' })).toContainText('Seattle');
  await expect(page.getByRole('status', { name: 'Loading updated ferry data' })).toBeAttached();
  await expect(page.locator('.view-loading-cover')).toBeVisible();
  await expect(page.getByText('176 drv / 202')).toBeAttached();
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
  // The busy state is transient, so watch for it from the page instead of polling for it after.
  await refreshButton.evaluate((button) => {
    const seen = () => button.classList.contains('is-busy');
    Object.assign(window, { sawBusy: seen() });
    new MutationObserver(() => { if (seen()) Object.assign(window, { sawBusy: true }); })
      .observe(button, { attributes: true, attributeFilter: ['class'] });
  });
  await refreshButton.click();
  // A manual refresh keeps the current view on screen and only marks the button busy.
  await expect.poll(() => page.evaluate(() => (window as unknown as { sawBusy: boolean }).sawBusy)).toBe(true);
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
  const targetGrip = page.getByRole('button', { name: 'Reorder Seattle' });
  // Measure only once both rows are on screen, or the earlier clicks leave the target above the fold.
  await targetGrip.scrollIntoViewIfNeeded();
  const from = (await grip.boundingBox())!;
  const target = (await targetGrip.boundingBox())!;
  expect(target.y).toBeGreaterThan(0);
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

  // The disclosure remembers its state, so a reload can leave it already open.
  const openPadding = async () => {
    const disclosure = page.getByRole('button', { name: /Padding/ });
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  };
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('30 min');
  await expect(page.locator('.catch-timing-custom')).toHaveCount(0);
  await openPadding();

  await expect(page.getByRole('button', { name: 'Catch traffic' })).toHaveText('15 min');
  await expect(page.locator('.catch-timing-total')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('30 min');
  await expect(page.getByRole('button', { name: 'Use settings' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Catch traffic' }).click();
  await page.getByRole('option', { name: '40 min' }).click();
  await page.getByRole('button', { name: 'Catch queue' }).click();
  await page.getByRole('option', { name: '5 min', exact: true }).click();
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('45 min');
  await expect(page.locator('.catch-timing-custom')).toHaveText('Custom');

  // The other favorite route is untouched by the one that was overridden.
  await page.getByRole('group', { name: 'Catch route' }).getByRole('button', { name: 'SEA → BI' }).click();
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('30 min');

  await page.reload();
  await page.getByRole('tab', { name: 'Catch' }).click();
  await openPadding();
  await page.getByRole('group', { name: 'Catch route' }).getByRole('button', { name: 'BI → SEA' }).click();
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('45 min');

  await page.getByRole('button', { name: 'Use settings' }).click();
  await expect(page.getByRole('button', { name: /Padding/ })).toContainText('30 min');
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
  // The card runs the full page width in this mode, the same as the Catch and Disruption cards.
  await expect.poll(async () => (await page.locator('.schedule-node').boundingBox())?.width ?? 0).toBeGreaterThan(720);
  await expect.poll(() => page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().height)).toBeGreaterThan(40);

  await page.getByRole('button', { name: 'Sailings only' }).click();
  await expect(page.locator('.terminal-node')).toBeVisible();
  await expect(page.locator('.schedule-node')).toBeVisible();
});

test('reflows the collapsed sailing list into columns as the page widens', async ({ page }) => {
  // The shared schedule fixture only holds 2 sailings, which can never fill 3 columns. 16 is the
  // count that separates the leftmost-first split (6/5/5) from the browser's own (6/6/4).
  await page.route('**/api/schedule*', async (route) => {
    const start = Date.now() + 45 * 60_000;
    // Every third sailing carries a capacity pill, which is the taller row shape. The dividers
    // still have to land on the same line in every column.
    const data = Array.from({ length: 16 }, (_, index) => ({
      vesselId: 1, vesselName: 'Tacoma',
      departingTime: new Date(start + index * 30 * 60_000).toISOString(),
      arrivingTime: null, departingTerminalId: 7, arrivingTerminalId: 3,
      isCancelled: false,
      driveUpSpaceCount: index % 3 === 0 ? 40 : null, reservableSpaceCount: null, maxSpaceCount: index % 3 === 0 ? 200 : null,
      spaceAvailable: index % 3 === 0, spaceSource: null, spaceObservedAt: null, spaceLeadSeconds: null,
      actualDeparture: null, actualArrival: null, departureDelayMinutes: null, raw: {},
    }));
    await route.fulfill({ json: { data, fetchedAt: new Date().toISOString(), source: 'fixture', raw: null } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sailings only' }).click();
  await expect(page.locator('.sailing-list li')).toHaveCount(16);

  // getComputedStyle().columnCount reads 'auto' under the columns: <width> shorthand, so measure
  // the rendered rows instead. A .current row bleeds 8px, so merge lefts that sit within 16px.
  const layout = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sailing-list li')];
    const box = (li: Element) => li.getBoundingClientRect();
    const lefts = [...new Set(rows.map((li) => Math.round(box(li).left)))].sort((a, b) => a - b);
    const columns = lefts.filter((left, index) => index === 0 || left - lefts[index - 1] > 16);
    const tops = columns.map((left) => rows.filter((li) => Math.abs(box(li).left - left) <= 16).map((li) => Math.round(box(li).top)));
    return {
      counts: tops.map((column) => column.length),
      // Row n starts at the same y in every column, so the dividers read as one line across.
      aligned: tops.every((column) => column.every((top, index) => top === tops[0][index])),
      fits: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });

  for (const [width, counts] of [[390, [16]], [768, [16]], [1024, [8, 8]], [1440, [6, 5, 5]]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await layout()).counts).toEqual([...counts]);
    expect(await layout()).toMatchObject({ aligned: true, fits: true });
  }
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
  await page.getByRole('button', { name: /Padding/ }).click();
  await page.getByRole('button', { name: 'Catch traffic' }).click();
  await page.getByRole('option', { name: '30 min' }).click();
  await expect.poll(() => page.evaluate(() => {
    const tops = [...document.querySelectorAll('.catch-timing-controls > *')].map((element) => Math.round(element.getBoundingClientRect().bottom));
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

    const columns = await page.locator('.relationship-grid:not(.placeholder-grid)').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width < 1024 ? 1 : 5);

    const wrappedSailingRows = await page.locator('.sailing-list .sailing-row > span').evaluateAll((elements) => elements.filter((element) => {
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

test('changes the route in place when a vessel card on Routes is clicked', async ({ page }) => {
  await page.goto('/');
  // The default origin is alphabetically first (Bainbridge Island), so pick Seattle explicitly.
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();
  await expect(page.locator('.terminal-node h2')).toHaveText('Seattle');

  const chimacumCard = page.locator('.vessel-node', { has: page.getByRole('heading', { name: 'Chimacum' }) });
  // The whole card is the click target, not just the vessel name.
  await chimacumCard.click();

  await expect(page.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Origin' })).toContainText('Bremerton');
  await expect(page.getByRole('button', { name: 'Destination' })).toContainText('Seattle');
});

test('opens the Vessels tab and highlights the vessel when a Sailings row is clicked', async ({ page }) => {
  await page.goto('/');
  // Only the Seattle -> Bainbridge Island fixture has sailings, so pick that route explicitly.
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();
  await page.getByRole('tab', { name: 'Sailings' }).click();

  // The row's own aria-label finds it regardless of whether the Vessel column is visible
  // (a phone hides that column, which would also hide the vessel-name button below it).
  const row = page.getByRole('row', { name: 'View Tacoma on the Vessels tab' }).first();
  await row.locator('td').first().click();

  await expect(page.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.data-card.is-highlighted')).toBeVisible();
});

test('opens the Vessels tab from the compact schedule list on Routes', async ({ page }) => {
  await page.goto('/');
  // Only the Seattle -> Bainbridge Island fixture has sailings, so pick that route explicitly.
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();

  const item = page.locator('.sailing-list li', { hasText: 'Tacoma' }).first();
  await item.click();

  await expect(page.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.data-card.is-highlighted')).toBeVisible();
});

test('opens the Sailings tab from the schedule card header on Routes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Sailings schedule/ }).click();
  await expect(page.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
});

test('trims the Sailings table to fit a phone without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // Only the Seattle -> Bainbridge Island fixture has sailings, so pick that route explicitly.
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();
  await page.getByRole('tab', { name: 'Sailings' }).click();
  await expect(page.locator('table')).toBeVisible();

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.col-vessel').first()).toBeHidden();
  await expect(page.locator('.space-detail').first()).toBeHidden();
  // Only a percentage (or a dash) shows in the space column, never the "drive-up" wording.
  const spaceCellText = await page.locator('tbody tr td:last-child').first().innerText();
  expect(spaceCellText).toMatch(/^(\d+%|—)$/);
});

test('resets the scroll position after leaving a tab scrolled down by a highlight jump', async ({ page }) => {
  // Short enough that the Vessels list always overflows, whatever the live fields add up to.
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Origin' }).click();
  await page.getByRole('option', { name: 'Seattle' }).click();

  const item = page.locator('.sailing-list li', { hasText: 'Tacoma' }).first();
  await item.click();
  await expect(page.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Catch' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('switches tabs with bare letter keyboard shortcuts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('c');
  await expect(page.getByRole('tabpanel', { name: 'Catch' })).toBeVisible();

  await page.keyboard.press('s');
  await expect(page.getByRole('tabpanel', { name: 'Sailings' })).toBeVisible();

  // Settings takes its 2nd letter since Sailings already claims "s".
  await page.keyboard.press('a');
  await expect(page.getByRole('tabpanel', { name: 'Settings' })).toBeVisible();

  await page.keyboard.press('r');
  await expect(page.getByRole('tabpanel', { name: 'Routes' })).toBeVisible();
});