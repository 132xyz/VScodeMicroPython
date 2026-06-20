import { execFile, ChildProcess, exec } from "node:child_process";
import { MpRemoteManager } from './MpRemoteManager';
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as mpyClient from "./mpyClient";

// (no-op) module load debug removed

// Debug logging helper controlled by `microPythonWorkBench.debug` setting (default: false)
const debugLog = (...args: any[]) => {
  try {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.debug", false);
    if (enabled) console.debug(...args);
  } catch {}
};

async function formatMpremoteCmd(args: string[], pythonPath?: string | null): Promise<string> {
  const escaped = args.map(arg => arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg).join(' ');
  const py = pythonPath ?? await MpRemoteManager.detectPythonPath();
  if (py) return `"${py}" -m mpremote ${escaped}`;
  return `mpremote ${escaped}`;
}

export function normalizeConnect(c: string): string {
  if (c.startsWith("serial://") || c.startsWith("serial:/")) {
    const normalized = c.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    if (normalized.startsWith("/dev/")) return normalized;
    if (process.platform === 'win32' && normalized.startsWith('/')) {
      return normalized.slice(1);
    }
    if (/^\/COM\d+$/i.test(normalized)) {
      return normalized.slice(1);
    }
    return normalized;
  }

  // On macOS, add /dev/ prefix if it's missing and looks like a cu.* device
  if (c.startsWith("cu.") && !c.startsWith("/dev/")) {
    const normalized = `/dev/${c}`;
    debugLog(`normalizeConnect: Added /dev/ prefix: ${c} -> ${normalized}`);
    return normalized;
  }

  debugLog(`normalizeConnect: Using as-is: ${c}`);
  return c;
}

let selectedConnectOverride: string | undefined;

function cleanConnectValue(connect: string | null | undefined): string {
  const value = (connect ?? "auto").trim();
  return value.length > 0 ? value : "auto";
}

export function getConfiguredConnect(): string {
  return cleanConnectValue(vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto"));
}

function isAutoConnect(connect: string | null | undefined): boolean {
  const value = cleanConnectValue(connect);
  return value.toLowerCase() === "auto" || normalizeConnect(value).toLowerCase() === "auto";
}

export function setSelectedConnect(connect: string | null | undefined): string {
  selectedConnectOverride = cleanConnectValue(connect);
  return selectedConnectOverride;
}

export function clearSelectedConnect(): void {
  selectedConnectOverride = undefined;
}

export function getSelectedConnect(): string | undefined {
  return selectedConnectOverride;
}

export function getActiveConnect(): string {
  if (selectedConnectOverride && !isAutoConnect(selectedConnectOverride)) {
    return selectedConnectOverride;
  }

  const configuredConnect = getConfiguredConnect();
  if (!isAutoConnect(configuredConnect)) {
    return configuredConnect;
  }

  return "auto";
}

// Helper: determine a safe device root for the current workspace when rootPath is '/'.
// This function performs synchronous IO so mapping helpers can remain synchronous.
function getEffectiveDeviceRootSync(): string {
  try {
    // Allow tests or environment to override the device root to avoid filesystem operations
    const envOverride = process.env.MPY_DEVICE_ROOT;
    if (envOverride && typeof envOverride === 'string' && envOverride.trim().length > 0) {
      return envOverride.startsWith('/') ? envOverride : `/${envOverride}`;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      // No workspace — return a transient device folder name to avoid using '/'
      const name = `mpy_${Math.random().toString(16).slice(2, 10)}`;
      return `/${name}`;
    }
    const wsPath = ws.uri.fsPath;
    const workbenchDir = path.join(wsPath, '.mpy-workbench');
    const cfgPath = path.join(workbenchDir, 'config.json');
    try {
      if (fs.existsSync(cfgPath)) {
        const txt = fs.readFileSync(cfgPath, 'utf8');
        const parsed = JSON.parse(txt || '{}');
        if (parsed && typeof parsed.deviceRoot === 'string' && parsed.deviceRoot.trim().length > 0) {
          return parsed.deviceRoot;
        }
      }
    } catch (err) {
      console.warn('[DEBUG] getEffectiveDeviceRootSync: failed reading config', err);
    }
    // Create a deterministic-ish random name and persist it
    const rand = crypto.randomBytes(4).toString('hex');
    const name = `mpy_${rand}`;
    const deviceRoot = `/${name}`;
    try {
      if (!fs.existsSync(workbenchDir)) fs.mkdirSync(workbenchDir, { recursive: true });
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8') || '{}') : {};
      cfg.deviceRoot = deviceRoot;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
      console.warn('[DEBUG] getEffectiveDeviceRootSync: failed writing config, proceeding without persisting', err);
    }
    return deviceRoot;
  } catch (err) {
    // As a final fallback, return a random name but do not persist
    const name = `mpy_${Math.random().toString(16).slice(2, 10)}`;
    return `/${name}`;
  }
}

// Map a local-relative path to a device path using configured rootPath; when rootPath is '/', use
// the workspace-scoped device root computed by getEffectiveDeviceRootSync().
export function toDevicePath(localRel: string, rootPath: string): string {
  const normLocal = localRel ? localRel.replace(/^\/+/, '') : '';
  const rawRoot = (rootPath || "/");
  if (rawRoot === "/") {
    const effective = getEffectiveDeviceRootSync();
    return effective + (normLocal ? `/${normLocal}` : '');
  }
  const normRoot = rawRoot.replace(/\/$/, '');
  return normLocal ? `${normRoot}/${normLocal}` : `${normRoot}`;
}

// Map a device path to a local-relative path according to rootPath. Returns null when the device
// path equals the effective device root (caller must handle this safely).
export function toLocalRelative(devicePath: string, rootPath: string): string | null {
  const rawRoot = (rootPath || "/");
  const dp = devicePath.replace(/^\/+/, '');

  // New semantics: always map device paths into the local sync directory by
  // returning a local-relative path. For a configured non-root `rootPath`, we
  // strip that prefix; for `rootPath === '/'` we simply strip the leading
  // slash from the device path so that `/foo/bar.py` -> `foo/bar.py` (which
  // will resolve under the local sync root).
  if (rawRoot === "/") {
    // If workspace-scoped effective device root is being used (tests or
    // persisted config), map paths under that root specially so that the
    // effective root itself maps to '' (the local sync root) and children
    // map to their relative paths. For other absolute device paths, fall
    // back to simple leading-slash stripping so they still map under the
    // local sync directory.
    const effective = getEffectiveDeviceRootSync();
    const effNo = effective.replace(/^\/+/, '');
    if (dp === effNo) return '';
    if (dp.startsWith(effNo + '/')) return dp.slice(effNo.length + 1);
    return dp;
  }

  const normRoot = rawRoot.replace(/\/$/, '');
  const rootNoSlash = normRoot.replace(/^\/+/, '');
  if (dp === rootNoSlash) return '';
  if (dp.startsWith(rootNoSlash + '/')) return dp.slice(rootNoSlash.length + 1);
  return null; // outside configured root
}

let currentChild: ChildProcess | null = null;

// Connection Manager for optimized mpremote connections
class ConnectionManager {
  private activeConnections: Map<string, { lastUsed: number; isHealthy: boolean; operationInProgress: boolean }> = new Map();
  private readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
  private readonly HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
  private healthCheckTimer?: NodeJS.Timeout;

  constructor() {
    this.startHealthChecks();
  }

  // Get or create a connection for a specific port
  getConnection(port: string): { port: string; shouldReuse: boolean } {
    const now = Date.now();
    const existing = this.activeConnections.get(port);

    if (existing && (now - existing.lastUsed) < this.CONNECTION_TIMEOUT && existing.isHealthy) {
      // Update last used time
      existing.lastUsed = now;
      return { port, shouldReuse: true };
    }

    // Create new connection entry
    this.activeConnections.set(port, { lastUsed: now, isHealthy: true, operationInProgress: false });
    return { port, shouldReuse: false };
  }

  // Mark connection as unhealthy (after errors)
  markUnhealthy(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.isHealthy = false;
    }
  }

  // Mark connection as healthy (after successful operations)
  // Note: Does NOT reset operationInProgress - that should be done explicitly
  markHealthy(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.isHealthy = true;
      connection.lastUsed = Date.now();
      // Don't reset operationInProgress here - let markOperationCompleted handle it
    }
  }

  // Mark operation as started (to prevent concurrent operations)
  markOperationStarted(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.operationInProgress = true;
    }
  }

  // Check if operation is in progress
  isOperationInProgress(port: string): boolean {
    const connection = this.activeConnections.get(port);
    return connection ? connection.operationInProgress : false;
  }

  // Mark operation as completed
  markOperationCompleted(port: string): void {
    const connection = this.activeConnections.get(port);
    if (connection) {
      connection.operationInProgress = false;
    }
  }

  // Clean up old connections
  private cleanup(): void {
    const now = Date.now();
    for (const [port, connection] of this.activeConnections.entries()) {
      if ((now - connection.lastUsed) > this.CONNECTION_TIMEOUT) {
        this.activeConnections.delete(port);
      }
    }
  }

  // Start periodic health checks
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      this.cleanup();
    }, this.HEALTH_CHECK_INTERVAL);
    // Ensure the timer does not keep the Node.js event loop alive (helps tests exit)
    try {
      if (this.healthCheckTimer && (this.healthCheckTimer as any).unref) (this.healthCheckTimer as any).unref();
    } catch (e) {
      // ignore if unref not available
    }
  }

  // Stop health checks (cleanup)
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    this.activeConnections.clear();
  }

  // Get connection stats for debugging
  getStats(): { activeConnections: number; totalConnections: number } {
    return {
      activeConnections: this.activeConnections.size,
      totalConnections: this.activeConnections.size
    };
  }
}

