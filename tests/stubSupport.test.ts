jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:fs/promises');
jest.unmock('node:path');
jest.resetModules();

const fs = jest.requireActual('fs') as typeof import('fs');
const os = jest.requireActual('os') as typeof import('os');
const path = jest.requireActual('path') as typeof import('path');
const {
  buildStubPackageRecommendation,
  detectPyrightConfigOverride,
  inspectStubRoot,
} = require('../src/completion/stubSupport') as typeof import('../src/completion/stubSupport');

describe('stubSupport', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpy-stub-support-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('detects a direct hybrid stub root', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'machine.pyi'), '');
    fs.writeFileSync(path.join(root, 'time.pyi'), '');
    fs.mkdirSync(path.join(root, 'stdlib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stdlib', 'VERSIONS'), 'time: 3.0-');

    const result = inspectStubRoot(root);

    expect(result).toEqual({
      root,
      hasTypeshedRoot: true,
      availableCoreModules: ['machine.pyi', 'time.pyi'],
    });
  });

  it('detects nested stub roots under an install directory', () => {
    const parent = makeTempDir();
    const nested = path.join(parent, 'micropython-esp32-stubs-1.28.0.post4');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'machine.pyi'), '');
    fs.writeFileSync(path.join(nested, 'micropython.pyi'), '');

    const result = inspectStubRoot(parent);

    expect(result).toEqual({
      root: nested,
      hasTypeshedRoot: false,
      availableCoreModules: ['machine.pyi', 'micropython.pyi'],
    });
  });

  it('builds package recommendations from board info', () => {
    const recommendation = buildStubPackageRecommendation({
      release: '1.28.0-preview.1',
      sysname: 'esp32',
      machine: 'ESP32 Generic with SPIRAM',
    } as any);

    expect(recommendation).toEqual({
      cleanedRelease: '1.28.0',
      basePackage: 'micropython-esp32-stubs',
      primary: 'micropython-esp32-stubs==1.28.*',
      secondary: 'micropython-esp32-esp32-generic-stubs==1.28.*',
    });
  });

  it('prefers pyrightconfig.json over pyproject.toml overrides', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'pyrightconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pyright]\npythonVersion = "3.11"\n');

    const result = detectPyrightConfigOverride(root);

    expect(result).toEqual({
      path: path.join(root, 'pyrightconfig.json'),
      source: 'pyrightconfig.json',
    });
  });

  it('detects tool.pyright inside pyproject.toml', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pyright]\ntypeCheckingMode = "basic"\n');

    const result = detectPyrightConfigOverride(root);

    expect(result).toEqual({
      path: path.join(root, 'pyproject.toml'),
      source: 'pyproject.toml',
    });
  });
});

export {};