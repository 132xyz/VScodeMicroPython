jest.mock('vscode');

const vscode = require('vscode') as typeof import('vscode');

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

describe('Esp32DecorationProvider coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode as any).EventEmitter = MockEventEmitter;
    (vscode as any).ThemeColor = jest.fn((value: string) => ({ value }));
  });

  test('stores decoration sets, clears them and emits change events', () => {
    const { Esp32DecorationProvider } = require('../src/ui/decorations') as typeof import('../src/ui/decorations');
    const provider = new Esp32DecorationProvider() as any;
    const listener = jest.fn();
    provider.onDidChangeFileDecorations(listener);

    provider.setDiffs(['/code/main.py']);
    provider.setLocalOnly(['/local/only.py']);
    provider.setBoardOnly(['/board/only.py']);
    provider.setLocalOnlyDirectories(['/pkg']);

    expect(provider.getDiffs()).toEqual(['/code/main.py']);
    expect(provider.getLocalOnly()).toEqual(['/local/only.py']);
    expect(provider.getBoardOnly()).toEqual(['/board/only.py']);
    expect(provider.getLocalOnlyDirectories()).toEqual(['/pkg']);

    provider._originalDiffs = ['/original-diff.py'];
    provider._originalLocalOnly = ['/original-local.py'];
    provider._originalBoardOnly = ['/original-board.py'];
    expect(provider.getDiffsFilesOnly()).toEqual(['/original-diff.py']);
    expect(provider.getLocalOnlyFilesOnly()).toEqual(['/original-local.py']);
    expect(provider.getBoardOnlyFilesOnly()).toEqual(['/original-board.py']);

    provider.clear();
    expect(provider.getDiffs()).toEqual([]);
    expect(provider.getLocalOnly()).toEqual([]);
    expect(provider.getBoardOnly()).toEqual([]);
    expect(provider.getLocalOnlyDirectories()).toEqual([]);
    expect(provider.getDiffsFilesOnly()).toEqual([]);
    expect(provider.getLocalOnlyFilesOnly()).toEqual([]);
    expect(provider.getBoardOnlyFilesOnly()).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  test('provideFileDecoration returns expected badges by priority', () => {
    const { Esp32DecorationProvider } = require('../src/ui/decorations') as typeof import('../src/ui/decorations');
    const provider = new Esp32DecorationProvider();

    provider.setDiffs(['/code/main.py']);
    provider.setLocalOnly(['/local/only.py']);
    provider.setBoardOnly(['/board/only.py']);
    provider.setLocalOnlyDirectories(['/pkg']);

    expect(provider.provideFileDecoration({ scheme: 'file', path: '/ignored' } as any)).toBeUndefined();
    expect(provider.provideFileDecoration({ scheme: 'esp32', path: '/pkg' } as any)).toEqual({
      badge: '?',
      tooltip: 'Local-only folder',
      color: { value: 'descriptionForeground' },
    });
    expect(provider.provideFileDecoration({ scheme: 'esp32', path: '/local/only.py' } as any)).toEqual({
      badge: '?',
      tooltip: 'Only in local',
      color: { value: 'descriptionForeground' },
    });
    expect(provider.provideFileDecoration({ scheme: 'esp32', path: '/board/only.py' } as any)).toEqual({
      badge: 'Δ',
      tooltip: 'Only in board',
      color: { value: 'charts.red' },
    });
    expect(provider.provideFileDecoration({ scheme: 'esp32', path: '/code/main.py' } as any)).toEqual({
      badge: 'Δ',
      tooltip: 'Changed file',
      color: { value: 'charts.red' },
    });
    expect(provider.provideFileDecoration({ scheme: 'esp32', path: '/none.py' } as any)).toBeUndefined();
  });
});

export {};