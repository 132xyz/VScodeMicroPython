import * as fs from 'fs';
import * as path from 'path';

// Ensure Node fs modules are available to modules that import 'node:fs' or 'node:fs/promises'
jest.mock('node:fs', () => jest.requireActual('fs'));
jest.mock('node:fs/promises', () => jest.requireActual('fs').promises);

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [ { uri: { fsPath: path.resolve(__dirname, '..') } } ]
  }
}), { virtual: true });

// Use an environment override during tests to avoid filesystem operations
process.env.MPY_DEVICE_ROOT = '/mpy_testroot';

describe('path mapping and device root behavior', () => {
  const mp = require('../src/board/mpremote');

  test('toDevicePath with root "/" creates and uses workspace-scoped deviceRoot', () => {
    const devicePath = mp.toDevicePath('sub/dir/file.py', '/');
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
    expect(mp.toLocalRelative(dr, '/')).toBeNull();
    const child = dr + '/a/b.py';
    expect(mp.toLocalRelative(child, '/')).toBe('a/b.py');
  });
});
