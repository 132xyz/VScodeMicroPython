import * as fs from 'fs';
import * as path from 'path';

// Ensure Node fs modules are available to modules that import 'node:fs' or 'node:fs/promises'
jest.mock('node:fs', () => jest.requireActual('fs'));
jest.mock('node:fs/promises', () => jest.requireActual('fs').promises);

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [ { uri: { fsPath: path.resolve(__dirname, '..') } } ],
    getConfiguration: () => ({
      get: (key: string, defaultValue?: any) => defaultValue
    })
  }
}), { virtual: true });

// Use an environment override during tests to avoid filesystem operations
process.env.MPY_DEVICE_ROOT = '/mpy_testroot';

describe('path mapping and device root behavior', () => {
  // Import both old and new modules to verify compatibility
  const mp = require('../src/board/mpremote');
  const pathMapping = require('../src/utils/pathMapping');

  test('toDevicePath with root "/" creates and uses workspace-scoped deviceRoot', () => {
    const devicePath = pathMapping.toDevicePath('sub/dir/file.py', '/');
    expect(typeof devicePath).toBe('string');
    const expectedRoot = process.env.MPY_DEVICE_ROOT;
    if (expectedRoot) {
      expect(devicePath).toBe(expectedRoot + '/sub/dir/file.py');
    } else {
      expect(devicePath).toMatch(/^\/mpy_[0-9a-f]+\/sub\/dir\/file.py$/);
    }
  });

  test('toLocalRelative returns null for deviceRoot itself and correct rel for child paths', () => {
    const dr = process.env.MPY_DEVICE_ROOT!;
    expect(pathMapping.toLocalRelative(dr, '/')).toBeNull();
    const child = dr + '/a/b.py';
    expect(pathMapping.toLocalRelative(child, '/')).toBe('a/b.py');
  });

  test('old mpremote module still exports path functions for backward compatibility', () => {
    expect(typeof mp.toDevicePath).toBe('function');
    expect(typeof mp.toLocalRelative).toBe('function');
  });
});
