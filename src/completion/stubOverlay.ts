import * as fs from 'node:fs';
import * as path from 'path';

function copyIntoOverlay(sourcePath: string, overlayRoot: string): void {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    const items = fs.readdirSync(sourcePath, { withFileTypes: true });
    for (const item of items) {
      fs.cpSync(
        path.join(sourcePath, item.name),
        path.join(overlayRoot, item.name),
        { recursive: true, force: true },
      );
    }
    return;
  }

  if (stats.isFile()) {
    fs.cpSync(sourcePath, path.join(overlayRoot, path.basename(sourcePath)), { force: true });
  }
}

export function buildOverlayStubRoot(baseStubRoot: string, workspaceRoot: string, extraStubPaths: string[]): string {
  const existingExtraPaths = extraStubPaths.filter(Boolean).filter(p => fs.existsSync(p));
  const overlayRoot = path.join(
    workspaceRoot,
    '.mpy-workbench',
    'code-completion-overlay',
    path.basename(baseStubRoot),
  );

  if (existingExtraPaths.length === 0) {
    fs.rmSync(overlayRoot, { recursive: true, force: true });
    return baseStubRoot;
  }

  fs.rmSync(overlayRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(overlayRoot), { recursive: true });
  fs.cpSync(baseStubRoot, overlayRoot, { recursive: true, force: true });

  for (const extraPath of existingExtraPaths) {
    copyIntoOverlay(extraPath, overlayRoot);
  }

  return overlayRoot;
}
