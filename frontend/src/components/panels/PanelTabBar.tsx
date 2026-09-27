import React, { useCallback, memo, useState, useEffect, useMemo } from 'react';
import { PanelRight, Play } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { useHotkey } from '../../hooks/useHotkey';
import { PanelTabBarProps, PanelCreateOptions } from '../../types/panelComponents';
import { ToolPanel, ToolPanelType } from '../../../../shared/types/panels';
import { useSession } from '../../contexts/SessionContext';
import { useConfigStore } from '../../stores/configStore';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { Tooltip } from '../ui/Tooltip';
import { useTitleBarSlotStore } from '../../stores/titleBarSlotStore';
import { Kbd } from '../ui/Kbd';
import { PanelTabStrip } from './PanelTabStrip';
import { PromoteChatButton } from './PromoteChatButton';
import { AddToolMenu } from './AddToolMenu';
import type { WorktreeFileSyncEntry } from '../../../../shared/types/worktreeFileSync';


// Build prompt for setting up intelligent dev command — adapts based on Worktree File Sync config
function buildSetupRunScriptPrompt(fileSyncEntries?: WorktreeFileSyncEntry[]): string {
  const nodeModulesEnabled = fileSyncEntries?.some(e => e.path === 'node_modules' && e.enabled) ?? true;
  const envEnabled = fileSyncEntries?.some(e => e.path.startsWith('.env') && e.enabled) ?? true;

  const depsStep = nodeModulesEnabled
    ? '3. Dependencies are pre-installed by Pane (node_modules is copied and install runs automatically in new worktrees). Just verify freshness — if the lock file has changed since node_modules was last updated, re-run the appropriate install command'
    : '3. Auto-detects if deps need installing (package.json mtime > node_modules mtime)';

  const envNote = envEnabled
    ? '\n- Environment files (.env, .env.local, etc.) are automatically copied from the main repo by Pane — do not prompt the user to create them or warn about missing env files'
    : '';

  return `I use Pane to manage multiple AI coding sessions with git worktrees.
Each worktree needs its own dev server on a unique port.

Create scripts/pane-run-script.js (Node.js, cross-platform) that:
1. Auto-detects git worktrees vs main repo
2. Assigns ports from the PANE_PORT environment variable that Pane injects into every pane terminal: each pane gets its own block of 10 ports starting at PANE_PORT, so PANE_PORT, PANE_PORT+1, ... PANE_PORT+9 are safe to use. Falls back to hash(cwd) % 1000 + base_port (separate ranges for main vs worktrees) only if PANE_PORT is unset
${depsStep}
4. Auto-detects if build is stale (src mtime > dist mtime)
5. Clean Ctrl+C termination (taskkill on Windows, SIGTERM on Unix)
6. Auto-detects project type (package.json, requirements.txt, Cargo.toml, go.mod, etc.)
7. Prints the URL/port being used so user knows where to access the app

CRITICAL EDGE CASES — these cause the most bugs:
- Port availability checks MUST test BOTH 0.0.0.0 AND :: (IPv6) — dev servers often bind to :: (all interfaces), so a check on 127.0.0.1 alone passes but the server fails with EADDRINUSE
- Before auto-incrementing to a new port, try to RECLAIM the preferred port by finding the PID holding it (lsof/netstat), verifying it belongs to this project's dev server (match the command line against the project directory or dev server binary), and only then killing it — never kill unrelated processes
- Clean up stale framework lock files before starting (.next/dev/lock, .cache/lock, .vite/ temp files, etc.) — these are left by crashed/killed sessions and prevent restart
- Cross-platform process management (taskkill /F /T on Windows, kill process group on Unix)${envNote}

Analyze this project's actual framework and structure first, then create the complete pane-run-script.js tailored to it.

IMPORTANT: After creating the script, TEST THE RESTART PATH — run 'node scripts/pane-run-script.js', then kill it ungracefully (Ctrl+C or kill the terminal), then run it again. It must reclaim the same port without EADDRINUSE or lock file errors. A single happy-path run proves nothing. Then commit and merge to main so all future worktrees have it.`;
}


