import * as fs from 'node:fs';
import * as path from 'node:path';

export type StubEntry = {
  name: string;
  version?: { major: number; minor: number; patch: number } | null;
  port?: string | null;
  board?: string | null;
  path: string;
};

function parseVersionFromName(n: string) {
  // e.g. micropython-v1_17_0-esp32-esp32_generic_s3-stubs
  const m = /v(\d+)_?(\d+)?_?(\d+)?/.exec(n);
  if (!m) return null;
  return {
    major: Number(m[1] || 0),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
  };
}

function parseDistInfoName(n: string) {
  // e.g. micropython_esp32_stubs-1.27.0.post1.dist-info
  const m = /^(.+)-([0-9][^.]*(?:\.[^.]*)*)\.dist-info$/.exec(n);
  if (!m) return null as any;
  const pkg = m[1];
  const ver = m[2];
  // try to extract numeric major.minor.patch from ver
  const mv = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(ver);
  const version = mv ? { major: Number(mv[1]||0), minor: Number(mv[2]||0), patch: Number(mv[3]||0) } : null;
  return { pkg, ver, version };
}

function parsePortBoardFromName(n: string) {
  const cleaned = n.replace(/-(merged|docstubs|frozen)$/i, '');
  const parts = cleaned.split('-');
  const versionIndex = parts.findIndex(part => /^v\d+(_\d+){1,2}$/i.test(part));
  const after = versionIndex >= 0 ? parts.slice(versionIndex + 1) : parts.slice(1);
  let port: string | null = null;
  let board: string | null = null;
  if (after.length > 0) {
    port = after[0] || null;
    if (after.length > 1) board = after[1] || null;
  }
  return { port, board };
}

function normalizeKey(value?: string | null): string {
  if (!value) return '';

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseVersionString(version?: string) {
  if (!version) return null;

  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return null;

  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

function inspectDirectoryEntry(fullPath: string, fallbackName: string): StubEntry | null {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const containsPyi = items.some(item => item.isFile() && (item.name.endsWith('.pyi') || item.name.endsWith('.py')));
  const distInfoDirs = items.filter(item => item.isDirectory() && item.name.endsWith('.dist-info'));
  if (!containsPyi && distInfoDirs.length === 0) return null;

  if (distInfoDirs.length > 0) {
    const info = parseDistInfoName(distInfoDirs[0].name);
    if (info) {
      const normalizedName = info.pkg.replace(/_/g, '-');
      const parsed = parsePortBoardFromName(normalizedName);
      return {
        name: `${normalizedName}-${info.ver}`,
        version: info.version,
        port: parsed.port,
        board: parsed.board,
        path: fullPath,
      };
    }
  }

  const version = parseVersionFromName(fallbackName);
  const parsed = parsePortBoardFromName(fallbackName);
  return {
    name: fallbackName,
    version,
    port: parsed.port,
    board: parsed.board,
    path: fullPath,
  };
}

let cachedEntries: StubEntry[] | null = null;
let cachedPathsKey: string | null = null;

export function indexStubPaths(searchPaths: string[], forceRefresh = false): StubEntry[] {
  const key = searchPaths.join('|');
  if (!forceRefresh && cachedEntries && cachedPathsKey === key) return cachedEntries;

  const out: StubEntry[] = [];
  for (const base of searchPaths) {
    try {
      if (!fs.existsSync(base)) continue;
      const items = fs.readdirSync(base, { withFileTypes: true });

      const baseEntry = inspectDirectoryEntry(base, path.basename(base));
      if (baseEntry) {
        out.push(baseEntry);
      }

      for (const it of items) {
        if (!it.isDirectory()) continue;
        const full = path.join(base, it.name);
        const childEntry = inspectDirectoryEntry(full, it.name);
        if (childEntry) {
          out.push(childEntry);
        }
      }
    } catch (e) {
      // ignore path read errors
      continue;
    }
  }

  cachedEntries = out;
  cachedPathsKey = key;
  return out;
}

export function refreshIndex(searchPaths: string[]): StubEntry[] {
  return indexStubPaths(searchPaths, true);
}

export function clearIndex() {
  cachedEntries = null;
  cachedPathsKey = null;
}

function compareVersion(a: NonNullable<StubEntry['version']>, b: NonNullable<StubEntry['version']>) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function scoreVersion(entryVersion: NonNullable<StubEntry['version']> | null | undefined, deviceVersion: { major: number; minor: number; patch: number } | null) {
  if (!entryVersion || !deviceVersion) return 0;

  let score = 0;
  if (entryVersion.major === deviceVersion.major) score += 200;
  if (entryVersion.minor === deviceVersion.minor) score += 220;
  if (entryVersion.patch === deviceVersion.patch) score += 140;

  const delta = Math.abs(compareVersion(entryVersion, deviceVersion));
  score += Math.max(0, 40 - delta * 5);
  if (compareVersion(entryVersion, deviceVersion) <= 0) score += 30;

  return score;
}

function scoreNameMatch(entry: StubEntry, opts: { port?: string; machine?: string; board?: string }) {
  const normalizedName = normalizeKey(entry.name);
  const portHint = normalizeKey(opts.port);
  const machineHint = normalizeKey(opts.machine);
  const boardHint = normalizeKey(opts.board);

  let score = 0;
  if (portHint && normalizedName.includes(portHint)) score += 120;
  if (boardHint && normalizedName.includes(boardHint)) score += 80;
  if (machineHint && normalizedName.includes(machineHint)) score += 50;

  return score;
}

export function findBestMatch(entries: StubEntry[], opts: { release?: string | undefined; port?: string | undefined; machine?: string | undefined; board?: string | undefined } = {}): StubEntry | null {
  if (!entries || entries.length === 0) return null;

  const rel = opts.release ? String(opts.release).split('-')[0] : undefined;
  const deviceVersion = parseVersionString(rel);

  let bestEntry: StubEntry | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const score = scoreVersion(entry.version, deviceVersion) + scoreNameMatch(entry, opts);
    if (score > bestScore) {
      bestEntry = entry;
      bestScore = score;
      continue;
    }

    if (
      score === bestScore &&
      bestEntry?.version &&
      entry.version &&
      compareVersion(entry.version, bestEntry.version) > 0
    ) {
      bestEntry = entry;
    }
  }

  if (bestEntry) return bestEntry;

  const withVer = entries.filter(e => e.version).sort((a, b) => compareVersion(b.version as any, a.version as any));
  if (withVer.length > 0) return withVer[0];

  return entries[0] || null;
}
