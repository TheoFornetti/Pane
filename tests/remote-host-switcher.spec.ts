import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

async function saveHost(page: Page, connect: boolean) {
  await page.evaluate(async (connect) => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'mac', label: 'parsas mac pro', baseUrl: 'https://parsas-macbook-pro.example.ts.net',
      token: 'synthetic', transport: 'http+sse',
    });
    if (connect) {
      await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'mac' });
    }
  }, connect);
}

test('the header chip names the connected host and switches back to this computer', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch host$/ })).toHaveCount(0);

  await saveHost(page, true);
  const chip = page.getByRole('button', { name: 'Agents run on parsas mac pro. Switch host' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('chip-open.png') });

  await page.getByRole('menuitemradio', { name: /This computer/ }).click();
  await expect(page.getByRole('button', { name: 'Agents run on This computer. Switch host' })).toBeVisible();
});

test('the collapsed rail dot opens the switcher once a host is saved', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();

  await saveHost(page, true);
  await page.getByRole('button', { name: 'Connected to remote runtime', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('rail-open.png') });

  await page.getByRole('button', { name: 'Manage connections…' }).click();
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
});
