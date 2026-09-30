// Drives the side-by-side Pane desktop test build against a cloud host already saved in its data dir
// (seed-profile.cjs) and records what a user would see: the host switcher connects to the cloud host, a
// terminal in a Pane on that host prints the cloud machine's hostname, the Claude "morning" Session
// answers a prompt, and the montlakev2 repo is listed. Adapted from ../desktop-switcher-proof.mjs.
//
// Privacy: screenshots are of the app window only (page.screenshot, never the screen); Settings is never
// opened; no Playwright trace is recorded; nothing from config.json but the host label is read or logged.
//
// Runs with the Pane binary itself as Node (no Node install needed), from the relay kit folder that holds
// node_modules/playwright-core:
//   $env:ELECTRON_RUN_AS_NODE = '1'; Pane.exe proof.mjs      (run-proof.ps1 does this)
//
//   PANE_EXE         the test build's Pane.exe (never the installed Pane)
//   PANE_DIR         its data dir (%USERPROFILE%\.pane_cloudtest); never ~/.pane
//   OUT              evidence dir (screenshots, steps.log, results.json)
//   HOST_LABEL       the cloud host's label (default: the only saved profile's label)
//   REPO             repo to open a Pane in (default Hello-World)
//   PANE_NAME        that Pane's name (default sobeck-check)
//   HOSTNAME_PREFIX  what `hostname` must print on the host (default box-node-)
//   SESSION          the Claude Session to prompt (default morning)
//   CLAUDE_REPLY     1 (default) waits for Claude's answer; 0 only opens the Session and submits (CI, no Claude)
//   OPTIONAL_REPO    repo that is only checked when present (default montlakev2): absent = SKIP
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`proof: set ${name}`);
  return env[name];
};
const paneExe = path.resolve(required('PANE_EXE'));
const paneDir = path.resolve(required('PANE_DIR'));
if (paneDir.toLowerCase() === path.join(os.homedir(), '.pane').toLowerCase()) throw new Error('proof: PANE_DIR must not be ~/.pane');
if (/[\\/]Programs[\\/]Pane[\\/]/i.test(paneExe)) throw new Error('proof: PANE_EXE is the installed Pane; use the test build');
const out = path.resolve(required('OUT'));
fs.mkdirSync(out, { recursive: true });

const savedLabels = () => {
  const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
  return (config.remoteDaemon?.client?.profiles ?? []).map((profile) => profile.label);
};
const hostLabel = env.HOST_LABEL || (() => {
  const labels = savedLabels();
  if (labels.length !== 1) throw new Error(`proof: set HOST_LABEL (saved hosts: ${JSON.stringify(labels)})`);
  return labels[0];
})();
const repo = env.REPO || 'Hello-World';
const paneName = env.PANE_NAME || 'sobeck-check';
const hostnamePrefix = (env.HOSTNAME_PREFIX || 'box-node-').toLowerCase();
const sessionName = env.SESSION || 'morning';
const waitForReply = env.CLAUDE_REPLY !== '0';
const optionalRepo = env.OPTIONAL_REPO || 'montlakev2';

const started = Date.now();
const checks = [];
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const check = (name, verdict, detail) => {
  checks.push({ name, verdict, detail });
  log(verdict, name, detail ?? '');
};
const pass = (name, ok, detail) => check(name, ok ? 'PASS' : 'FAIL', detail);

// App console lines go to app-console.log for diagnosis, with every saved host token redacted.
const secrets = (() => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
    return (config.remoteDaemon?.client?.profiles ?? []).map((profile) => profile.token).filter(Boolean);
  } catch {
    return [];
  }
})();
const redact = (text) => secrets.reduce((current, secret) => current.split(secret).join('<redacted>'), text);
const appLog = (source, text) => {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) fs.appendFileSync(path.join(out, 'app-console.log'), `${new Date().toISOString()} [${source}] ${redact(line).slice(0, 500)}\n`);
  }
};

