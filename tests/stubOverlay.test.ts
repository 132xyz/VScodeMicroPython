jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.resetModules();

const fs = jest.requireActual('fs') as typeof import('fs');
const os = jest.requireActual('os') as typeof import('os');
const path = jest.requireActual('path') as typeof import('path');
const { buildOverlayStubRoot } = require('../src/completion/stubOverlay') as typeof import('../src/completion/stubOverlay');

describe('stubOverlay', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpy-stub-overlay-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeBaseStubRoot(workspaceRoot: string): string {
    const baseRoot = path.join(workspaceRoot, 'base-stubs');
    fs.mkdirSync(baseRoot, { recursive: true });
    fs.writeFileSync(path.join(baseRoot, 'machine.pyi'), 'class Pin: ...\n');
    fs.writeFileSync(path.join(baseRoot, 'time.pyi'), 'def sleep_ms(ms: int) -> None: ...\n');
    return baseRoot;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('returns the base stub root when no extra stub paths exist', () => {
    const workspaceRoot = makeTempDir();
    const baseRoot = writeBaseStubRoot(workspaceRoot);

    const result = buildOverlayStubRoot(baseRoot, workspaceRoot, [path.join(workspaceRoot, 'missing')]);

    expect(result).toBe(baseRoot);
  });

  it('removes a stale overlay root when no extra stub paths exist', () => {
    const workspaceRoot = makeTempDir();
    const baseRoot = writeBaseStubRoot(workspaceRoot);
    const overlayRoot = path.join(
      workspaceRoot,
      '.mpy-workbench',
      'code-completion-overlay',
      path.basename(baseRoot),
    );
    fs.mkdirSync(overlayRoot, { recursive: true });
    fs.writeFileSync(path.join(overlayRoot, 'stale.py'), 'VALUE = 1\n');

    const result = buildOverlayStubRoot(baseRoot, workspaceRoot, []);

    expect(result).toBe(baseRoot);
    expect(fs.existsSync(overlayRoot)).toBe(false);
  });

  it('merges directory contents into a generated overlay root', () => {
    const workspaceRoot = makeTempDir();
    const baseRoot = writeBaseStubRoot(workspaceRoot);
    const extraRoot = path.join(workspaceRoot, 'extra-typings');
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.writeFileSync(path.join(extraRoot, 'camera.pyi'), 'class Camera: ...\n');
    fs.mkdirSync(path.join(extraRoot, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(extraRoot, 'pkg', '__init__.pyi'), 'from .device import Device\n');
    fs.writeFileSync(path.join(extraRoot, 'pkg', 'device.pyi'), 'class Device: ...\n');

    const result = buildOverlayStubRoot(baseRoot, workspaceRoot, [extraRoot]);

    expect(result).not.toBe(baseRoot);
    expect(fs.existsSync(path.join(result, 'machine.pyi'))).toBe(true);
    expect(fs.readFileSync(path.join(result, 'camera.pyi'), 'utf8')).toContain('Camera');
    expect(fs.readFileSync(path.join(result, 'pkg', 'device.pyi'), 'utf8')).toContain('Device');
  });

  it('copies standalone pyi files into the overlay root', () => {
    const workspaceRoot = makeTempDir();
    const baseRoot = writeBaseStubRoot(workspaceRoot);
    const extraFile = path.join(workspaceRoot, 'board_camera.pyi');
    fs.writeFileSync(extraFile, 'class BoardCamera: ...\n');

    const result = buildOverlayStubRoot(baseRoot, workspaceRoot, [extraFile]);

    expect(result).not.toBe(baseRoot);
    expect(fs.readFileSync(path.join(result, 'board_camera.pyi'), 'utf8')).toContain('BoardCamera');
  });
});

export {};
