import { useMutation, useQueryClient } from '@tanstack/react-query';

import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { RemotePwaAffordances, RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { invokeChannel, useDaemon, useDaemonEvent, useDaemonQueryKey, useInvokeQuery } from '@/daemon';

const AFFORDANCES = 'remote:pwa-affordances';

/** What a phone may change on the host: the shortcut list (replaced whole) and voice keys. */
export interface HostSettingsPatch {
  terminalShortcuts?: RemotePwaTerminalShortcut[];
  deepgramApiKey?: string;
  openRouterApiKey?: string;
  falApiKey?: string;
}

/**
 * The host's shortcuts, voice setup and agents. It refetches whenever any
 * client saves settings on the host, so an open list never goes stale.
 */
export function useAffordances() {
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(AFFORDANCES);
  useDaemonEvent('remote:settings-changed', () => void queryClient.invalidateQueries({ queryKey }));
  return useInvokeQuery<RemotePwaAffordances>(AFFORDANCES, [], { staleTime: 5 * 60_000 });
}

/** Saves to the host through `remote:settings:update`. Never retried; see `saveErrorMessage`. */
export function useSaveHostSettings() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(AFFORDANCES);
  return useMutation({
    mutationFn: (patch: HostSettingsPatch) => invokeChannel<RemotePwaAffordances>(client, 'remote:settings:update', [patch]),
    onSuccess: affordances => queryClient.setQueryData(queryKey, affordances),
    // The host may have applied a save whose reply was lost; show what it has.
    onError: () => void queryClient.invalidateQueries({ queryKey }),
  });
}

/** A save error as a sentence. Never includes what was sent, which may be a key. */
export function saveErrorMessage(error: unknown, hostLabel: string): string {
  if (error instanceof RemoteUnconfirmedResultError) return 'The connection dropped before the host answered. Check the list: the change may have saved.';
  const message = error instanceof Error ? error.message : String(error);
  if (isUnknownChannelError(message)) return `Update Pane on ${hostLabel} to change this from your phone.`;
  return message;
}

/** Older hosts answer a channel they don't have with this. */
function isUnknownChannelError(message: string): boolean {
  return message.includes('No Pane daemon command registered');
}