const childEnv = { ...env, PANE_DIR: paneDir };
delete childEnv.ELECTRON_RUN_AS_NODE;
log(`launching ${paneExe} with PANE_DIR=${paneDir}; host "${hostLabel}"`);
const app = await electron.launch({
  executablePath: paneExe,
  // --disable-webgl: xterm falls back to its DOM renderer, whose rows can be read. With WebGL the
  // terminal text is only on a canvas (SOBECK run 1: `hostname` printed but read back as empty).
  args: [`--user-data-dir=${path.join(paneDir, 'chromium-profile')}`, '--disable-webgl'],
  env: childEnv,
  timeout: 120_000,
});
app.process().stdout?.on('data', (chunk) => appLog('main', chunk));
app.process().stderr?.on('data', (chunk) => appLog('main:err', chunk));
const page = await app.firstWindow();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning' || /remote|connect|switch|profile/i.test(message.text())) {
    appLog(`renderer:${message.type()}`, message.text());
  }
});
let shotIndex = 0;
const shot = async (name) => {
  const file = path.join(out, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log('screenshot', path.basename(file));
};

async function dismissFirstRun() {
  for (let round = 0; round < 6; round++) {
    await page.waitForTimeout(800);
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible().catch(() => false)) {
      log('first run: Get Started -> Skip');
      await skip.click();
      continue;
    }
    const welcome = page.getByRole('dialog', { name: 'Welcome to Pane' });
    if (await welcome.isVisible().catch(() => false)) {
      log('first run: Welcome -> Close modal');
      await welcome.getByRole('button', { name: 'Close modal' }).click();
      continue;
    }
    return;
  }
}

