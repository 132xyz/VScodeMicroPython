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
  // crude parse: find parts after version
  // split by '-' and look for esp32/esp8266/pyboard parts
  const parts = n.split('-');
  const after = parts.slice(1);
  let port: string | null = null;
  let board: string | null = null;
  if (after.length > 0) {
    port = after[0] || null;
    if (after.length > 1) board = after[1] || null;
  }
  return { port, board };
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

      // If base itself contains .pyi files or a dist-info dir, treat base as a stub package
      const baseFiles = items.filter(i => i.isFile()).map(i => i.name);
      const containsPyiAtRoot = baseFiles.some(f => f.endsWith('.pyi') || f.endsWith('.py'));
      const distInfoDirs = items.filter(i => i.isDirectory() && i.name.endsWith('.dist-info'));
      if (containsPyiAtRoot || distInfoDirs.length > 0) {
        // prefer dist-info to construct name/version
        if (distInfoDirs.length > 0) {
          const info = parseDistInfoName(distInfoDirs[0].name);
          if (info) {
            const normName = info.pkg.replace(/_/g, '-');
            out.push({ name: `${normName}-${info.ver}`, version: info.version, port: null, board: null, path: base });
          } else {
            out.push({ name: path.basename(base), version: null, port: null, board: null, path: base });
          }
        } else {
          out.push({ name: path.basename(base), version: null, port: null, board: null, path: base });
        }
      }

      for (const it of items) {
        if (!it.isDirectory()) continue;
        const full = path.join(base, it.name);
        // Heuristic: accept directory if it contains any .pyi files or a package folder
        let dirEntries: string[] = [];
        try { dirEntries = fs.readdirSync(full); } catch { continue; }
        const containsPyi = dirEntries.some(f => f.endsWith('.pyi') || f.endsWith('.py'));
        if (!containsPyi) continue;
        const ver = parseVersionFromName(it.name);
        const pb = parsePortBoardFromName(it.name);
        out.push({ name: it.name, version: ver, port: pb.port, board: pb.board, path: full });
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

export function findBestMatch(entries: StubEntry[], opts: { release?: string | undefined; machine?: string | undefined } = {}): StubEntry | null {
  if (!entries || entries.length === 0) return null;
  const relRaw = opts.release;
  const mach = opts.machine;

  // clean release: drop any suffix like '-preview'
  const rel = relRaw ? String(relRaw).split('-')[0] : undefined;

  // attempt exact match by machine (sysname) or by version tokens present in name
  if (mach) {
    const mnorm = mach.toString().toLowerCase();
    const byMachine = entries.find(e => e.name.toLowerCase().includes(mnorm));
    if (byMachine) return byMachine;
  }

  if (rel) {
    // try to match version tokens like v1_28_0 or v1_28
    const mFull = rel.replace(/\./g, '_'); // e.g. 1.28.0 -> 1_28_0
    const vFull = `v${mFull}`;
    const mMinor = (/^(\d+)\.(\d+)/.exec(rel) || []).slice(1).join('_');
    const vMinor = mMinor ? `v${mMinor}` : '';

    const byRelFull = entries.find(e => e.name.toLowerCase().includes(vFull.toLowerCase()));
    if (byRelFull) return byRelFull;
    if (vMinor) {
      const byRelMinor = entries.find(e => e.name.toLowerCase().includes(vMinor.toLowerCase()));
      if (byRelMinor) return byRelMinor;
    }
  }

  // fallback: pick latest by version
  const withVer = entries.filter(e => e.version).sort((a, b) => compareVersion(b.version as any, a.version as any));
  if (withVer.length > 0) return withVer[0];

  // last resort: first entry
  return entries[0] || null;
}
