import { expect, test } from '@playwright/test';

test('persists server-backed Catch and Disruption opt-ins across themes and responsive widths', async ({ page }) => {
    const subscriptions = new Map<string, object>();
    const updates: Array<{ scope: string; enabled: boolean }> = [];
    await page.route('**/api/notifications**', async (route) => {
        const request = route.request();
        const update =
            request.method() === 'PUT'
                ? (request.postDataJSON() as { scope: string; enabled: boolean; settings: object })
                : null;
        const scope = update?.scope ?? new URL(request.url()).searchParams.get('scope') ?? '';
        if (update) {
            updates.push(update);
            subscriptions.set(scope, {
                ...update,
                status: update.enabled ? 'armed' : 'idle',
                targetAt: null,
                lastEventAt: null,
                lastError: null,
            });
        }
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                data: { available: true, subscription: subscriptions.get(scope) ?? null },
                source: 'fixture',
                fetchedAt: new Date().toISOString(),
                raw: null,
            }),
        });
    });
    await page.addInitScript(() => {
        localStorage.setItem(
            'ferry-tracker-favorite-routes',
            JSON.stringify([{ originId: 3, destinationId: 7, label: 'Home to Seattle' }])
        );
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Catch', exact: true }).click();
    const checkbox = page.getByRole('checkbox', { name: 'Notify via Pushover' });
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await page.getByRole('button', { name: 'Pushover notification information' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Monitoring on the server');
    await page.getByRole('tab', { name: 'Disruption', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await page.getByRole('button', { name: 'Pushover notification information' }).click();
    await expect(page.getByRole('tooltip')).toContainText('traffic starts and clears');
    await expect(page.getByRole('button', { name: 'Pushover notification information' })).toBeVisible();
    await expect(page.locator('.notification-control')).toHaveCSS('padding-left', '12px');
    expect(
        await page.locator('.notification-control').evaluate((element) => element.getBoundingClientRect().height)
    ).toBeLessThan(50);
    await page.reload();
    await page.getByRole('tab', { name: 'Disruption', exact: true }).click();
    await expect(checkbox).toBeChecked();
    await page.getByRole('tab', { name: 'Catch', exact: true }).click();
    await expect(checkbox).toBeChecked();

    for (const theme of ['Light', 'Midnight']) {
        await page.getByRole('button', { name: 'Appearance' }).click();
        await page.getByRole('radio', { name: theme, exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
        for (const width of [390, 767, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(checkbox).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await expect(page.locator('select, datalist')).toHaveCount(0);
        }
    }
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    expect(updates.map(({ scope, enabled }) => ({ scope, enabled }))).toEqual([
        { scope: 'catch:3:7', enabled: true },
        { scope: 'disruption', enabled: true },
        { scope: 'catch:3:7', enabled: false },
    ]);
});

test('shows unavailable Pushover configuration without a working checkbox', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Disruption', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Notify via Pushover' })).toBeDisabled();
    const info = page.getByRole('button', { name: 'Pushover notification information' });
    await page.locator('.notification-label').hover();
    await expect(info).toHaveAttribute('aria-expanded', 'false');
    await info.hover();
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('heading', { name: 'Bainbridge Island offload' }).hover();
    await expect(info).toHaveAttribute('aria-expanded', 'false');
    await info.focus();
    await expect(page.getByRole('tooltip')).toContainText('Pushover is unavailable');
    await expect(page.locator('.info-box.is-open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(info).toHaveAttribute('aria-expanded', 'false');
    await info.click();
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('heading', { name: 'Bainbridge Island offload' }).click();
    await expect(info).toHaveAttribute('aria-expanded', 'false');
});