// Terminal text two ways: the DOM renderer's rows, and the raw terminal output stream the app's
// preload delivers (independent of the renderer), ANSI escapes stripped.
async function collectTerminalStream() {
  await page.evaluate(() => {
    if (window.__proofStream !== undefined) return;
    window.__proofStream = '';
    window.electronAPI?.events?.onTerminalOutput?.((event) => {
      window.__proofStream += event.output ?? event.data ?? '';
      if (window.__proofStream.length > 400_000) window.__proofStream = window.__proofStream.slice(-200_000);
    });
  }).catch(() => undefined);
}
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g');
const stripAnsi = (text) => text.replace(ANSI, '');
const streamText = async () => stripAnsi(await page.evaluate(() => window.__proofStream ?? '').catch(() => ''));
const domText = () => page.evaluate(() => [...document.querySelectorAll('.xterm-rows')].map((rows) => rows.textContent ?? '').join('\n'));
const terminalText = async () => `${await domText()}\n${await streamText()}`;
async function waitForText(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dom = await domText().catch(() => '');
    const stream = await streamText();
    if (predicate(dom, stream)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(1000);
  }
}
async function typeInLastTerminal(text) {
  const terminal = page.locator('.xterm').last();
  await terminal.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  await terminal.click();
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
}

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  await dismissFirstRun();
  await collectTerminalStream();
  await shot('launched');

  // 1. Host switcher: pick the cloud host, expect it connected.
  const switcherChip = page.getByRole('button', { name: /Switch host$/ }).first();
  await switcherChip.waitFor({ timeout: 60_000 });
  const connectedChip = page.getByRole('button', { name: `Agents run on ${hostLabel}. Switch host` });
  if (!await connectedChip.isVisible().catch(() => false)) {
    await switcherChip.click();
    await page.waitForTimeout(500);
    await shot('switcher-open');
    const hostItem = page.getByRole('menuitemradio', { name: new RegExp(hostLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    pass('switcher-lists-cloud-host', await hostItem.isVisible(), hostLabel);
    await hostItem.click();
  }
  const pickedAt = Date.now();
  const connected = await connectedChip.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  const repoButton = page.getByRole('button', { name: `New pane in ${repo}` });
  const listed = connected && await repoButton.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  pass('host-connected', connected && listed, `switcher names "${hostLabel}"; repo ${repo} listed ${Date.now() - pickedAt} ms after picking`);
  await page.getByRole('button', { name: /Switch host$/ }).first().click();
  await page.waitForTimeout(500);
  await shot('switcher-connected');
  await page.keyboard.press('Escape');

  // 2. Optional repo (montlakev2 once p2-montlake registered it).
  const optional = await page.getByRole('button', { name: `New pane in ${optionalRepo}` })
    .waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check('optional-repo-listed', optional ? 'PASS' : 'SKIP', optional ? `${optionalRepo} listed` : `${optionalRepo} not registered on ${hostLabel} (yet)`);
  if (optional) await shot('repos');

  // 3. A terminal in a Pane on the cloud host.
  const existing = page.getByRole('button', { name: paneName, exact: true });
  if (await existing.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await existing.click();
  } else {
    await repoButton.click();
    const dialog = page.getByRole('dialog', { name: `New Pane in ${repo}` });
    await dialog.getByRole('textbox', { name: 'Enter a name for your pane' }).fill(paneName);
    await dialog.getByRole('button', { name: /^Create/ }).click();
  }
  await page.getByRole('button', { name: /^Terminal Ctrl\+Alt\+1/ }).click({ timeout: 60_000 });
  const domBefore = (await domText().catch(() => '')).length;
  const streamBefore = (await streamText()).length;
  await typeInLastTerminal('hostname');
  const hasPrefix = (text) => text.toLowerCase().split('hostname').slice(1).some((after) => after.includes(hostnamePrefix));
  const printed = await waitForText(
    (dom, stream) => hasPrefix(dom.slice(Math.max(0, domBefore - 200))) || hasPrefix(stream.slice(streamBefore)),
    30_000,
  );
  const text = (await streamText()).slice(streamBefore) || (await domText().catch(() => ''));
  const after = text.slice(text.toLowerCase().lastIndexOf('hostname')).slice(0, 160).replace(/\s+/g, ' ');
  fs.writeFileSync(path.join(out, 'terminal-output.txt'), `${after}\n`);
  pass('terminal-hostname', printed, `${after} (expected "${hostnamePrefix}…"; this machine is ${os.hostname()})`);
  await shot('terminal-hostname');

  // 4. The Claude Session answers.
  const sessionButton = page.getByRole('button', { name: `Open Session ${sessionName}` });
  let sessionListed = await sessionButton.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!sessionListed) {
    // Desktop bug: the Sessions list is loaded once from the runtime at launch and not reloaded when
    // the host switcher changes runtime (SOBECK run 1: only "Pane Chat"). Reloading the window
    // remounts the app on the connected host, as reopening Pane would.
    check('sessions-after-switch', 'WARN', `"${sessionName}" not listed after the host switch until the window reloads (Sessions list not refreshed on host switch)`);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4000);
    await dismissFirstRun();
    await collectTerminalStream();
    const stillConnected = await connectedChip.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    log(`window reloaded; switcher still names "${hostLabel}": ${stillConnected}`);
    sessionListed = await sessionButton.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  }
  pass('session-listed', sessionListed, `Session "${sessionName}" in the sidebar`);
  if (!sessionListed) await shot('sessions-missing');
  if (sessionListed) {
    await sessionButton.click();
    await page.waitForTimeout(3000);
    const a = 100 + Math.floor(Math.random() * 800);
    const b = 100 + Math.floor(Math.random() * 800);
    const expected = `SUM=${a + b}`;
    const streamStart = (await streamText()).length;
    await typeInLastTerminal(`Compute ${a}+${b} and reply with only SUM= followed by the result, nothing else.`);
    log(`prompt submitted to "${sessionName}"; expecting ${expected}`);
    if (waitForReply) {
      // The prompt itself contains "SUM=" but never the sum.
      const answered = await waitForText((dom, stream) => dom.includes(expected) || stream.slice(streamStart).includes(expected), 180_000);
      pass('claude-answers', answered, answered ? `reply contains ${expected}` : `no ${expected} within 180 s`);
    } else {
      check('claude-answers', 'SKIP', 'CLAUDE_REPLY=0 (no Claude on this machine); prompt was submitted');
    }
    await shot('session-reply');
  }
} catch (error) {
  pass('run-completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  await shot('error').catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
  const ok = checks.every((entry) => entry.verdict !== 'FAIL');
  const result = { ok, host: hostLabel, seconds: Math.round((Date.now() - started) / 1000), checks };
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(ok ? 'RESULT PASS' : 'RESULT FAIL');
  process.exitCode = ok ? 0 : 1;
}