// Global connection manager instance
const connectionManager = new ConnectionManager();

/**
 * Detect Python interpreter path using multiple fallback methods
 */
async function detectPythonPath(): Promise<string | null> {
  // Method 1: Check VS Code Python extension
  try {
    const pythonExtension = vscode.extensions.getExtension('ms-python.python');
    if (pythonExtension && pythonExtension.isActive) {
      const pythonApi = pythonExtension.exports;
      if (pythonApi && pythonApi.settings && pythonApi.settings.getExecutionDetails) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const executionDetails = pythonApi.settings.getExecutionDetails(workspaceFolder?.uri);
        if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
          return executionDetails.execCommand[0];
        }
      }
    }
  } catch (error) {
    console.log('Failed to get Python from extension API:', error);
  }

  // Method 2: Check configuration
  const config = vscode.workspace.getConfiguration('python');
  const configuredPath = config.get<string>('defaultInterpreterPath') || config.get<string>('pythonPath');
  if (configuredPath) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(configuredPath, ['--version'], (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return configuredPath;
    } catch (error) {
      // Continue to next method
    }
  }

  // Method 3: Try common Python executables
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py', 'py -3']
    : ['python3', 'python'];

  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ['--version'], (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return candidate;
    } catch (error) {
      // Continue to next candidate
    }
  }

  return null;
}

