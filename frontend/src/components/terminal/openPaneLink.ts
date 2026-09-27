import { parsePaneLink } from './paneLink';

export async function openPaneLink(uri: string): Promise<void> {
  if (!parsePaneLink(uri)) return;
  const result: { success: boolean; error?: string } = await window.electronAPI.invoke('runpane:links:open', uri);
  if (!result.success) throw new Error(result.error ?? 'Failed to open Pane link');
}

/** Opens a Pane, and optionally one of its panels, when the active host has it. */
export async function openPaneTarget(target: { paneId: string; panelId?: string }): Promise<void> {
  const pane = useSessionStore.getState().sessions.find(session => session.id === target.paneId);
  if (!pane || pane.archived) return;

  if (target.panelId) {
    const panels = await panelApi.loadPanelsForSession(target.paneId);
    if (!panels.some(panel => panel.id === target.panelId)) return;
    await panelApi.setActivePanel(target.paneId, target.panelId);
    usePanelStore.getState().setActivePanel(target.paneId, target.panelId);
  }

  await useSessionStore.getState().setActiveSession(target.paneId);
  useNavigationStore.getState().navigateToSessions();
}
