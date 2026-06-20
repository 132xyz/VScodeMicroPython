jest.mock('vscode');
jest.mock('../src/board/mpremote', () => ({
  getActiveConnect: jest.fn(() => 'serial:///COM4'),
  lsTyped: jest.fn(),
}));
jest.mock('../src/python/pyraw', () => ({
  listDirPyRaw: jest.fn(),
}));
jest.mock('../src/sync/sync', () => ({
  createIgnoreMatcher: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');
const mp = require('../src/board/mpremote') as {
  getActiveConnect: jest.Mock;
  lsTyped: jest.Mock;
};
const pyraw = require('../src/python/pyraw') as {
  listDirPyRaw: jest.Mock;
};
const syncModule = require('../src/sync/sync') as {
  createIgnoreMatcher: jest.Mock;
};

class MockEventEmitter<T> {
  listeners: Array<(value: T | undefined) => void> = [];

  event = (listener: (value: T | undefined) => void) => {
    this.listeners.push(listener);
    return { dispose: jest.fn() };
  };

  fire = jest.fn((value?: T) => {
    for (const listener of this.listeners) {
      listener(value);
    }
  });
}

class MockTreeItem {
  label: string;
  collapsibleState: number;
  command?: unknown;
  tooltip?: string;
  contextValue?: string;
  resourceUri?: unknown;
  iconPath?: unknown;
  className?: string;

  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

describe('Esp32Tree coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode as any).EventEmitter = MockEventEmitter;
    (vscode as any).TreeItem = MockTreeItem;
    (vscode as any).ThemeIcon = jest.fn((id: string) => ({ id }));
    (vscode as any).TreeItemCollapsibleState = { None: 0, Collapsed: 1 };
    (vscode.Uri as any).parse = jest.fn((value: string) => ({ value }));
    (vscode.Uri as any).joinPath = jest.fn((base: { fsPath?: string }, ...parts: string[]) => ({ fsPath: [base.fsPath || '', ...parts].join('/') }));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    (vscode.extensions as any).getExtension = jest.fn(() => ({ extensionUri: { fsPath: '/extension' } }));
    (vscode.window as any).showInformationMessage = jest.fn();
    (vscode.window as any).showErrorMessage = jest.fn();
    (vscode.commands as any).executeCommand = jest.fn().mockResolvedValue(undefined);
    mp.getActiveConnect.mockReturnValue('serial:///COM4');
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === 'microPythonWorkBench.connect') return 'serial:///COM4';
        if (key === 'microPythonWorkBench.rootPath') return '/';
        if (key === 'microPythonWorkBench.usePyRawList') return false;
        return defaultValue;
      }),
    }));
    syncModule.createIgnoreMatcher.mockResolvedValue(() => false);
    mp.lsTyped.mockResolvedValue([
      { name: 'boot.py', isDir: false },
      { name: 'lib', isDir: true },
    ]);
    pyraw.listDirPyRaw.mockResolvedValue([]);
    (global as any).esp32Decorations = {
      getLocalOnly: jest.fn(() => ['/local.py', '/pkg/module.py']),
      getLocalOnlyDirectories: jest.fn(() => ['/pkg']),
    };
  });

  test('tree items and cache mutation helpers behave as expected', () => {
    const { Esp32Tree } = require('../src/board/esp32Fs') as typeof import('../src/board/esp32Fs');
    const tree = new Esp32Tree() as any;

    expect(tree.getTreeItemForNode('no-port')).toMatchObject({
      label: '$(plug) Select Serial Port',
      tooltip: 'Click to select a serial port',
    });
    expect(tree.getTreeItemForNode({ kind: 'dir', name: 'Board (/)', path: '/', isContextAnchor: true })).toMatchObject({
      label: 'Board (/)',
      contextValue: 'dir',
    });
    expect(tree.getTreeItemForNode({ kind: 'file', name: 'main.py', path: '/main.py' })).toMatchObject({
      label: 'main.py',
      contextValue: 'file',
      command: {
        command: 'microPythonWorkBench.openFileFromTree',
        title: 'Open',
        arguments: [{ kind: 'file', name: 'main.py', path: '/main.py' }],
      },
    });

    tree.addNode('/pkg/file.py', false);
    expect(tree._nodeCache.get('/pkg')).toEqual([{ kind: 'file', name: 'file.py', path: '/pkg/file.py' }]);
    tree.removeNode('/pkg/file.py');
    expect(tree._nodeCache.get('/pkg')).toEqual([]);
    tree.resetDir('/pkg');
    expect(tree._nodeCache.get('/pkg')).toEqual([]);
    tree.clearCache();
    expect(tree._nodeCache.size).toBe(0);
  });

  test('manual refresh gate and listing merge logic are covered', async () => {
    const { Esp32Tree } = require('../src/board/esp32Fs') as typeof import('../src/board/esp32Fs');
    const tree = new Esp32Tree() as any;

    expect(await tree.getChildNodes()).toEqual([
      { kind: 'dir', name: 'Board (/)', path: '/', isContextAnchor: true },
    ]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Board connected. Click Refresh to load files.');

    tree.allowListing();
    const children = await tree.getChildNodes();
    expect(children).toEqual([
      { kind: 'dir', name: 'Board (/)', path: '/', isContextAnchor: true },
      { kind: 'dir', name: 'lib', path: '/lib' },
      { kind: 'dir', name: 'pkg', path: '/pkg', isLocalOnly: true },
      { kind: 'file', name: 'boot.py', path: '/boot.py' },
      { kind: 'file', name: 'local.py', path: '/local.py', isLocalOnly: true },
    ]);

    expect(tree.getChildren()).resolves.toEqual(children);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('microPythonWorkBench.autoSuspendLs', '/');
  });
});

export {};