export function runMpremote(
  args: string[],
  opts: { cwd?: string; retryOnFailure?: boolean; env?: NodeJS.ProcessEnv; pythonPath?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    const maxRetries = opts.retryOnFailure !== false ? 2 : 0;
    let attempt = 0;

    // Extract port from connect command for connection management
    let port = "";
    const connectIndex = args.indexOf("connect");
    if (connectIndex !== -1 && connectIndex + 1 < args.length) {
      port = args[connectIndex + 1];
    }

    const executeCommand = async () => {
      attempt++;

      // Note: MpRemoteManager.run already handles serialization via its internal lock,
      // so we don't need to queue here based on connectionManager.isOperationInProgress.
      // The connectionManager is used only for health tracking.

      if (port) {
        connectionManager.getConnection(port); // Ensure connection entry exists
        connectionManager.markHealthy(port);
      }

      try {
        const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(opts.env || {}) };
        // default timeout to avoid indefinite hangs during mpremote startup/import
        const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 20000;
        const res = await MpRemoteManager.run(args, { cwd: opts.cwd, env, retryOnFailure: opts.retryOnFailure, pythonPath: opts.pythonPath, timeoutMs });

        if (port) {
          connectionManager.markHealthy(port);
        }

        return resolve(res);
      } catch (err: any) {
        const emsg = String(err?.message || err || "");
        const errorStr = emsg.toLowerCase();

        if (port && (errorStr.includes("device not configured") ||
                     errorStr.includes("serial port not found") ||
                     errorStr.includes("connection failed"))) {
          connectionManager.markUnhealthy(port);
        }

        if (attempt <= maxRetries && (
          errorStr.includes("device not configured") ||
          errorStr.includes("connection timeout") ||
          errorStr.includes("serial read failed") ||
          errorStr.includes("failed to access") ||
          errorStr.includes("it may be in use by another program")
        )) {
          console.log(`mpremote command failed (attempt ${attempt}/${maxRetries + 1}), retrying...`);

          // If the error indicates the serial port may be in use, try to cancel any
          // active mpremote child process managed by MpRemoteManager, then close terminals.
          if (errorStr.includes("it may be in use by another program") || errorStr.includes("failed to access")) {
            try {
              // Cancel active child process first to free the port
              try { MpRemoteManager.cancelActive(); } catch (e) { console.warn('[DEBUG] runMpremote: cancelActive failed', e); }

              const terms = vscode.window.terminals.slice();
              for (const t of terms) {
                const name = (t.name || '').toLowerCase();
                if (name.includes('esp32 repl') || name.includes('repl') || name.includes('esp32 run') || name.includes('run file')) {
                  try {
                    console.log('[DEBUG] runMpremote: Disposing terminal that may hold serial port:', t.name);
                    // Try gentle interrupt first
                    try { t.sendText('\x18', false); } catch {}
                    t.dispose();
                  } catch (e) {
                    console.warn('[DEBUG] runMpremote: Failed to dispose terminal', t.name, e);
                  }
                }
              }
            } catch (e) {
              console.warn('[DEBUG] runMpremote: Error while attempting to cancel child/close terminals:', e);
            }
          }

          // Delay slightly longer after attempting to free the port
          setTimeout(() => void executeCommand(), 700 * attempt);
          return;
        }

        return reject(new Error(emsg || "mpremote error"));
      }
    };

    // Start first attempt
    void executeCommand();
  });
}

export async function ls(p: string): Promise<string> {
  try {
    // Get the typed entries and convert to string format
    const entries = await lsTyped(p);
    const filenames = entries.map(entry => entry.name);
    return filenames.join('\n');
  } catch (error) {
    throw error;
  }
}

// Tree node structure for building hierarchical representation
interface TreeNode {
  name: string;
  isDir: boolean;
  children: TreeNode[];
  fullPath: string;
}

function buildTreeFromStats(stats: Array<{ path: string; isDir: boolean; size?: number; mtime?: number }>): TreeNode {
  const root: TreeNode = { name: "", isDir: true, children: [], fullPath: "/" };
  const nodeMap = new Map<string, TreeNode>([["/", root]]);

  for (const stat of stats) {
    const fullPath = stat.path.startsWith("/") ? stat.path : `/${stat.path}`;
    if (fullPath === "/") continue;
    const parts = fullPath.split("/").filter(Boolean);
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
    const name = parts[parts.length - 1];
    const parent = nodeMap.get(parentPath);
    if (!parent) continue;
    const node: TreeNode = { name, isDir: stat.isDir, children: [], fullPath };
    parent.children.push(node);
    if (stat.isDir) nodeMap.set(fullPath, node);
  }

  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

// Global cache for the complete file tree
let globalFileTreeCache: TreeNode | null = null;
let lastTreeUpdate: number = 0;
const TREE_CACHE_DURATION = 30000; // 30 seconds

function getTreePathsCacheFile(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return null;
  }

  return path.join(workspaceFolder.uri.fsPath, '.mpy-workbench', 'tree-paths.json');
}

// Populate the global cache with complete file tree
async function populateFileTreeCache(): Promise<void> {
  try {
    debugLog(`populateFileTreeCache: Starting cache population`);
    const connectSetting = getActiveConnect();
    const connect = normalizeConnect(connectSetting);
    if (connectSetting === "auto") {
      debugLog(`populateFileTreeCache: connect=auto and no active connection — skipping device probe`);
      globalFileTreeCache = { name: '/', isDir: true, children: [], fullPath: '/' };
      lastTreeUpdate = Date.now();
      return;
    }

    debugLog(`populateFileTreeCache: Fetching complete file tree from device through custom transport`);
    const stats = await listTreeStats("/");
    const treeRoot = buildTreeFromStats(stats);

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const filePath = getTreePathsCacheFile();
      if (workspaceFolder && filePath) {
        const cachedData = stats.map(item => ({
          fullPath: item.path,
          name: item.path.split('/').filter(Boolean).pop() || '',
          isDir: item.isDir,
          depth: Math.max(0, item.path.split('/').filter(Boolean).length - 1),
        }));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(cachedData, null, 2), 'utf8');
      }
    } catch (error) {
      console.error(`Failed to save parsed paths:`, error);
    }

    globalFileTreeCache = treeRoot;
    lastTreeUpdate = Date.now();
    try {
      await vscode.commands.executeCommand('microPythonWorkBench._cachePopulated');
    } catch (e) {
      // ignore
    }
  } catch (error) {
    console.error(`populateFileTreeCache: Failed to populate cache:`, error);
    throw error;
  }
}

// Check if cache needs refresh
function isCacheValid(): boolean {
  if (!globalFileTreeCache) return false;
  const now = Date.now();
  return (now - lastTreeUpdate) < TREE_CACHE_DURATION;
}

