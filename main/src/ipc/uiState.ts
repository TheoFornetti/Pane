import { ipcMain } from 'electron';
import { UIStateManager } from '../services/uiStateManager';
import type { AppServices } from './types';
import { normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';

export function registerUIStateHandlers(services: AppServices) {
  const uiStateManager = new UIStateManager(services.databaseService, () => {
    const { client } = normalizeRemoteDaemonConfig(services.configManager.getConfig().remoteDaemon);
    return client.mode === 'remote' ? client.activeProfileId : null;
  });

  ipcMain.handle('ui-state:get-expanded', async () => {
    try {
      return {
        success: true,
        data: uiStateManager.getExpandedState()
      };
    } catch (error) {
      console.error('Error getting expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded', async (_, projectIds: number[], folderIds: string[]) => {
    try {
      uiStateManager.saveExpandedState(projectIds, folderIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded-projects', async (_, projectIds: number[]) => {
    try {
      uiStateManager.saveExpandedProjects(projectIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded projects:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded-folders', async (_, folderIds: string[]) => {
    try {
      uiStateManager.saveExpandedFolders(folderIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded folders:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-session-sort-ascending', async (_, ascending: boolean) => {
    try {
      uiStateManager.saveSessionSortAscending(ascending);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving session sort order:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-sidebar-section-expanded', async (_, section: 'pinned' | 'repositories', expanded: boolean) => {
    try {
      if (section !== 'pinned' && section !== 'repositories') {
        throw new Error(`Invalid sidebar section: ${section}`);
      }

      uiStateManager.saveSidebarSectionExpanded(section, expanded);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving sidebar section expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });
}
