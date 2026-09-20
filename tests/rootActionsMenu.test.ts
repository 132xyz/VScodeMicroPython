const manifest = require('../package.json');
const english = require('../package.nls.json');
const chinese = require('../package.nls.zh-cn.json');

describe('board root actions', () => {
  const prefix = 'microPythonWorkBench.';
  const items = manifest.contributes.menus['view/item/context'] as Array<{ command: string; when: string }>;
  const titles = manifest.contributes.menus['view/title'] as Array<{ command: string; when: string; group: string }>;

  test('root upload is a toolbar action and creation is available in the overflow menu', () => {
    for (const name of ['uploadToBoardRoot', 'newFileAtBoardRoot', 'newFolderAtBoardRoot']) {
      const entry = titles.find(item => item.command === prefix + name)!;
      expect(entry.when).toContain('view == microPythonWorkBenchFsView');
      expect(entry.when).toContain('microPythonWorkBench.hasPort');
      expect(entry.when).not.toContain('viewItem');
      expect(entry.group.startsWith('navigation')).toBe(name === 'uploadToBoardRoot');
      expect(manifest.contributes.commands.some((command: any) => command.command === entry.command)).toBe(true);
      expect(english[`commands.${name}.title`]).toContain('(/)');
      expect(chinese[`commands.${name}.title`]).toContain('(/)');
    }
  });

  test('file, folder and synthetic root have create/upload actions without destructive root actions', () => {
    for (const name of ['newFileInTree', 'newFolderInTree', 'uploadToBoardHere']) {
      const entry = items.find(item => item.command === prefix + name)!;
      for (const kind of ['root', 'dir', 'file']) expect(entry.when).toContain(`viewItem == ${kind}`);
    }
    for (const name of ['delete', 'deleteBoardAndLocal', 'renameNode']) {
      expect(items.find(item => item.command === prefix + name)!.when).not.toContain('viewItem == root');
    }
    expect(items.some(item => item.when.includes('!viewItem'))).toBe(false);
    expect(items.find(item => item.command === prefix + 'refresh')!.when).toContain('viewItem == root');
  });
});
