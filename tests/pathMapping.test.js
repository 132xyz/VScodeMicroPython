const fs = require('fs');
const path = require('path');

// Mock vscode workspace to point to repository root for tests
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [ { uri: { fsPath: path.resolve(__dirname, '..') } } ]
  }
}), { virtual: true });

describe('path mapping and device root behavior', () => {
  const mp = require('../src/board/mpremote');
  const workbenchDir = path.join(path.resolve(__dirname, '..'), '.mpy-workbench');
  const cfgPath = path.join(workbenchDir, 'config.json');

  afterAll(() => {
    try { if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath); } catch (e) {}
    try { if (fs.existsSync(workbenchDir)) fs.rmdirSync(workbenchDir); } catch (e) {}
  });

  test('toDevicePath with root "/" creates and uses workspace-scoped deviceRoot', () => {
    const devicePath = mp.toDevicePath('sub/dir/file.py', '/');
    expect(typeof devicePath).toBe('string');
    expect(devicePath).toMatch(/^\/mpy_[0-9a-f]+\/sub\/dir\/file.py$/);
    // Ensure config persisted
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.deviceRoot).toBeDefined();
    expect(devicePath.startsWith(cfg.deviceRoot + '/')).toBeTruthy();
  });

  test('toLocalRelative returns null for deviceRoot itself and correct rel for child paths', () => {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const dr = cfg.deviceRoot;
    expect(mp.toLocalRelative(dr, '/')).toBeNull();
    const child = dr + '/a/b.py';
    expect(mp.toLocalRelative(child, '/')).toBe('a/b.py');
  });
});
