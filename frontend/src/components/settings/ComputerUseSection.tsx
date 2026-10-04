import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { SettingsSection } from '../ui/SettingsSection';
import { SettingRow } from './SettingRow';
import { ComputerUseStatus } from '../ComputerUseStatus';
import { useComputerUseReadiness } from '../../hooks/useComputerUseReadiness';
import {
  COMPUTER_USE_ENGINE_CHOICE_LABELS,
  COMPUTER_USE_ENGINE_CHOICES,
  type ComputerUseEngineChoice,
  type ComputerUseReadiness,
} from '../../../../shared/types/computerUse';
import type { RemotePaneConnectionState } from '../../../../shared/types/remoteDaemon';

function isEngineChoice(value: string): value is ComputerUseEngineChoice {
  return COMPUTER_USE_ENGINE_CHOICES.some((choice) => choice === value);
}

function guidance(readiness: ComputerUseReadiness): string {
  switch (readiness.state) {
    case 'off':
    case 'ready':
      return 'Agents can see and operate apps on this machine in the background with the Pane js tool. Each step leaves a screenshot in the session.';
    case 'installing':
      return 'Installing Cua Driver, the engine that reads and operates apps.';
    case 'needs-permission':
      return `Turn on ${readiness.appName} in System Settings → Privacy & Security → ${readiness.permission}.`;
    case 'no-desktop':
      return 'This machine has no graphical desktop session for agents to operate.';
    case 'failed':
      return 'Pane could not reach the engine on this machine.';
  }
}

/** Per-machine on/off, engine choice and readiness, for whichever machine Pane is connected to. */
export function ComputerUseSection({ connectionState }: { connectionState: RemotePaneConnectionState }) {
  const machine = connectionState.mode === 'remote' ? connectionState.activeProfileLabel ?? 'the remote host' : 'this computer';
  const controller = useComputerUseReadiness(`${connectionState.mode}:${connectionState.activeProfileId ?? ''}:${connectionState.status}`);
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const { readiness } = controller;

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Computer use">
      <SettingRow
        settingId="computer-use"
        label={`Computer use on ${machine}`}
        description={readiness
          ? guidance(readiness)
          : controller.unsupported ? 'Update Pane on this host to use computer use.' : 'Checking this machine…'}
        align="start"
      >
        <div className="flex items-center justify-end gap-3">
          <Select
            value={readiness?.engineChoice ?? 'auto'}
            disabled={!readiness || readiness.state === 'off' || busy}
            onValueChange={(next) => {
              if (isEngineChoice(next)) void act(() => controller.setEnabled(true, next));
            }}
          >
            <SelectTrigger aria-label="Computer use engine" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMPUTER_USE_ENGINE_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>{COMPUTER_USE_ENGINE_CHOICE_LABELS[choice]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Toggle
            aria-label={`Computer use on ${machine}`}
            checked={readiness !== null && readiness.state !== 'off'}
            disabled={!readiness || busy}
            onChange={(enabled) => void act(() => controller.setEnabled(enabled))}
          />
        </div>
      </SettingRow>
      {readiness && (
        <div className="space-y-2 pb-4">
          <div className="flex items-center justify-between gap-3">
            <ComputerUseStatus
              readiness={readiness}
              now={controller.now}
              onAction={readiness.state === 'needs-permission' ? controller.openPermissionSettings : () => setShowDetails((open) => !open)}
            />
            {readiness.state !== 'off' && readiness.state !== 'installing' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                disabled={busy}
                onClick={() => void act(controller.recheck)}
              >
                Check again
              </Button>
            )}
          </div>
          {readiness.state === 'failed' && showDetails && (
            <pre className="whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-secondary p-3 font-mono text-xs text-text-secondary">
              {readiness.detail}
            </pre>
          )}
          {controller.error && <p className="text-xs text-status-error" role="alert">{controller.error}</p>}
        </div>
      )}
    </SettingsSection>
  );
}
