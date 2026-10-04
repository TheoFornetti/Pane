import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { CUA_DRIVER_VERSION, createCuaDriverEngine, installCuaDriver, selfTest } from './cuaDriver';
import type { ComputerUseEngine } from './engine';

// A stand-in `cua-driver` that speaks the daemon's line protocol: it answers
// `metadata`, replies to `call` from a canned map, logs each request, and
// exits on `shutdown`.
const FAKE_DRIVER = `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const socketPath = process.argv[process.argv.indexOf('--socket') + 1];
const replies = JSON.parse(fs.readFileSync(process.env.FAKE_CUA_REPLIES, 'utf8'));
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((conn) => {
  let buffer = '';
  conn.on('data', (chunk) => {
    buffer += chunk;
    if (!buffer.includes('\\n')) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
    fs.appendFileSync(process.env.FAKE_CUA_LOG, JSON.stringify(request) + '\\n');
    let reply;
    if (request.method === 'metadata') reply = { ok: true, result: { driver_version: process.env.FAKE_CUA_VERSION, pid: process.pid } };
    else if (request.method === 'shutdown') reply = { ok: true, result: { shutdown: true } };
    else reply = replies[request.name] ?? { ok: false, error: 'unknown tool', exit_code: 1 };
    conn.end(JSON.stringify(reply) + '\\n');
    if (request.method === 'shutdown') { server.close(); process.exit(0); }
  });
});
server.listen(socketPath);
`;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('Cua Driver engine', () => {
  let appDirectory: string;
  let logFile: string;
  let engine: ComputerUseEngine;
  const savedEnv = { ...process.env };

  function useReplies(replies: JsonObject): void {
    const file = path.join(appDirectory, 'replies.json');
    fs.writeFileSync(file, JSON.stringify(replies));
    process.env.FAKE_CUA_REPLIES = file;
  }

  function requests(): Array<{ method: string; name?: string; args?: unknown }> {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  function installFakeDriver(): void {
    const executable = path.join(appDirectory, 'computer-use', 'cua-driver', CUA_DRIVER_VERSION, 'cua-driver');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, FAKE_DRIVER, { mode: 0o755 });
  }

  beforeEach(() => {
    appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cua-'));
    logFile = path.join(appDirectory, 'requests.log');
    process.env.FAKE_CUA_LOG = logFile;
    process.env.FAKE_CUA_VERSION = CUA_DRIVER_VERSION;
    process.env.DISPLAY = ':0';
    useReplies({});
    engine = createCuaDriverEngine({ appDirectory, platform: 'linux' });
  });

  afterEach(async () => {
    await engine.stop();
    process.env = { ...savedEnv };
    fs.rmSync(appDirectory, { recursive: true, force: true });
  });

  it('reports not installed before the helper is installed', async () => {
    const status = await engine.status();
    expect(status).toMatchObject({ installed: false, desktopSession: true });
  });

  it('starts the helper on first use and reports its version', async () => {
    installFakeDriver();
    const status = await engine.status();
    expect(status).toEqual({ installed: true, version: CUA_DRIVER_VERSION, permissions: {}, desktopSession: true });
  });

  it('returns structured data and screenshots from a tool call', async () => {
    installFakeDriver();
    useReplies({
      get_window_state: {
        ok: true,
        result: {
          content: [
            { type: 'text', text: '- [0] AXWindow "Notes"' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          ],
          structuredContent: { window_id: 7, elements: [] },
        },
      },
    });

    const result = await engine.call('get_window_state', { pid: 42, window_id: 7 });

    expect(result).toEqual({
      ok: true,
      data: { window_id: 7, elements: [] },
      images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
    });
    expect(requests().find((r) => r.method === 'call')).toMatchObject({ name: 'get_window_state', args: { pid: 42, window_id: 7 } });
  });

  it("surfaces Cua's error code when a tool refuses", async () => {
    installFakeDriver();
    useReplies({
      scroll: {
        ok: true,
        result: {
          content: [{ type: 'text', text: 'Electron ignores background scroll.' }],
          isError: true,
          structuredContent: { code: 'requires_foreground' },
        },
      },
      list_apps: { ok: false, error: 'permissions_pending: macOS permission is still pending', exit_code: 75 },
    });

    expect(await engine.call('scroll', { pid: 1, window_id: 2 })).toMatchObject({
      ok: false,
      error: { code: 'requires_foreground', message: 'Electron ignores background scroll.' },
    });
    expect(await selfTest(engine)).toMatchObject({ ok: false, error: { code: 'permissions_pending' } });
  });

  it('replaces a running helper of another version', async () => {
    installFakeDriver();
    process.env.FAKE_CUA_VERSION = '0.1.0';
    expect((await engine.status()).version).toBe('0.1.0');

    // A fresh engine (as after a Pane update) finds the old helper on the socket.
    process.env.FAKE_CUA_VERSION = CUA_DRIVER_VERSION;
    const updated = createCuaDriverEngine({ appDirectory, platform: 'linux' });
    expect((await updated.status()).version).toBe(CUA_DRIVER_VERSION);
    expect(requests().filter((r) => r.method === 'shutdown')).toHaveLength(1);
  });

  it('stops the helper', async () => {
    installFakeDriver();
    await engine.status();
    await engine.stop();
    expect(requests().at(-1)?.method).toBe('shutdown');
  });

  it('reports a Linux host with no display and refuses calls without starting the helper', async () => {
    installFakeDriver();
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    expect(await engine.status()).toMatchObject({ installed: true, desktopSession: false });
    expect(await engine.call('list_apps', {})).toMatchObject({ ok: false, error: { code: 'no_desktop_session' } });
    expect(requests()).toEqual([]);
  });
});

describe('installCuaDriver', () => {
  let appDirectory: string;
  let server: http.Server;
  let releaseUrl: string;

  beforeEach(async () => {
    appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cua-install-'));
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cua-archive-'));
    const top = `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64`;
    fs.mkdirSync(path.join(archiveDir, top));
    fs.writeFileSync(path.join(archiveDir, top, 'cua-driver'), 'not the pinned release');
    const archive = path.join(archiveDir, `${top}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', archiveDir, top]);
    server = http.createServer((_req, res) => res.end(fs.readFileSync(archive)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
    releaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(appDirectory, { recursive: true, force: true });
  });

  it('refuses an archive that does not match the pinned checksum and installs nothing', async () => {
    await expect(installCuaDriver({ appDirectory, platform: 'linux', arch: 'x64', releaseUrl })).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(path.join(appDirectory, 'computer-use', 'cua-driver'))).toEqual([]);
  });

  it('names the platform when upstream ships no release for it', async () => {
    await expect(installCuaDriver({ appDirectory, platform: 'freebsd', arch: 'x64', releaseUrl })).rejects.toThrow(
      'Cua Driver has no release for freebsd x64.',
    );
  });
});