// Get entries for a specific path from cache
function getEntriesFromCache(targetPath: string): { name: string; isDir: boolean }[] | null {
  if (!globalFileTreeCache) {
    console.log(`[DEBUG] getEntriesFromCache: globalFileTreeCache is null`);
    return null;
  }

  console.log(`[DEBUG] getEntriesFromCache: Looking for ${targetPath} in cache`);
  console.log(`[DEBUG] getEntriesFromCache: Cache has ${globalFileTreeCache.children.length} root children`);
  console.log(`[DEBUG] getEntriesFromCache: Root children:`, globalFileTreeCache.children.map(c => `${c.name} (${c.isDir ? 'dir' : 'file'})`));

  if (targetPath === "/") {
    const result = globalFileTreeCache.children.map(child => ({
      name: child.name,
      isDir: child.isDir
    }));
    console.log(`[DEBUG] getEntriesFromCache: Found ${result.length} root items:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  }

  // Find the target directory node
  const pathParts = targetPath.split("/").filter(p => p);
  console.log(`[DEBUG] getEntriesFromCache: Path parts for ${targetPath}:`, pathParts);

  let currentNode = globalFileTreeCache;
  console.log(`[DEBUG] getEntriesFromCache: Starting from root node`);

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    console.log(`[DEBUG] getEntriesFromCache: Looking for '${part}' in ${currentNode.children.length} children`);
    console.log(`[DEBUG] getEntriesFromCache: Available children:`, currentNode.children.map(c => c.name));

    const found = currentNode.children.find(child => child.name === part);
    if (!found) {
      console.log(`[DEBUG] getEntriesFromCache: Path ${targetPath} not found in cache - '${part}' not found`);
      console.log(`[DEBUG] getEntriesFromCache: Current node children:`, currentNode.children.map(c => `${c.name} (${c.isDir ? 'dir' : 'file'})`));
      return null;
    }
    currentNode = found;
    console.log(`[DEBUG] getEntriesFromCache: Found '${part}', continuing to next level`);
  }

  const result = currentNode.children.map(child => ({
    name: child.name,
    isDir: child.isDir
  }));

  console.log(`[DEBUG] getEntriesFromCache: Found ${result.length} items for ${targetPath}:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}

// Clear the cache (useful when files change)
export function clearFileTreeCache(): void {
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  const persistedCacheFile = getTreePathsCacheFile();
  if (persistedCacheFile) {
    try {
      if (fs.existsSync(persistedCacheFile)) {
        fs.unlinkSync(persistedCacheFile);
      }
    } catch (error) {
      console.warn(`[DEBUG] clearFileTreeCache: Failed to remove persisted cache file`, error);
    }
  }
  console.log(`[DEBUG] clearFileTreeCache: Cache cleared`);
}

// Force refresh the cache
export async function refreshFileTreeCache(): Promise<void> {
  console.log(`[DEBUG] refreshFileTreeCache: Forcing cache refresh`);
  globalFileTreeCache = null;
  lastTreeUpdate = 0;
  await populateFileTreeCache();
}

// Debug function to manually test tree parsing
export async function debugTreeParsing(): Promise<void> {
  try {
    const connect = normalizeConnect(getActiveConnect());
    console.log(`[DEBUG] debugTreeParsing: Testing tree request manually`);

    const stats = await mpyClient.tree(connect, "/");
    console.log(`[DEBUG] debugTreeParsing: Raw tree stats:`, stats);

    const treeRoot = buildTreeFromStats(stats.map(item => {
      const mode = Number(item.mode || 0);
      return {
        path: item.path,
        isDir: Boolean(item.is_dir ?? item.isDir ?? ((mode & 0x4000) !== 0)),
        size: Number(item.size || 0),
        mtime: Number(item.mtime || 0),
      };
    }));
    console.log(`[DEBUG] debugTreeParsing: Built tree with ${treeRoot.children.length} root children`);

    // Test getting entries for root
    const rootEntries = getEntriesFromCache("/");
    console.log(`[DEBUG] debugTreeParsing: Root entries:`, rootEntries);

    // Test getting entries for first subdirectory if exists
    if (treeRoot.children.length > 0 && treeRoot.children[0].isDir) {
      const subPath = `/${treeRoot.children[0].name}`;
      console.log(`[DEBUG] debugTreeParsing: Testing subpath: ${subPath}`);
      const subEntries = getEntriesFromCache(subPath);
      console.log(`[DEBUG] debugTreeParsing: Sub entries for ${subPath}:`, subEntries);
    }

  } catch (error) {
    console.error(`[DEBUG] debugTreeParsing: Error:`, error);
  }
}

// Debug function to check filesystem status and read-only issues
export async function debugFilesystemStatus(): Promise<void> {
  try {
    const connect = normalizeConnect(getActiveConnect());
    console.log(`[DEBUG] debugFilesystemStatus: Checking filesystem status`);

    // Check root filesystem stat
    console.log(`[DEBUG] debugFilesystemStatus: Checking root filesystem stat...`);
    const statOutput = await mpyClient.stat(connect, "/");
    console.log(`[DEBUG] debugFilesystemStatus: Root filesystem stat:`, statOutput);

    // Try to check mount information
    console.log(`[DEBUG] debugFilesystemStatus: Checking mount information...`);
    try {
      const { stdout: mountOutput } = await mpyClient.exec(connect, "import os; print(os.listdir('/'))");
      console.log(`[DEBUG] debugFilesystemStatus: Root directory listing:\n${mountOutput}`);
    } catch (mountError) {
      console.error(`[DEBUG] debugFilesystemStatus: Could not list root directory:`, mountError);
    }

    // Try to check if we can write to root
    console.log(`[DEBUG] debugFilesystemStatus: Testing write permissions...`);
    try {
      await mpyClient.exec(connect, "f = open('test_write.tmp', 'w'); f.write('test'); f.close()");
      console.log(`[DEBUG] debugFilesystemStatus: Write test to root succeeded`);

      // Clean up test file
      try {
        await mpyClient.exec(connect, "import os; os.remove('test_write.tmp')");
        console.log(`[DEBUG] debugFilesystemStatus: Test file cleanup succeeded`);
      } catch (cleanupError) {
        console.log(`[DEBUG] debugFilesystemStatus: Test file cleanup failed:`, cleanupError);
      }
    } catch (writeError) {
      console.error(`[DEBUG] debugFilesystemStatus: Write test to root failed:`, writeError);
    }

    // Try to check if we can write to a subdirectory
    console.log(`[DEBUG] debugFilesystemStatus: Testing write permissions in subdirectory...`);
    try {
      await mpyClient.exec(connect, "import os\ntry:\n    os.mkdir('test_dir')\nexcept OSError:\n    pass");
      console.log(`[DEBUG] debugFilesystemStatus: Directory creation succeeded`);

      await mpyClient.exec(connect, "f = open('test_dir/test_write.tmp', 'w'); f.write('test'); f.close()");
      console.log(`[DEBUG] debugFilesystemStatus: Write test in subdirectory succeeded`);

      // Clean up
      try {
        await mpyClient.exec(connect, "import os; os.remove('test_dir/test_write.tmp'); os.rmdir('test_dir')");
        console.log(`[DEBUG] debugFilesystemStatus: Cleanup succeeded`);
      } catch (cleanupError) {
        console.log(`[DEBUG] debugFilesystemStatus: Cleanup failed:`, cleanupError);
      }
    } catch (subdirError) {
      console.error(`[DEBUG] debugFilesystemStatus: Subdirectory write test failed:`, subdirError);
    }

    // Check MicroPython version and build
    console.log(`[DEBUG] debugFilesystemStatus: Checking MicroPython version...`);
    try {
      const { stdout: versionOutput } = await mpyClient.exec(connect, "import sys; print('MicroPython version:', sys.version)");
      console.log(`[DEBUG] debugFilesystemStatus: Version info:\n${versionOutput}`);
    } catch (versionError) {
      console.error(`[DEBUG] debugFilesystemStatus: Could not get version:`, versionError);
    }

  } catch (error) {
    console.error(`[DEBUG] debugFilesystemStatus: Error during filesystem check:`, error);
  }
}

// Get cache statistics for debugging
export function getFileTreeCacheStats(): {
  isValid: boolean;
  age: number;
  itemCount: number;
  lastUpdate: number;
} {
  const isValid = isCacheValid();
  const age = Date.now() - lastTreeUpdate;
  let itemCount = 0;

  if (globalFileTreeCache) {
    // Count all nodes in the tree
    const countNodes = (node: TreeNode): number => {
      let count = 1; // count this node
      for (const child of node.children) {
        count += countNodes(child);
      }
      return count;
    };
    itemCount = countNodes(globalFileTreeCache);
  }

  return {
    isValid,
    age,
    itemCount,
    lastUpdate: lastTreeUpdate
  };
}

// Parse tree output into flat list with full paths
function parseTreeLines(treeOutput: string): Array<{fullPath: string, name: string, isDir: boolean, depth: number}> {
  const lines = treeOutput.split(/\r?\n/).filter(line => line.trim());
  const result: Array<{fullPath: string, name: string, isDir: boolean, depth: number}> = [];
  const dirStack: string[] = [];

  console.log(`[DEBUG] Parsing ${lines.length} tree lines`);

  for (const line of lines) {
    // Skip irrelevant lines
    if (!line.trim() || line.includes('tree') || line === ':/' || line === ':') continue;

    console.log(`[DEBUG] Processing: "${line}"`);

    // Parse the line to get level and name
    const parseResult = parseTreeLine(line);
    if (!parseResult) {
      console.log(`[DEBUG] Could not parse line: "${line}"`);
      continue;
    }

    const { level, name } = parseResult;
    console.log(`[DEBUG] Parsed level: ${level}, name: "${name}"`);

    // Adjust directory stack to match current level
    // Keep only elements up to the current level
    dirStack.splice(level);

    // Build full path
    const fullPath = dirStack.length === 0 ? `/${name}` : `${dirStack[dirStack.length - 1]}/${name}`;
    console.log(`[DEBUG] Built full path: ${fullPath}`);

    // Determine if it's a directory
    const isDir = determineIsDirectory(name, lines, lines.indexOf(line));
    console.log(`[DEBUG] Final determination: ${name} is ${isDir ? 'directory' : 'file'}`);

    result.push({ fullPath, name, isDir, depth: level });

    // Add to directory stack if it's a directory
    if (isDir) {
      dirStack.push(fullPath);
      console.log(`[DEBUG] Added to stack: ${fullPath} (stack: [${dirStack.join(', ')}])`);
    }
  }

  console.log(`[DEBUG] Parsed ${result.length} items:`, result.map(r => `${r.fullPath} (${r.isDir ? 'dir' : 'file'})`));
  return result;
}

// Helper function to parse a single tree line
function parseTreeLine(line: string): { level: number, name: string } | null {
  if (!line.trim()) return null;

  const originalLine = line;
  let level = 0;
  let pos = 0;

  // Analyze character by character from the start
  while (pos < line.length) {
    const remaining = line.substring(pos);

    // Check for specific tree patterns
    if (remaining.startsWith('├──') || remaining.startsWith('└──')) {
      // This is the current item at this level
      const name = remaining.substring(3).trim();
      return { level, name };
    } else if (remaining.startsWith('│   ')) {
      // Continuation of parent level - advance level
      level += 1;
      pos += 4;
    } else if (remaining.startsWith('    ')) {
      // 4 spaces can also indicate level
      level += 1;
      pos += 4;
    } else {
      // If no pattern matches, check for space-based indentation
      const stripped = line.trim();
      if (stripped && stripped !== line) {
        // Count spaces/indentation
        const indent = line.length - stripped.length;
        level = Math.floor(indent / 4); // Typically 4 spaces per level
        return { level, name: stripped };
      }
      break;
    }
  }

  return null;
}

// Helper function to determine if an item is a directory
function determineIsDirectory(name: string, allLines: string[], currentIndex: number): boolean {
  // First, check if it has an extension (likely a file)
  if (name.includes('.')) {
    // Check for common file extensions
    const parts = name.split('.');
    if (parts.length >= 2) {
      const ext = parts[parts.length - 1].toLowerCase();
      const fileExtensions = new Set([
        'py', 'txt', 'log', 'md', 'html', 'css', 'js', 'json',
        'ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'csv', 'xml',
        'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf'
      ]);
      if (fileExtensions.has(ext)) {
        return false;
      }
    }
  }

  // Check for special files without extension
  const specialFiles = new Set(['main', 'boot', 'README', 'LICENSE', 'Makefile']);
  if (specialFiles.has(name)) {
    return false;
  }

  // Look ahead in the tree to see if this item has children
  for (let j = currentIndex + 1; j < allLines.length && j < currentIndex + 10; j++) {
    const nextLine = allLines[j].trim();
    if (!nextLine || nextLine.includes('tree') || nextLine === ':') break;

    // Parse the next line
    const nextParse = parseTreeLine(nextLine);
    if (nextParse && nextParse.level > 0) {
      // If next item has higher level, this is a directory
      return true;
    }

    // If we hit an item at the same or lower level, stop looking
    if (nextParse && nextParse.level <= 0) {
      break;
    }
  }

  // If no extension and not a special file, assume it's a directory
  if (!name.includes('.') && name !== 'tree' && name.length > 0 && !name.startsWith('.')) {
    return true;
  }

  return false;
}


// Build tree structure from parsed lines (helper function)
function buildTreeFromParsedLines(parsedLines: Array<{fullPath: string, name: string, isDir: boolean, depth: number}>): TreeNode {
  console.log(`[DEBUG] buildTreeFromParsedLines: Building tree from ${parsedLines.length} parsed lines`);

  const root: TreeNode = {
    name: "",
    isDir: true,
    children: [],
    fullPath: "/"
  };

  const nodeMap = new Map<string, TreeNode>();
  nodeMap.set("/", root);

  for (const item of parsedLines) {
    console.log(`[DEBUG] buildTreeFromParsedLines: Processing ${item.fullPath} (depth: ${item.depth})`);

    const pathParts = item.fullPath.split('/').filter(p => p);
    const parentPath = pathParts.length > 1 ? '/' + pathParts.slice(0, -1).join('/') : '/';

    console.log(`[DEBUG] buildTreeFromParsedLines: Path parts: [${pathParts.join(', ')}], parent: ${parentPath}`);

    const parentNode = nodeMap.get(parentPath);

    if (parentNode) {
      console.log(`[DEBUG] buildTreeFromParsedLines: Found parent ${parentPath}, adding ${item.name}`);

      const newNode: TreeNode = {
        name: item.name,
        isDir: item.isDir,
        children: [],
        fullPath: item.fullPath
      };

      parentNode.children.push(newNode);

      if (item.isDir) {
        nodeMap.set(item.fullPath, newNode);
        console.log(`[DEBUG] buildTreeFromParsedLines: Added directory ${item.fullPath} to nodeMap`);
      }

      console.log(`[DEBUG] buildTreeFromParsedLines: Added ${item.name} to ${parentPath}`);
    } else {
      console.log(`[DEBUG] buildTreeFromParsedLines: Parent ${parentPath} not found for ${item.fullPath}`);
    }
  }

  console.log(`[DEBUG] buildTreeFromParsedLines: Final tree structure:`);
  const printTree = (node: TreeNode, indent = 0) => {
    const prefix = '  '.repeat(indent);
    console.log(`${prefix}${node.name || '/'} (${node.isDir ? 'dir' : 'file'}) - ${node.children.length} children`);
    for (const child of node.children) {
      printTree(child, indent + 1);
    }
  };
  printTree(root);

  return root;
}

// Helper function to parse tree output and extract entries for a specific path
function parseTreeForPath(treeOutput: string, targetPath: string): { name: string; isDir: boolean }[] {
  console.log(`[DEBUG] parseTreeForPath: Parsing tree for path ${targetPath}`);

  try {
    // Parse tree into flat list with full paths
    const parsedLines = parseTreeLines(treeOutput);

    // Filter items that belong to the target path
    console.log(`[DEBUG] Filtering ${parsedLines.length} parsed lines for target path: ${targetPath}`);
    console.log(`[DEBUG] All parsed items:`, parsedLines.map(item => `${item.fullPath} (depth: ${item.depth})`));

    const targetItems = parsedLines.filter(item => {
      console.log(`[DEBUG] Checking item: ${item.fullPath} (depth: ${item.depth})`);

      if (targetPath === "/") {
        // For root, get only items at depth 0 (direct children of root)
        const matches = item.depth === 0;
        console.log(`[DEBUG] Root filter: ${item.fullPath} depth ${item.depth} -> ${matches ? 'KEEP' : 'FILTER OUT'}`);
        return matches;
      } else {
        // For subdirectories, get direct children of the target path
        const targetPathParts = targetPath.split('/').filter(p => p);
        const itemPathParts = item.fullPath.split('/').filter(p => p);

        console.log(`[DEBUG] Subdir filter: target parts: [${targetPathParts.join(', ')}], item parts: [${itemPathParts.join(', ')}]`);

        // Must be exactly one level deeper than target
        if (itemPathParts.length !== targetPathParts.length + 1) {
          console.log(`[DEBUG] Wrong depth: expected ${targetPathParts.length + 1}, got ${itemPathParts.length} -> FILTER OUT`);
          return false;
        }

        // Must start with the same path parts as target
        for (let i = 0; i < targetPathParts.length; i++) {
          if (itemPathParts[i] !== targetPathParts[i]) {
            console.log(`[DEBUG] Path mismatch at position ${i}: expected ${targetPathParts[i]}, got ${itemPathParts[i]} -> FILTER OUT`);
            return false;
          }
        }

        console.log(`[DEBUG] Subdir filter passed for: ${item.fullPath} -> KEEP`);
        return true;
      }
    });

    const result = targetItems.map(item => ({
      name: item.name,
      isDir: item.isDir
    }));

    console.log(`[DEBUG] parseTreeForPath: Found ${targetItems.length} items for ${targetPath}:`, targetItems.map(i => `${i.fullPath} (depth: ${i.depth})`));
    console.log(`[DEBUG] parseTreeForPath: Returning ${result.length} entries:`, result.map(r => `${r.name} (${r.isDir ? 'dir' : 'file'})`));
    return result;
  } catch (error) {
    console.error(`[DEBUG] parseTreeForPath: Error parsing tree:`, error);
    return [];
  }
}

export async function lsTyped(p: string): Promise<{ name: string; isDir: boolean }[]> {
  const connect = normalizeConnect(getActiveConnect());
  console.log(`[DEBUG] lsTyped: Getting entries for path ${p}`);

  try {
    const cacheValid = isCacheValid();
    console.log(`[DEBUG] lsTyped: Cache valid = ${cacheValid}, lastTreeUpdate = ${lastTreeUpdate}, now = ${Date.now()}`);

    if (!cacheValid) {
      const allowOnActivate = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.connectOnActivate", false);
      if (lastTreeUpdate === 0 && !allowOnActivate) {
        console.log(`[DEBUG] lsTyped: Skipping auto-populate on activation (connectOnActivate=false)`);
        const direct = await mpyClient.listdir(connect, p || "/");
        return direct.map(entry => ({ name: entry.name, isDir: Boolean(entry.is_dir ?? entry.isDir) }));
      }
      console.log(`[DEBUG] lsTyped: Cache invalid, populating...`);
      await populateFileTreeCache();
      console.log(`[DEBUG] lsTyped: Cache populated, globalFileTreeCache exists = ${!!globalFileTreeCache}`);
    } else {
      console.log(`[DEBUG] lsTyped: Using cached tree data`);
    }

    // Try to get entries from cache first
    const cachedResult = getEntriesFromCache(p);
    console.log(`[DEBUG] lsTyped: Cached result for ${p}:`, cachedResult);

    if (cachedResult && cachedResult.length > 0) {
      console.log(`[DEBUG] lsTyped: Found ${cachedResult.length} entries in cache for ${p}`);
      return cachedResult;
    }

    const direct = await mpyClient.listdir(connect, p || "/");
    return direct.map(entry => ({ name: entry.name, isDir: Boolean(entry.is_dir ?? entry.isDir) }));
  } catch (error) {
    console.error(`[DEBUG] lsTyped: Error for path ${p}: ${error}`);
    throw error;
  }
}

export type BoardDetectInfo = {
  machine?: string;
  sysname?: string;
  release?: string;
  id?: string;
};

export async function detectBoardInfo(): Promise<BoardDetectInfo | null> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") return null;

  // Collect uname + unique_id (when available) as JSON so it can be parsed reliably.
  // Single-line, no double quotes/newlines so Windows/cmd keeps quoting intact.
  const script = "import os,json,machine;info=os.uname();uid=machine.unique_id().hex() if hasattr(machine,'unique_id') else '';sysname=getattr(info,'sysname','');mach=getattr(info,'machine','');release=getattr(info,'release','');print(json.dumps({'machine':mach,'sysname':sysname,'release':release,'id':uid}))";

  try {
    const { stdout } = await mpyClient.exec(connect, script);
    const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
    const jsonLine = [...lines].reverse().find(l => l.startsWith("{") && l.endsWith("}"));
    if (!jsonLine) return null;
    const parsed = JSON.parse(jsonLine) as BoardDetectInfo;
    return parsed;
  } catch (error) {
    console.error("[DEBUG] detectBoardInfo: failed to detect board info", error);
    return null;
  }
}

export async function listSerialPorts(): Promise<{port: string, name: string}[]> {
  try {
    const devices = await mpyClient.listSerialPorts();
    if (devices.length === 0) {
      vscode.window.showWarningMessage("未检测到设备。请确保设备已连接且 Python 环境可用。");
    }
    return devices;
  } catch (err: any) {
    vscode.window.showWarningMessage("执行串口检测时出错：" + (err?.message || err));
    return [];
  }
}

export async function mkdir(p: string): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await mpyClient.mkdir(connect, p && p !== "/" ? p : "/");
  clearFileTreeCache();
}

