import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, FileCode, FileDiff, FileText, FolderTree, GitBranch, Globe, Pencil, Plus, Terminal, TerminalSquare, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useHotkey } from '../../hooks/useHotkey';
import type { PanelContext, PanelCreateOptions } from '../../types/panelComponents';
import { PANEL_CAPABILITIES, type ProjectEnvironment, type ToolPanel, type ToolPanelType } from '../../../../shared/types/panels';
import { useConfigStore } from '../../stores/configStore';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { Tooltip } from '../ui/Tooltip';
import { editorPanelState } from '../../services/openFileInEditor';
import { Kbd } from '../ui/Kbd';
import { CLI_BRAND_ICONS, getCliBrandIcon } from '../ui/brandIconRegistry';
import { visibleAgentPresets } from '../../utils/agentPresets';
import { CustomCommandForm } from './CustomCommandForm';

const ADD_TOOL_MENU_WIDTH = 280;
const ADD_TOOL_MENU_VIEWPORT_MARGIN = 8;
const MAX_CUSTOM_COMMAND_LABEL_LENGTH = 18;

function truncateCustomCommandLabel(label: string): string {
  if (label.length <= MAX_CUSTOM_COMMAND_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_CUSTOM_COMMAND_LABEL_LENGTH - 3)}...`;
}

function getPanelIcon(type: ToolPanelType, panel?: ToolPanel) {
  // Check for brand-specific terminal panels by title
  if (type === 'terminal' && panel) {
    const title = panel.title.toLowerCase();
    for (const [keyword, IconComponent] of Object.entries(CLI_BRAND_ICONS)) {
      if (title.includes(keyword)) {
        return <IconComponent className="w-4 h-4" />;
      }
    }
  }
  switch (type) {
    case 'terminal':
      return <Terminal className="w-4 h-4" />;
    case 'diff':
      return <GitBranch className="w-4 h-4" />;
    case 'explorer':
      return <FolderTree className="w-4 h-4" />;
    case 'editor':
      return panel && editorPanelState(panel)?.diff ? <FileDiff className="w-4 h-4" /> : <FileText className="w-4 h-4" />;
    case 'logs':
      return <FileCode className="w-4 h-4" />;
    case 'dashboard':
      return <BarChart3 className="w-4 h-4" />;
    case 'browser':
      return <Globe className="w-4 h-4" />;
    default:
      return null;
  }
}

interface AddToolMenuProps {
  /** Panels already in the view; singleton tools that exist are left out. */
  panels: ToolPanel[];
  onPanelCreate: (type: ToolPanelType, options?: PanelCreateOptions) => void;
  onShowExplorer: () => void;
  projectEnvironment?: ProjectEnvironment;
  context?: PanelContext;
  /** Hide the "+" button; the menu still opens from ⌘T and group strip "+" buttons. */
  hideButton?: boolean;
}

/**
 * The "+" add-tool menu shared by Panes and Sessions: terminals, the browser,
 * agent presets, and saved custom commands. Opens from its button, ⌘T, or a
 * group strip's "+" (which anchors it to that button).
 */
export function AddToolMenu({
  panels,
  onPanelCreate,
  onShowExplorer,
  projectEnvironment,
  context = 'worktree',
  hideButton = false,
}: AddToolMenuProps) {
  const agentPresets = useMemo(
    () => visibleAgentPresets(projectEnvironment),
    [projectEnvironment],
  );
  const { config, fetchConfig, updateConfig } = useConfigStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const addToolButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  // A group strip's "+" opens this same menu, anchored to that button instead.
  const externalAnchorRef = useRef<DOMRect | null>(null);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [editingCustomIndex, setEditingCustomIndex] = useState<number | null>(null);
  const [focusedDropdownIndex, setFocusedDropdownIndex] = useState(-1);
  const dropdownItemsRef = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);
  const customCommands = config?.customCommands ?? [];
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);

  useEffect(() => {
    if (!config) fetchConfig();
  }, [config, fetchConfig]);

  const deleteCustomCommand = useCallback(async (index: number) => {
    const existing = config?.customCommands ?? [];
    await updateConfig({
      customCommands: existing.filter((_, i) => i !== index)
    }).catch(() => {});
  }, [config, updateConfig]);

  // Add Tool dropdown positioning
  useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const updatePosition = () => {
      if (!dropdownRef.current) return;
      const rect = externalAnchorRef.current ?? dropdownRef.current.getBoundingClientRect();
      const width = Math.min(
        ADD_TOOL_MENU_WIDTH,
        window.innerWidth - (ADD_TOOL_MENU_VIEWPORT_MARGIN * 2),
      );
      const left = Math.max(
        ADD_TOOL_MENU_VIEWPORT_MARGIN,
        Math.min(
          rect.left,
          window.innerWidth - width - ADD_TOOL_MENU_VIEWPORT_MARGIN,
        ),
      );
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left,
        zIndex: 10000,
        width,
        maxWidth: `calc(100vw - ${ADD_TOOL_MENU_VIEWPORT_MARGIN * 2}px)`,
        maxHeight: Math.max(0, window.innerHeight - rect.bottom - 4 - ADD_TOOL_MENU_VIEWPORT_MARGIN),
        overflowY: 'auto',
        // Pinned under the button's left edge, so that corner is where the menu
        // should look like it grew from.
        transformOrigin: 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showDropdown]);

  const handleAddPanel = useCallback((type: ToolPanelType, options?: PanelCreateOptions) => {
    onPanelCreate(type, options);
    setShowDropdown(false);
    setShowCustomInput(false);
    setEditingCustomIndex(null);
  }, [onPanelCreate]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        event.target &&
        event.target instanceof Node &&
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target) &&
        dropdownMenuRef.current &&
        !dropdownMenuRef.current.contains(event.target)
      ) {
        setShowDropdown(false);
        setShowCustomInput(false);
        setEditingCustomIndex(null);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  // Group strips ask for the menu with their own "+" as the anchor.
  useEffect(() => {
    const handleOpenRequest = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      externalAnchorRef.current = event.detail?.rect ?? null;
      setShowDropdown(true);
    };
    window.addEventListener('pane:open-add-tool', handleOpenRequest);
    return () => window.removeEventListener('pane:open-add-tool', handleOpenRequest);
  }, []);
  useEffect(() => {
    if (!showDropdown) externalAnchorRef.current = null;
  }, [showDropdown]);

  // Reset focus index when dropdown closes, focus first item when opens
  useEffect(() => {
    if (showDropdown) {
      setFocusedDropdownIndex(0);
    } else {
      setFocusedDropdownIndex(-1);
      setShowCustomInput(false);
      setEditingCustomIndex(null);
      dropdownItemsRef.current = [];
    }
  }, [showDropdown]);

  useEffect(() => {
    if (showDropdown && focusedDropdownIndex >= 0) {
      dropdownItemsRef.current[focusedDropdownIndex]?.focus();
    }
  }, [focusedDropdownIndex, showDropdown]);

  // Handle keyboard navigation in dropdown
  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = dropdownItemsRef.current.filter(Boolean);
    const itemCount = items.length;

    if (itemCount === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          return prev < itemCount - 1 ? prev + 1 : 0;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          return prev > 0 ? prev - 1 : itemCount - 1;
        });
        break;
      case 'Escape':
        e.preventDefault();
        setShowDropdown(false);
        requestAnimationFrame(() => addToolButtonRef.current?.focus());
        break;
      case 'Tab':
        // Allow tab to close dropdown and move to next element
        setShowDropdown(false);
        break;
    }
  }, []);

  // Ctrl+T: open Add Tool dropdown
  useHotkey({
    id: 'open-add-tool',
    label: 'Open Add Tool menu',
    keys: 'mod+t',
    category: 'tabs',
    action: () => setShowDropdown(true),
  });

  // Get available panel types (excluding permanent panels, logs, and enforcing singleton)
  // SAFETY: The value comes from the adjacent finite domain definition.
  const availablePanelTypes = (Object.keys(PANEL_CAPABILITIES) as ToolPanelType[])
    .filter(type => {
      const capabilities = PANEL_CAPABILITIES[type];

      // Filter based on context
      if (context === 'project' && !capabilities.canAppearInProjects) return false;
      if (context === 'worktree' && !capabilities.canAppearInWorktrees) return false;

      // Exclude permanent panels
      if (capabilities.permanent) return false;

      // Logs is created by running scripts; editor tabs by opening files
      if (type === 'logs' || type === 'editor') return false;

      // Enforce singleton panels
      if (capabilities.singleton) {
        // Check if a panel of this type already exists
        return !panels.some(p => p.type === type);
      }

      return true;
    });

  // The dropdown is portaled to the body so a strip's overflow never clips it.
  return (
        <div className="relative h-[var(--panel-tab-height)] flex items-center flex-shrink-0" ref={dropdownRef}>
          <Tooltip content={hotkeyDisplay('open-add-tool') ? <Kbd>{hotkeyDisplay('open-add-tool')}</Kbd> : undefined} side="bottom">
            <button
              ref={addToolButtonRef}
              type="button"
              className={cn(
                "inline-flex items-center justify-center h-7 w-7 ml-0.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle",
                hideButton && "hidden",
              )}
              onClick={() => setShowDropdown(!showDropdown)}
              aria-label="Add tool"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && !showDropdown) {
                  e.preventDefault();
                  setShowDropdown(true);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={showDropdown}
            >
              <Plus className="w-4 h-4" />
            </button>
          </Tooltip>

          {showDropdown && (() => {
            // Track ref index for keyboard navigation
            let refIndex = 0;
            const menuItemClass = "flex items-center gap-2 w-full h-7 px-2.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:text-text-primary focus:outline-none text-left";
            const separator = <hr className="my-1 border-t border-border-primary" />;
            const otherPanelTypes = availablePanelTypes.filter(t => t !== 'terminal' && t !== 'explorer' && t !== 'browser');
            const groupLabel = (label: string) => (
              <div role="presentation" className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
            );
            const shortcut = (id: string) => (hotkeyDisplay(id) ? <Kbd variant="inline" className="ml-auto pl-3">{hotkeyDisplay(id)}</Kbd> : null);

            return createPortal(
            <div
              ref={dropdownMenuRef}
              className="min-w-[228px] py-1 bg-surface-primary border border-border-primary rounded-md shadow-dropdown z-50"
              style={dropdownStyle}
              role="menu"
              onKeyDown={handleDropdownKeyDown}
            >
              {/* Terminal - plain terminal */}
              {availablePanelTypes.includes('terminal') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal')}
                >
                  <Terminal className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Terminal</span>
                  {shortcut('add-tool-terminal')}
                </button>
              )}
              {/* Explorer */}
              {availablePanelTypes.includes('explorer') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    onShowExplorer();
                    setShowDropdown(false);
                  }}
                >
                  <FolderTree className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Explorer</span>
                  {shortcut('add-tool-explorer')}
                </button>
              )}
              {availablePanelTypes.includes('browser') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('browser')}
                >
                  <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Browser</span>
                </button>
              )}
              {availablePanelTypes.includes('terminal') && agentPresets.length > 0 && (
                <>
                  {separator}
                  {groupLabel('Presets')}
                </>
              )}
              {/* Built-in agents */}
              {availablePanelTypes.includes('terminal') && agentPresets.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal', {
                    initialCommand: preset.command,
                    title: preset.title
                  })}
                >
                  {getCliBrandIcon(preset.iconKey, 'w-3.5 h-3.5 flex-shrink-0')}
                  <span className="truncate">{preset.title}</span>
                  {shortcut(preset.hotkeyId)}
                </button>
              ))}
              {availablePanelTypes.includes('terminal') && separator}
              {/* Saved custom commands */}
              {availablePanelTypes.includes('terminal') && customCommands.map((cmd, index) => {
                const currentRefIndex = refIndex++;
                const shortcutDisplay = hotkeyDisplay(`add-tool-custom-${index}`);
                const displayName = truncateCustomCommandLabel(cmd.name);
                return (
                <div key={`custom-${index}`} role="none" className="flex min-w-0 items-center">
                  <Tooltip
                    content={(
                      <span className="block max-w-[min(32rem,calc(100vw-1rem))] whitespace-normal break-words">
                        <span className="block font-medium">{cmd.name}</span>
                        <span className="block">{cmd.command}</span>
                        <span className="mt-1 block text-xs text-text-tertiary">F2 to rename · Delete or Backspace to remove</span>
                      </span>
                    )}
                    side="bottom"
                  >
                    <button
                      ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                      type="button"
                      role="menuitem"
                      className={cn(menuItemClass, 'min-w-0 flex-1')}
                      onClick={() => handleAddPanel('terminal', {
                        initialCommand: cmd.command,
                        customResume: cmd.resume,
                        title: cmd.name
                      })}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingCustomIndex(index);
                          setShowCustomInput(true);
                        }
                        if (!showCustomInput && (e.key === 'Delete' || e.key === 'Backspace')) {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteCustomCommand(index);
                        }
                      }}
                    >
                      {getCliBrandIcon(cmd.command, 'w-3.5 h-3.5 flex-shrink-0') || <TerminalSquare className="w-3.5 h-3.5 flex-shrink-0" />}
                      <span className="truncate">{displayName}</span>
                      {shortcutDisplay && <Kbd variant="inline" className="ml-auto pl-3">{shortcutDisplay}</Kbd>}
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary flex-shrink-0"
                    onClick={() => {
                      setEditingCustomIndex(index);
                      setShowCustomInput(true);
                    }}
                    aria-label={`Rename ${cmd.name} shortcut`}
                    title="Rename profile"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    className="p-1 mr-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary flex-shrink-0"
                    disabled={showCustomInput}
                    onClick={() => deleteCustomCommand(index)}
                    aria-label={`Remove ${cmd.name} shortcut`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );})}
              {/* Add Custom Command input */}
              {availablePanelTypes.includes('terminal') && (
                showCustomInput ? (
                  <CustomCommandForm
                    key={editingCustomIndex ?? 'new'}
                    existing={editingCustomIndex === null ? undefined : customCommands[editingCustomIndex]}
                    onCancel={() => {
                      setShowCustomInput(false);
                      setEditingCustomIndex(null);
                    }}
                    onSave={async (name, command, resume) => {
                      const existing = config?.customCommands ?? [];
                      await updateConfig({
                        customCommands: editingCustomIndex === null
                          ? [...existing, { name, command, resume }]
                          : existing.map((entry, index) => index === editingCustomIndex ? { ...entry, name, resume } : entry),
                      });
                      if (editingCustomIndex === null) {
                        handleAddPanel('terminal', { initialCommand: command, title: name, customResume: resume });
                      } else {
                        setShowCustomInput(false);
                        setEditingCustomIndex(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                    role="menuitem"
                    className={menuItemClass}
                    onClick={() => { setEditingCustomIndex(null); setShowCustomInput(true); }}
                  >
                    <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">Add custom command…</span>
                  </button>
                )
              )}
              {/* Other panel types (terminal, explorer and browser are listed above) */}
              {otherPanelTypes.length > 0 && separator}
              {otherPanelTypes.map((type) => {
                const currentRefIndex = refIndex++;
                return (
                <button
                  key={type}
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel(type)}
                >
                  {getPanelIcon(type)}
                  <span className="capitalize">{type}</span>
                </button>
              );})}
            </div>,
            document.body
            );
          })()}
        </div>
  );
}
