import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWrapperVersion } from '../../version';
import { createCallerSecret, mintCallerToken } from './callerAuth';
import { COORDINATOR_UNIT_NAME, defaultCoordinatorHome, loadCoordinatorConfig, readSecretFile } from './config';
import { buildCoordinator, renderSystemdUnit, startCoordinator } from './service';

const USAGE = `Usage: runpane-cloud-coordinator <command> [--config <file>]

The always-on part of \`runpane cloud\`: idle-stop, reconcile (stop + alert only), runaway guard, /cloud/wake.

Commands:
  init --listen-host <tailnet-ip> --api-key-file <file> --managed-prefix <prefix>
       [--self-sandbox-id <id>] [--pinned-version <v>] [--directory-file <file>]
                                  Write a config (0600) and a caller secret if missing
  serve                           Run the HTTP API and the idle-stop / reconcile loops
  install-service [--node <path>] [--entry <path>] [--no-start]
                                  Install and start the ${COORDINATOR_UNIT_NAME} systemd user unit
  mint-token <callerId> --out <file>
                                  Write a caller token (0600). callerId: a cloud Session id, or user:<name>
  reconcile [--dry-run]           One reconcile pass now (prints the report)
  idle-check [--dry-run]          One idle-stop pass now (prints the report)
  status <host>                   Status of a cloud Session without waking it
  wake <host> [--no-wait] [--timeout-ms <ms>]
                                  Wake a cloud Session and wait for /health readiness

Default config: ${path.join('~', '.config', 'runpane-cloud-coordinator', 'config.json')}
`;

interface ParsedCoordinatorArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  '--config', '--listen-host', '--api-key-file', '--managed-prefix', '--self-sandbox-id', '--pinned-version',
  '--directory-file', '--node', '--entry', '--out', '--timeout-ms', '--listen-port',
]);

function parseArgs(argv: readonly string[]): ParsedCoordinatorArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[index + 1];
        if (value === undefined) throw new Error(`${name} requires a value`);
        if (inline === undefined) index += 1;
        flags.set(name, value);
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

function stringFlag(args: ParsedCoordinatorArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function requiredFlag(args: ParsedCoordinatorArgs, name: string): string {
  const value = stringFlag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runCoordinatorCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const configPath = path.resolve(stringFlag(args, '--config') ?? path.join(defaultCoordinatorHome(), 'config.json'));
  const home = path.dirname(configPath);

  switch (args.command) {
    case null:
    case 'help':
      console.log(USAGE);
      return args.command === null ? 2 : 0;

    case 'init': {
      if (fs.existsSync(configPath)) throw new Error(`${configPath} already exists; edit it instead`);
      const config = {
        version: 1,
        listenHost: requiredFlag(args, '--listen-host'),
        listenPort: Number(stringFlag(args, '--listen-port') ?? 47300),
        stateDir: path.join(home, 'state'),
        directoryFile: path.resolve(stringFlag(args, '--directory-file') ?? path.join(home, 'directory.json')),
        secretFile: path.join(home, 'caller-secret'),
        provider: { kind: 'boat', apiKeyFile: path.resolve(requiredFlag(args, '--api-key-file')) },
        managedNamePrefix: requiredFlag(args, '--managed-prefix'),
        selfSandboxId: stringFlag(args, '--self-sandbox-id') ?? null,
        pinnedVersion: stringFlag(args, '--pinned-version') ?? null,
      };
      writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      if (!fs.existsSync(config.secretFile)) writePrivateFile(config.secretFile, `${createCallerSecret()}\n`);
      loadCoordinatorConfig(configPath);
      console.log(`wrote ${configPath} (0600) and caller secret ${config.secretFile}`);
      return 0;
    }

    case 'serve': {
      const config = loadCoordinatorConfig(configPath);
      const running = await startCoordinator(buildCoordinator(config), { version: getWrapperVersion() });
      await new Promise<void>((resolve) => {
        const shutdown = () => resolve();
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
      });
      await running.close();
      return 0;
    }

    case 'install-service': {
      loadCoordinatorConfig(configPath);
      const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      const unitFile = path.join(unitDir, COORDINATOR_UNIT_NAME);
      const unit = renderSystemdUnit({
        nodePath: stringFlag(args, '--node') ?? process.execPath,
        entryPath: path.resolve(stringFlag(args, '--entry') ?? __filename),
        configPath,
      });
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(unitFile, unit);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      if (!args.flags.has('--no-start')) {
        execFileSync('systemctl', ['--user', 'enable', '--now', COORDINATOR_UNIT_NAME], { stdio: 'inherit' });
        try {
          execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'inherit' });
        } catch {
          console.error('warning: loginctl enable-linger failed; the unit stops when you log out');
        }
      }
      console.log(`installed ${unitFile}`);
      return 0;
    }

    case 'mint-token': {
      const callerId = args.positionals[0];
      if (!callerId) throw new Error('mint-token needs a caller id');
      const out = requiredFlag(args, '--out');
      const config = loadCoordinatorConfig(configPath);
      writePrivateFile(path.resolve(out), `${mintCallerToken(readSecretFile(config.secretFile), callerId)}\n`);
      console.log(`wrote the token for ${callerId} to ${out} (0600)`);
      return 0;
    }

    case 'reconcile':
    case 'idle-check': {
      const parts = buildCoordinator(loadCoordinatorConfig(configPath));
      const dryRun = args.flags.has('--dry-run') ? true : undefined;
      const report = args.command === 'reconcile'
        ? await parts.api.reconcile({ dryRun })
        : await parts.api.idleCheck({ dryRun });
      printJson(report);
      return 0;
    }

    case 'status':
    case 'wake': {
      const host = args.positionals[0];
      if (!host) throw new Error(`${args.command} needs a host`);
      const parts = buildCoordinator(loadCoordinatorConfig(configPath));
      const timeout = stringFlag(args, '--timeout-ms');
      const result = args.command === 'status'
        ? await parts.api.status(host)
        : await parts.api.wake(host, { wait: !args.flags.has('--no-wait'), timeoutMs: timeout ? Number(timeout) : undefined });
      printJson(result);
      return result.ok ? 0 : 1;
    }

    default:
      console.error(`unknown command ${args.command}\n\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  runCoordinatorCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`runpane-cloud-coordinator: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