export async function cpFromDevice(
  devicePath: string,
  localPath: string,
  opts: { token?: vscode.CancellationToken } = {},
): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    await mpyClient.readFile(connect, devicePath, localPath, opts.token);
  } catch (error: any) {
    throw new Error(`Failed to copy from device: ${error?.message || error}\nDevice path: ${devicePath}\nLocal path: ${localPath}`);
  }
}

export async function cpToDevice(localPath: string, devicePath: string): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    await mpyClient.writeFile(connect, localPath, devicePath);
    clearFileTreeCache();
  } catch (error: any) {
    await cleanupUploadTemp(connect, devicePath);
    console.error(`[DEBUG] cpToDevice: Upload failed:`, error);
    throw error;
  }
}

export async function uploadReplacing(localPath: string, devicePath: string, opts: { skipMkdir?: boolean } = {}): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    if (!opts.skipMkdir) {
      await mpyClient.writeFile(connect, localPath, devicePath);
    } else {
      await mpyClient.writeFile(connect, localPath, devicePath);
    }
    clearFileTreeCache();
  } catch (error) {
    await cleanupUploadTemp(connect, devicePath);
    throw error;
  }
}

export async function uploadReplacingWithProgress(
  localPath: string,
  devicePath: string,
  onProgress: (event: mpyClient.FileTransferProgress) => void,
  opts: { skipMkdir?: boolean; token?: vscode.CancellationToken } = {},
): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    await mpyClient.writeFileWithProgress(connect, localPath, devicePath, onProgress, opts.token);
    clearFileTreeCache();
  } catch (error) {
    await cleanupUploadTemp(connect, devicePath);
    throw error;
  }
}

