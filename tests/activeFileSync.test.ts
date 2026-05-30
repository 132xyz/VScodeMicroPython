jest.mock('vscode');
jest.mock('../src/board/mpremote', () => ({}));
jest.mock('../src/board/mpremoteCommands', () => ({
  restoreSerialSessionsFromSnapshot: jest.fn(),
  suspendSerialSessionsForAutoSync: jest.fn(),
}));
jest.mock('../src/core/workspaceUtils', () => ({
  getLocalSyncRoot: jest.fn(),
}));
jest.mock('../src/sync/sync', () => ({
  createIgnoreMatcher: jest.fn(),
}));

describe('activeFileSync path mapping', () => {
  it('maps sync root files to the actual board root when rootPath is slash', () => {
    const { toConfiguredSyncDevicePath } = require('../src/sync/activeFileSync') as typeof import('../src/sync/activeFileSync');

    expect(toConfiguredSyncDevicePath('try_v3.py', '/')).toBe('/try_v3.py');
    expect(toConfiguredSyncDevicePath('/pkg/main.py', '/')).toBe('/pkg/main.py');
  });

  it('maps sync root files under a configured board subdirectory when rootPath is not slash', () => {
    const { toConfiguredSyncDevicePath } = require('../src/sync/activeFileSync') as typeof import('../src/sync/activeFileSync');

    expect(toConfiguredSyncDevicePath('try_v3.py', '/lib')).toBe('/lib/try_v3.py');
    expect(toConfiguredSyncDevicePath('pkg/main.py', '/lib/')).toBe('/lib/pkg/main.py');
  });
});

export {};