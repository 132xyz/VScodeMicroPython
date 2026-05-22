import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BoardDetectInfo } from '../board/mpremote';

const CORE_STUB_FILES = ['machine.pyi', 'umachine.pyi', 'micropython.pyi', 'time.pyi'];

export type StubInspection = {
  root: string;
  hasTypeshedRoot: boolean;
  availableCoreModules: string[];
};

export type StubPackageRecommendation = {
  cleanedRelease?: string;
  basePackage?: string;
  primary?: string;
  secondary?: string;
};

function normalizeToKebab(value?: string): string {
  if (!value) return '';

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function inspectSingleRoot(root: string): StubInspection | null {
  if (!root || !fs.existsSync(root)) return null;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return null;
  }

  if (!stats.isDirectory()) return null;

  const availableCoreModules = CORE_STUB_FILES.filter(file => fs.existsSync(path.join(root, file)));
  if (availableCoreModules.length === 0) return null;

  const hasTypeshedRoot = fs.existsSync(path.join(root, 'stdlib', 'VERSIONS'));
  return {
    root,
    hasTypeshedRoot,
    availableCoreModules,
  };
}

export function inspectStubRoot(candidate?: string | null): StubInspection | null {
  if (!candidate) return null;

  const direct = inspectSingleRoot(candidate);
  if (direct) return direct;

  try {
    const items = fs.readdirSync(candidate, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const nested = inspectSingleRoot(path.join(candidate, item.name));
      if (nested) return nested;
    }
  } catch {
    return null;
  }

  return null;
}

export function buildStubPackageRecommendation(boardInfo: BoardDetectInfo | null): StubPackageRecommendation {
  if (!boardInfo) return {};

  const cleanedRelease = boardInfo.release ? String(boardInfo.release).split('-')[0] : undefined;
  const portRaw = boardInfo.sysname || boardInfo.machine || '';
  const boardRaw = boardInfo.machine ? String(boardInfo.machine).split(/\s+with\s+/i)[0] : '';
  const portNorm = normalizeToKebab(portRaw);
  const boardNorm = normalizeToKebab(boardRaw);

  if (!portNorm) {
    return { cleanedRelease };
  }

  const basePackage = `micropython-${portNorm}-stubs`;
  const versionSpec = cleanedRelease
    ? (() => {
        const match = /^(\d+)\.(\d+)/.exec(cleanedRelease);
        return match ? `==${match[1]}.${match[2]}.*` : '';
      })()
    : '';

  return {
    cleanedRelease,
    basePackage,
    primary: `${basePackage}${versionSpec}`,
    secondary: boardNorm ? `micropython-${portNorm}-${boardNorm}-stubs${versionSpec}` : undefined,
  };
}

export function detectPyrightConfigOverride(workspaceRoot?: string): { path: string; source: string } | null {
  if (!workspaceRoot) return null;

  const pyrightConfigPath = path.join(workspaceRoot, 'pyrightconfig.json');
  if (fs.existsSync(pyrightConfigPath)) {
    return {
      path: pyrightConfigPath,
      source: 'pyrightconfig.json',
    };
  }

  const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
  if (!fs.existsSync(pyprojectPath)) return null;

  try {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    if (/^\s*\[tool\.pyright\]\s*$/m.test(content)) {
      return {
        path: pyprojectPath,
        source: 'pyproject.toml',
      };
    }
  } catch {
    return null;
  }

  return null;
}