async function cleanupUploadTemp(connect: string, devicePath: string): Promise<void> {
  try {
    await mpyClient.remove(connect, `${devicePath}.mpyupload`, false);
    clearFileTreeCache();
  } catch {
    // Best effort only. The original upload error is more useful to callers.
  }
}

export async function deleteFile(p: string): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await mpyClient.remove(connect, p, false);
  clearFileTreeCache();
}

export async function deleteDirectoryRecursive(p: string, connect: string): Promise<void> {
  await mpyClient.remove(connect, p, true);
  clearFileTreeCache();
}

export async function deleteAny(p: string): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  await mpyClient.remove(connect, p && p !== "/" ? p : "/", true);
  clearFileTreeCache();
}

export async function deleteFolderRecursive(p: string): Promise<void> {
  await deleteAny(p);
}

export async function fileExists(p: string): Promise<boolean> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    return (await mpyClient.stat(connect, p && p !== "/" ? p : "/")) !== null;
  } catch {
    return false;
  }
}

// Check file existence using sha256sum command (more reliable for detecting missing files)
export async function fileExistsSha256(p: string): Promise<boolean> {
  return fileExists(p);
}

export async function getFileInfo(p: string): Promise<{mode: number, size: number, isDir: boolean, isReadonly: boolean} | null> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const info = await mpyClient.stat(connect, p && p !== "/" ? p : "/");
    if (!info) return null;
    const mode = Number(info.mode || 0);
    return {
      mode,
      size: Number(info.size || 0),
      isDir: Boolean(info.is_dir ?? info.isDir ?? ((mode & 0x4000) !== 0)),
      isReadonly: Boolean(info.is_readonly ?? info.isReadonly ?? ((mode & 0x0080) === 0)),
    };
  } catch (error: any) {
    return null;
  }
}

