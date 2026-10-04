import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    __paneTestElectronMock: { getInvokeCalls(channel: string): Array<{ args: unknown[] }> };
  }
}

test('retains cleanup failure across reload and exposes an explicit interrupted-script retry', async ({ page }) => {
  await installElectronApiMock(page, {
    initialArchiveProgress: {
      activeCount: 0, totalCount: 1,
      tasks: [{
        sessionId: 'archive-pane', sessionName: 'Archived feature', worktreeName: 'feature', projectName: 'Repository',
        status: 'failed', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z',
        error: 'Archive script was interrupted', cleanupId: 'durable-job', interruptedScript: true,
        attempts: 1, remainingPath: '/repo/worktrees/feature',
      }],
    },
    archiveRetryError: 'Cleanup is not ready to retry',
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Archive Tasks' }).click();
  await expect(page.getByText('Archived; cleanup needs attention')).toBeVisible();
  await expect(page.getByText('/repo/worktrees/feature', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Archive Tasks' }).click();
  const retry = page.getByRole('button', { name: 'Retry cleanup (skip interrupted script)' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Cleanup is not ready to retry' })).toBeVisible();
  const calls = await page.evaluate(() => {
    return window.__paneTestElectronMock.getInvokeCalls('archive:retry-cleanup');
  });
  expect(calls.at(-1)?.args).toEqual(['archive-pane', true]);
});
