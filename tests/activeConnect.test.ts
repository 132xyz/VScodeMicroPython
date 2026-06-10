jest.mock('vscode');

const vscode = require('vscode') as typeof import('vscode');
const mp = require('../src/board/mpremote') as typeof import('../src/board/mpremote');

describe('active serial connect resolution', () => {
  let configuredConnect = 'serial:///COM4';

  beforeEach(() => {
    configuredConnect = 'serial:///COM4';
    jest.clearAllMocks();
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return configuredConnect;
        if (key === 'microPythonWorkBench.debug') return false;
        return defaultValue;
      }),
    }));
    mp.clearSelectedConnect();
  });

  afterEach(() => {
    mp.clearSelectedConnect();
  });

  test('uses the latest explicit selection ahead of the configured port', () => {
    expect(mp.normalizeConnect(mp.getActiveConnect())).toBe('COM4');

    mp.setSelectedConnect('COM21');

    expect(mp.normalizeConnect(mp.getActiveConnect())).toBe('COM21');
  });

  test('uses configured fixed port only when current selection is auto', () => {
    mp.setSelectedConnect('auto');

    expect(mp.normalizeConnect(mp.getActiveConnect())).toBe('COM4');

    configuredConnect = 'auto';

    expect(mp.getActiveConnect()).toBe('auto');
  });
});