export const PanelTabBar: React.FC<PanelTabBarProps> = memo(({
  panels,
  activePanel,
  onPanelSelect,
  onPanelClose,
  onPanelCreate,
  onShowExplorer,
  projectEnvironment,
  context = 'worktree',  // Default to worktree for backward compatibility
  onToggleDetailPanel,
  detailPanelVisible,
  detailPanelToggleDisabled = false,
  detailPanelToggleDisabledReason = 'Unavailable in this view',
  // Optional split tab group integration
  primaryGroupPanels,
  primaryGroupActivePanelId,
  primaryGroupFocused,
  tabsInGroups = false,
  onDragStart,
  onDragEnd,
  onStripDrop,
  isTabDragging,
  draggedPanelId,
  getPanelTabPresentation,
}) => {
  const sessionContext = useSession();
  const session = sessionContext?.session;
  const [resolvedRunScript, setResolvedRunScript] = useState<{ command: string; source: string } | null>(null);
  const { config, fetchConfig } = useConfigStore();
  const trailingSlot = useTitleBarSlotStore((state) => state.trailingSlot);
  // Rename state moved to PanelTabStrip

  // Activity status moved to PanelTabStrip

  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);

  // Load config on mount if not already loaded
  useEffect(() => {
    if (!config) {
      fetchConfig();
    }
  }, [config, fetchConfig]);

  // Resolve run script for current session — re-resolves on session change or project settings update
  const [resolveKey, setResolveKey] = useState(0);
  useEffect(() => {
    const handler = () => setResolveKey(k => k + 1);
    window.addEventListener('project-settings-updated', handler);
    return () => window.removeEventListener('project-settings-updated', handler);
  }, []);
  useEffect(() => {
    const currentSessionId = session?.id;
    if (!currentSessionId) {
      setResolvedRunScript(null);
      return;
    }
    let cancelled = false;
    window.electronAPI?.projects.resolveRunScript(currentSessionId).then((result: { success: boolean; data?: { command: string; source: string } | null }) => {
      if (cancelled) return;
      if (result?.success) {
        setResolvedRunScript(result.data ?? null);
      }
    }).catch(() => {
      if (!cancelled) setResolvedRunScript(null);
    });
    return () => { cancelled = true; };
  }, [session?.id, resolveKey]);

  

  // Memoize event handlers to prevent unnecessary re-renders
  const handlePanelClick = useCallback((panel: ToolPanel) => {
    onPanelSelect(panel);
  }, [onPanelSelect]);

  // PanelTabStrip owns stopPropagation and the logs-running close guard
  const handlePanelClose = useCallback((panel: ToolPanel) => {
    onPanelClose(panel);
  }, [onPanelClose]);
  
  const handleAddPanel = useCallback((type: ToolPanelType, options?: PanelCreateOptions) => {
    onPanelCreate(type, options);
  }, [onPanelCreate]);
  
  // Rename handlers moved to PanelTabStrip
  




  

  /**
   * Run Dev Server — Play button handler (also triggered by Ctrl+Shift+D hotkey).
   *
   * Behavior depends on whether a run script was resolved:
   *
   * 1. If resolved: runs the resolved command in a terminal panel.
   *    Resolution is done by `projects:resolve-run-script` IPC (see project.ts)
   *    which checks, in order:
   *      - DB run_script (Project Settings)
   *      - pane.json scripts.run
   *      - conductor.json scripts.run
   *      - .gitpod.yml first task command
   *      - devcontainer.json postStartCommand
   *      - scripts/pane-run-script.js in the worktree
   *
   * 2. If nothing resolved: launches Claude to auto-generate a run script
   *    tailored to the project's framework (the "Setup Run Script" flow).
   *
   * The tooltip shows which command will run and its source (e.g. "from pane.json").
   */
  const handleRunDevServer = useCallback(async () => {
    if (!session) return;
    if (resolvedRunScript) {
      handleAddPanel('terminal', {
        initialCommand: resolvedRunScript.command,
        title: 'Dev Server'
      });
    } else {
      // No run script resolved — let Claude set one up
      handleAddPanel('terminal', {
        initialCommand: `claude --dangerously-skip-permissions "${buildSetupRunScriptPrompt(config?.worktreeFileSync).replace(/\n/g, ' ')}"`,
        title: 'Setup Run Script'
      });
    }
  }, [session, handleAddPanel, resolvedRunScript, config?.worktreeFileSync]);

  // Ctrl+Shift+D: Run Dev Server
  useHotkey({
    id: 'run-dev-server',
    label: 'Run Dev Server',
    keys: 'mod+shift+d',
    category: 'tools',
    action: handleRunDevServer,
    enabled: () => !!session,
  });

  

  // Whether a tab drag is hovering the bar (drives the un-split affordance)
  const [dragOverBar, setDragOverBar] = useState(false);
  useEffect(() => {
    if (!isTabDragging) setDragOverBar(false);
  }, [isTabDragging]);

  // Sort panels: explorer first, diff second, then by position
  const sortedPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'explorer') return 0;
      if (type === 'diff') return 1;
      if (type === 'browser') return 2;
      return 3;
    };
    return [...panels].sort((a, b) => {
      const orderDiff = typeOrder(a.type) - typeOrder(b.type);
      if (orderDiff !== 0) return orderDiff;
      return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
    });
  }, [panels]);

  const rightActions = (
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          {activePanel && <PromoteChatButton key={activePanel.id} panel={activePanel} paneName={session?.name} />}
          {/* Run Dev Server button */}
          {session && (
            <Tooltip content={
                <span className="flex flex-col items-start gap-1">
                  <span className="text-text-secondary">
                    {resolvedRunScript
                      ? `Run: ${resolvedRunScript.command}`
                      : 'Set up run script (via Claude)'}
                  </span>
                  {resolvedRunScript && (
                    <span className="text-text-tertiary text-[10px]">from {resolvedRunScript.source}</span>
                  )}
                  {hotkeyDisplay('run-dev-server') && <Kbd size="xs" variant="muted" className="origin-left scale-[0.8]">{hotkeyDisplay('run-dev-server')}</Kbd>}
                </span>
              } side="bottom">
              <button
                type="button"
                aria-label={resolvedRunScript ? `Run ${resolvedRunScript.command}` : 'Set up run script'}
                className="inline-flex items-center justify-center h-[var(--panel-tab-height)] px-2.5 rounded text-text-tertiary hover:text-status-success hover:bg-surface-hover transition-colors flex-shrink-0"
                onClick={handleRunDevServer}
              >
                <Play aria-hidden="true" className="w-4 h-4" />
              </button>
            </Tooltip>
          )}

          {/* Detail panel toggle */}
          {onToggleDetailPanel && (
            <Tooltip
              content={detailPanelToggleDisabled
                ? detailPanelToggleDisabledReason
                : (
                  <span className="flex items-center gap-2">
                    <span>{detailPanelVisible ? 'Hide details' : 'Show details'}</span>
                    {hotkeyDisplay('toggle-detail-panel') && (
                      <Kbd size="xs" variant="muted">{hotkeyDisplay('toggle-detail-panel')}</Kbd>
                    )}
                  </span>
                )}
              side="bottom"
            >
              <button
                type="button"
                onClick={detailPanelToggleDisabled ? undefined : onToggleDetailPanel}
                disabled={detailPanelToggleDisabled}
                aria-disabled={detailPanelToggleDisabled}
                aria-label={detailPanelToggleDisabled
                  ? detailPanelToggleDisabledReason
                  : detailPanelVisible ? 'Hide details' : 'Show details'}
                className={cn(
                  "inline-flex items-center justify-center h-[var(--panel-tab-height)] w-[var(--panel-tab-height)] rounded-md transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle",
                  detailPanelToggleDisabled
                    ? "text-text-muted cursor-not-allowed opacity-50"
                    : detailPanelVisible
                    ? "text-text-primary bg-surface-hover hover:text-interactive"
                    : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
                )}
              >
                <PanelRight aria-hidden="true" className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
  );

  // Once the pane is split every tab lives in its group strip, and the top-edge
  // strips become the title row, so this bar takes no space at all. It stays
  // mounted for the add-tool menu and the title bar controls; during a tab drag
  // a floating target offers the merge-all drop instead. Native-framed Linux
  // (no title bar controls) keeps the full bar.
  const barCollapsed = tabsInGroups && !!trailingSlot;

  return (
    <>
    <div className={cn(
      "panel-tab-bar bg-bg-chrome flex-shrink-0",
      trailingSlot && "panel-tab-bar-with-title-controls",
      barCollapsed && (isTabDragging ? "relative z-20 h-0 border-b-0" : "hidden"),
    )}>
      {barCollapsed && isTabDragging && (
        <div
          role="presentation"
          className={cn(
            "absolute left-1/2 top-1 -translate-x-1/2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border shadow-dropdown",
            dragOverBar
              ? "bg-surface-selected border-[color-mix(in_srgb,var(--color-interactive-primary)_60%,transparent)] text-text-primary"
              : "bg-surface-primary border-border-primary text-text-secondary",
          )}
          onDragOver={event => { event.preventDefault(); setDragOverBar(true); }}
          onDragLeave={() => setDragOverBar(false)}
          onDrop={event => {
            event.preventDefault();
            setDragOverBar(false);
            if (draggedPanelId) onStripDrop?.(draggedPanelId, 0);
          }}
        >
          Drop here to merge all tabs
        </div>
      )}
      {/* Flex container */}
      <div
        className={cn("relative flex min-h-[38px] items-center", trailingSlot ? "pr-28" : "pr-2", barCollapsed && "hidden")}
        onDragOver={tabsInGroups && isTabDragging ? () => setDragOverBar(true) : undefined}
        onDragLeave={tabsInGroups && isTabDragging ? () => setDragOverBar(false) : undefined}
      >
        {/* Un-split affordance: dropping a tab on the top bar while split
            merges every group back into the primary group. Advertise that
            while a drag hovers the bar (pointer-events-none so drops pass
            through to the strip). */}
        {tabsInGroups && isTabDragging && dragOverBar && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-surface-primary border border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] text-text-secondary shadow-dropdown">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <line x1="8" y1="2.5" x2="8" y2="13.5" strokeDasharray="2 2" opacity="0.5" />
                <path d="M5.5 8h5M9 6.5 10.5 8 9 9.5" />
              </svg>
              Drop to merge all tabs back here
            </span>
          </div>
        )}
        {/* Scrollable tab area — delegated to PanelTabStrip. When the pane is
            split, SessionView passes only the primary group's permanent tabs
            here (working tabs live in the group strips); shortcut hints are
            disabled then because the strip shows a subset and the 1-9 indexes
            would lie. */}
        {!barCollapsed && <PanelTabStrip
          idNamespace="top"
          panels={primaryGroupPanels ?? sortedPanels}
          activePanelId={primaryGroupActivePanelId !== undefined ? primaryGroupActivePanelId : (activePanel?.id ?? null)}
          onPanelSelect={handlePanelClick}
          onPanelClose={handlePanelClose}
          isPrimary
          isFocused={primaryGroupFocused ?? true}
          showShortcutHints={!tabsInGroups}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onStripDrop={onStripDrop}
          isTabDragging={isTabDragging}
          draggedPanelId={draggedPanelId}
          getPanelTabPresentation={getPanelTabPresentation}
        />}

        <AddToolMenu
          panels={panels}
          onPanelCreate={onPanelCreate}
          onShowExplorer={onShowExplorer}
          projectEnvironment={projectEnvironment}
          context={context}
          hideButton={tabsInGroups}
        />

        {/* Run / inspector controls live on the title plane when the
            window owns its title bar; otherwise they stay at the bar's end. */}
        {trailingSlot ? createPortal(rightActions, trailingSlot) : rightActions}
      </div>
    </div>

    </>
  );
});

PanelTabBar.displayName = 'PanelTabBar';
