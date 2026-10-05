import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from './types';
import type { AppConfig } from '../types/config';
import { registerConfigHandlers } from './config';
import { registerSharedCredentialHandlers } from './sharedCredentials';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ConfigManager } from '../services/configManager';
import type { SharedCredentials } from '../../../shared/types/sharedCredentials';

const tempDirs: string[] = [];
const paired = { clientId: 'phone-1' };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function registerHost(existingConfig?: Partial<AppConfig>) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-shared-credentials-'));
  tempDirs.push(configDir);
  if (existingConfig) await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(existingConfig));
  vi.stubEnv('PANE_DIR', configDir);
  const configManager = new ConfigManager();
  await configManager.initialize();
  // SAFETY: These handlers read only configManager from the services bag.
  const services = { configManager } as AppServices;
  const registry = new PaneCommandRegistry();
  const ipcMainStub: Pick<IpcMain, 'handle'> = { handle: () => undefined };
  // SAFETY: The config handlers use only ipcMain.handle, which the stub implements.
  registerConfigHandlers(ipcMainStub as IpcMain, services, registry);
  registerSharedCredentialHandlers(services, registry);
  // SAFETY: credentials:shared:* returns SharedCredentials.
  const read = async () => await registry.invokeRemote('credentials:shared:get', [null, paired]) as SharedCredentials;
  const apply = (credentials: SharedCredentials) => registry.invokeRemote('credentials:shared:apply', [credentials, paired]);
  return { configManager, registry, read, apply };
}

describe('shared credentials on a host', () => {
  it('reads a key set on this host with when and where it was set, and leaves env-only keys out', async () => {
    vi.stubEnv('FAL_KEY', 'fal-env-only-fake');
    const { registry, read } = await registerHost();
    const before = Date.now();

    await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: 'dg-fake-1' }]);

    const credentials = await read();
    expect(credentials.deepgramApiKey?.value).toBe('dg-fake-1');
    expect(credentials.deepgramApiKey?.source).toEqual(expect.any(String));
    expect(Date.parse(credentials.deepgramApiKey?.updatedAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(credentials.falApiKey).toBeUndefined();
  });

  it('refuses to read or apply keys for a caller that is not a paired client', async () => {
    const { registry } = await registerHost();

    await expect(registry.invokeRemote('credentials:shared:get', [null])).rejects.toThrow();
    await expect(registry.invokeRemote('credentials:shared:apply', [{}])).rejects.toThrow();
  });

  it('takes a newer key from another host and keeps its own newer key', async () => {
    const { registry, configManager, read, apply } = await registerHost();
    await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: 'dg-local' }]);

    await apply({
      deepgramApiKey: { value: 'dg-stale', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: 'fal-from-mac', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' },
    });

    expect(configManager.getConfig().deepgramApiKey).toBe('dg-local');
    expect(configManager.getConfig().falApiKey).toBe('fal-from-mac');
    expect((await read()).falApiKey).toEqual({ value: 'fal-from-mac', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' });
  });

  it('keeps a cleared key cleared when an older copy arrives', async () => {
    const { configManager, read, apply } = await registerHost();
    const older = { value: 'fal-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' };
    await apply({ falApiKey: older });

    await apply({ falApiKey: { value: null, updatedAt: '2026-02-01T00:00:00.000Z', source: 'Mac' } });
    await apply({ falApiKey: older });

    expect(configManager.getConfig().falApiKey).toBeUndefined();
    expect((await read()).falApiKey).toEqual({ value: null, updatedAt: '2026-02-01T00:00:00.000Z', source: 'Mac' });
  });

  it('records a key removed in desktop settings as cleared', async () => {
    const { configManager, read } = await registerHost();
    await configManager.updateConfig({ openRouterApiKey: 'or-fake-1' });

    await configManager.updateConfig({ openRouterApiKey: undefined });

    expect((await read()).openRouterApiKey?.value).toBeNull();
  });

  it('replaces a key set before sharing existed with any timestamped copy', async () => {
    // A config written by an older Pane: the key has no record of when it was set.
    const { read, apply } = await registerHost({ anthropicApiKey: 'sk-ant-untimed' });
    expect((await read()).anthropicApiKey?.value).toBe('sk-ant-untimed');

    await apply({ anthropicApiKey: { value: 'sk-ant-new', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' } });

    expect((await read()).anthropicApiKey?.value).toBe('sk-ant-new');
  });
});