export async function deleteAllInPath(rootPath: string): Promise<{deleted: string[], errors: string[], deleted_count?: number, error_count?: number}> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  // Get connection info for optimization
  const connection = connectionManager.getConnection(connect);

  const deleted: string[] = [];
  const errors: string[] = [];

  try {
    if (rootPath === "/") {
      clearFileTreeCache();

      try {
        const entries = await lsTyped("/");

        for (const entry of entries) {
          const targetPath = `/${entry.name.replace(/^\/+/, '')}`;
          try {
            await deleteAny(targetPath);
            deleted.push(targetPath);
          } catch (error: any) {
            errors.push(`Failed to delete ${targetPath}: ${error?.message || error}`);
            connectionManager.markUnhealthy(connect);
          }
        }
      } catch (error: any) {
        connectionManager.markUnhealthy(connect);
        return {
          deleted: [],
          errors: [String(error?.message || error)],
          deleted_count: 0,
          error_count: 1
        };
      }

      clearFileTreeCache();
      return {
        deleted,
        errors,
        deleted_count: deleted.length,
        error_count: errors.length
      };
    }

    // For non-root paths, delete the directory or file directly.
    try {
      await mpyClient.remove(connect, rootPath, true);
      deleted.push(rootPath);
    } catch (error: any) {
      errors.push(`Failed to delete ${rootPath}: ${error?.message || error}`);
      connectionManager.markUnhealthy(connect);
    }

    // Invalidate cache since filesystem changed
    clearFileTreeCache();

    return { 
      deleted, 
      errors, 
      deleted_count: deleted.length, 
      error_count: errors.length 
    };
  } catch (error: any) {
    connectionManager.markUnhealthy(connect);
    return { 
      deleted: [], 
      errors: [String(error?.message || error)], 
      deleted_count: 0, 
      error_count: 1 
    };
  }
}

