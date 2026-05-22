jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:fs/promises');
jest.unmock('node:path');
jest.resetModules();

const fs = jest.requireActual('fs') as typeof import('fs');
const os = jest.requireActual('os') as typeof import('os');
const path = jest.requireActual('path') as typeof import('path');
const { clearIndex, findBestMatch, indexStubPaths } = require('../src/completion/stubIndex') as typeof import('../src/completion/stubIndex');

describe('stubIndex', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpy-stub-index-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    clearIndex();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('indexes child stub directories that expose dist-info metadata', () => {
    const root = makeTempDir();
    const installed = path.join(root, 'micropython-esp32-stubs-1.28.0.post4');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'machine.pyi'), '');
    fs.mkdirSync(path.join(installed, 'micropython_esp32_stubs-1.28.0.post4.dist-info'));

    const entries = indexStubPaths([root], true);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'micropython-esp32-stubs-1.28.0.post4',
      version: { major: 1, minor: 28, patch: 0 },
      port: 'esp32',
      path: installed,
    });
  });

  it('parses fallback folder names when dist-info metadata is missing', () => {
    const root = makeTempDir();
    const installed = path.join(root, 'micropython-v1_27_0-esp32-ESP32_GENERIC');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'machine.pyi'), '');

    const entries = indexStubPaths([root], true);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'micropython-v1_27_0-esp32-ESP32_GENERIC',
      version: { major: 1, minor: 27, patch: 0 },
      port: 'esp32',
      board: 'ESP32_GENERIC',
      path: installed,
    });
  });

  it('prefers the closest matching version and board', () => {
    const entries = [
      {
        name: 'micropython-v1_27_0-esp32-ESP32_GENERIC',
        version: { major: 1, minor: 27, patch: 0 },
        port: 'esp32',
        board: 'ESP32_GENERIC',
        path: '/stubs/1.27.0',
      },
      {
        name: 'micropython-v1_28_0-esp32-ESP32_GENERIC',
        version: { major: 1, minor: 28, patch: 0 },
        port: 'esp32',
        board: 'ESP32_GENERIC',
        path: '/stubs/1.28.0',
      },
      {
        name: 'micropython-v1_28_0-rp2-PICO_W',
        version: { major: 1, minor: 28, patch: 0 },
        port: 'rp2',
        board: 'PICO_W',
        path: '/stubs/pico',
      },
    ];

    const best = findBestMatch(entries, {
      release: '1.28.1',
      port: 'esp32',
      machine: 'ESP32 Generic with SPIRAM',
      board: 'ESP32_GENERIC',
    });

    expect(best?.path).toBe('/stubs/1.28.0');
  });

  it('falls back to the highest version when hints are absent', () => {
    const entries = [
      {
        name: 'micropython-v1_27_0-esp32-ESP32_GENERIC',
        version: { major: 1, minor: 27, patch: 0 },
        port: 'esp32',
        board: 'ESP32_GENERIC',
        path: '/stubs/1.27.0',
      },
      {
        name: 'micropython-v1_28_0-esp32-ESP32_GENERIC',
        version: { major: 1, minor: 28, patch: 0 },
        port: 'esp32',
        board: 'ESP32_GENERIC',
        path: '/stubs/1.28.0',
      },
    ];

    const best = findBestMatch(entries);

    expect(best?.path).toBe('/stubs/1.28.0');
  });
});

export {};