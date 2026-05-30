jest.mock('vscode');
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
}));

const vscode = require('vscode') as typeof import('vscode');

class MockEventEmitter<T> {
  public event = jest.fn();
  public fire = jest.fn();
}

describe('SyncTree', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode as any).EventEmitter = MockEventEmitter;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: 'C:/workspace' } }];
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      inspect: jest.fn(() => ({ defaultValue: false })),
    });
  });

  it('includes active file sync action between upload all and download all', async () => {
    const { SyncTree } = require('../src/sync/syncView') as typeof import('../src/sync/syncView');
    const tree = new SyncTree();

    const nodes = await tree.getActionNodes();
    const ids = nodes.map(node => node.id);

    expect(ids).toEqual([
      'toggleAutoSync',
      'baseline',
      'syncActiveFileLocalToBoard',
      'baselineFromBoard',
      'checkDiffs',
      'syncDiffsLocalToBoard',
      'syncDiffsBoardToLocal',
      'deleteAllBoard',
    ]);
  });
});

export {};