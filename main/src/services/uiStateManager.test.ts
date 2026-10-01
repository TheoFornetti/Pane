import { describe, expect, it } from 'vitest';
import { UIStateManager } from './uiStateManager';

function createUiStateDb() {
  const values = new Map<string, string>();
  return {
    getUIState: (key: string) => values.get(key),
    setUIState: (key: string, value: string) => { values.set(key, value); },
    deleteUIState: (key: string) => { values.delete(key); },
  };
}

describe('UIStateManager expanded repositories', () => {
  it('keeps each host’s expanded repositories separate from this computer’s', () => {
    let remoteHostId: string | null = null;
    const manager = new UIStateManager(createUiStateDb(), () => remoteHostId);

    manager.saveExpandedProjects([1, 2]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedProjects()).toEqual([]);
    manager.saveExpandedProjects([1, 9]);

    remoteHostId = null;
    expect(manager.getExpandedProjects()).toEqual([1, 2]);
    remoteHostId = 'host-b';
    expect(manager.getExpandedProjects()).toEqual([1, 9]);
  });
});