export async function runFile(localPath: string): Promise<{ stdout: string; stderr: string }>{
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  const source = await fsPromises.readFile(localPath, "utf8");
  return mpyClient.exec(connect, source);
}

export async function reset(): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") return;

  try {
    await mpyClient.softReset(connect);
  } catch (error: any) {
    console.warn(`Reset command failed: ${error?.message || error}`);
  }
}

export async function listTreeStats(root: string): Promise<Array<{ path: string; isDir: boolean; size: number; mtime: number }>> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");
  try {
    const stats = await mpyClient.tree(connect, root && root !== "/" ? root : "/");
    return stats.map(item => {
      const mode = Number(item.mode || 0);
      return {
        path: item.path.startsWith("/") ? item.path : `/${item.path}`,
        isDir: Boolean(item.is_dir ?? item.isDir ?? ((mode & 0x4000) !== 0)),
        size: Number(item.size || 0),
        mtime: Number(item.mtime || 0),
      };
    });
  } catch (error) {
    connectionManager.markUnhealthy(connect);
    throw error;
  }
}

export function cancelAll(): void {
  try { currentChild?.kill('SIGKILL'); } catch {}
  currentChild = null;
}

// Health check function to verify connection status
export async function healthCheck(port?: string): Promise<{ healthy: boolean; port: string; responseTime?: number }> {
  const startTime = Date.now();
  const connect = port || normalizeConnect(getActiveConnect());

  try {
    await mpyClient.listdir(connect, "/");
    const responseTime = Date.now() - startTime;

    // Mark connection as healthy
    connectionManager.markHealthy(connect);
    return { healthy: true, port: connect, responseTime };
  } catch (error) {
    connectionManager.markUnhealthy(connect);
    return { healthy: false, port: connect };
  }
}

// Get connection statistics for debugging/monitoring
export function getConnectionStats(): {
  activeConnections: number;
  connectionManagerStats: any;
  currentChildPid?: number;
} {
  return {
    activeConnections: connectionManager.getStats().activeConnections,
    connectionManagerStats: connectionManager.getStats(),
    currentChildPid: currentChild?.pid
  };
}

// Optimized function to get both file list and sizes in one call
export async function getBoardFilesAndSizes(rootPath: string = "/"): Promise<{
  files: Map<string, { size: number; isDir: boolean }>;
  directories: Set<string>;
}> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const stats = await listTreeStats(rootPath);
    const files = new Map<string, { size: number; isDir: boolean }>();
    const directories = new Set<string>();
    for (const stat of stats) {
      if (stat.path === rootPath || stat.path === "/") continue;
      if (stat.isDir) directories.add(stat.path);
      else files.set(stat.path, { size: stat.size, isDir: false });
    }

    return { files, directories };
  } catch (error) {
    console.error(`[DEBUG] getBoardFilesAndSizes: Failed to get file data:`, error);
    throw error;
  }
}

// Legacy function for backward compatibility
export async function getBoardFileSizes(rootPath: string = "/"): Promise<Map<string, number>> {
  const result = await getBoardFilesAndSizes(rootPath);
  const fileSizes = new Map<string, number>();
  for (const [path, info] of result.files) {
    fileSizes.set(path, info.size);
  }
  return fileSizes;
}

export async function mvOnDevice(src: string, dst: string): Promise<void> {
  const connect = normalizeConnect(getActiveConnect());
  if (!connect || connect === "auto") throw new Error("Select a specific serial port first");

  try {
    const normalizePath = (p: string) => {
      const trimmed = (p || "").replace(/^[:/\\]+/, "").replace(/[\\/]+/g, "/");
      if (!trimmed) throw new Error("Invalid path for mv");
      return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    };
    const srcPath = normalizePath(src);
    const dstPath = normalizePath(dst);

    console.log(`[DEBUG] mvOnDevice: rename requested ${src} -> ${dst} (normalized ${srcPath} -> ${dstPath})`);
    await mpyClient.rename(connect, srcPath, dstPath);
    clearFileTreeCache();
  } catch (error: any) {
    throw new Error(`Move/rename failed: ${error?.message || error}`);
  }
}

// Cleanup function for extension deactivation
export function cleanupConnections(): void {
  connectionManager.stop();
  cancelAll();
}
