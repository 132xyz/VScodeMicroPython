import { ChildProcess, exec, execFile } from 'node:child_process';
import * as util from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// Helper to split a configured command string into executable and args
// Supports quoted paths like "C:\\Program Files\\Python\\python.exe" and
// preserves arguments if provided (e.g. 'py -3').
// If the input looks like a plain file path with spaces (no quotes, no args),
// it will be treated as the executable directly.
function splitCommand(cmd: string): { exe: string; args: string[] } {
  // If cmd doesn't contain quotes and looks like a file path (contains backslash or forward slash)
  // and has spaces, treat the whole thing as the executable
  if (!cmd.includes('"') && (cmd.includes('\\') || cmd.includes('/')) && cmd.includes(' ')) {
    return { exe: cmd, args: [] };
  }
  
  const parts: string[] = [];
  const re = /[^\s\"]+|\"([^\"]*)\"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1] !== undefined) parts.push(m[1]);
    else parts.push(m[0]);
  }
  if (parts.length === 0) return { exe: cmd, args: [] };
  const exe = parts[0];
  const args = parts.slice(1);
  return { exe, args };
}

export type InvocationSource = 'python-module' | 'executable' | 'unknown';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  retryOnFailure?: boolean;
  timeoutMs?: number;
  pythonPath?: string;
  useModulePrefer?: boolean;
}

export interface VersionInfo {
  version: string | null;
  compatible: boolean;
  source: InvocationSource;
}

export interface ReplSession {
  proc: ChildProcess;
  send(data: string): void;
  stop(): Promise<void>;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

class MpRemoteManagerClass {
  private activeChild: ChildProcess | null = null;
  private activeChildKillTimeout?: NodeJS.Timeout;
  // Ensure only one mpremote invocation runs at a time
  private _lock: Promise<void> = Promise.resolve();
  // Currently-owned connection (e.g. COM10) while a connect-based command is running
  private activeConnectionPort: string | null = null;
  // Cache for detected Python path to avoid repeated slow lookups
  private _cachedPythonPath: string | null | undefined = undefined;

  // minimal adapter that delegates to existing implementations where possible
  async detectPythonPath(): Promise<string | null> {
    // Return cached value if available
    if (this._cachedPythonPath !== undefined) {
      return this._cachedPythonPath;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Method 0: Check microPythonWorkBench.pythonPath configuration (highest priority)
    try {
      const mpyConfig = vscode.workspace.getConfiguration('microPythonWorkBench', workspaceFolder?.uri);
      const mpyPythonPath = mpyConfig.get<string>('pythonPath');
      if (mpyPythonPath && mpyPythonPath.trim()) {
        this._cachedPythonPath = mpyPythonPath.trim();
        return this._cachedPythonPath;
      }
    } catch (e) {
      // ignore
    }

    // Method 1: Try VS Code python extension API
    try {
      const pythonExtension = vscode.extensions.getExtension('ms-python.python');
      if (pythonExtension && pythonExtension.isActive) {
        const pythonApi = (pythonExtension as any).exports;
        if (pythonApi && pythonApi.settings && pythonApi.settings.getExecutionDetails) {
          const executionDetails = pythonApi.settings.getExecutionDetails(workspaceFolder?.uri);
          if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
            this._cachedPythonPath = executionDetails.execCommand[0] as string;
            return this._cachedPythonPath;
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // Method 2: Check python extension configuration
    const config = vscode.workspace.getConfiguration('python', workspaceFolder?.uri);
    const configuredPath = config.get<string>('defaultInterpreterPath') || config.get<string>('pythonPath');
    if (configuredPath) {
      this._cachedPythonPath = configuredPath;
      return this._cachedPythonPath;
    }

    const candidates = process.platform === 'win32' ? ['python', 'python3', 'py', 'py -3'] : ['python3', 'python'];
    for (const c of candidates) {
      try {
        // execFile can accept an executable plus args; handle candidate strings robustly
        const parsed = splitCommand(c);
        const exe = parsed.exe;
        const args = parsed.args.concat(['--version']);
        await execFileAsync(exe, args);
        this._cachedPythonPath = c;
        return this._cachedPythonPath;
      } catch { }
    }
    this._cachedPythonPath = null;
    return null;
  }

  /** Clear the cached Python path (call when user changes Python interpreter) */
  clearPythonPathCache(): void {
    this._cachedPythonPath = undefined;
  }

  async isModuleAvailable(pythonPath?: string | null): Promise<boolean> {
    const py = pythonPath ?? await this.detectPythonPath();
    if (!py) return false;
    try {
      const parsed = splitCommand(py);
      const exe = parsed.exe;
      const args = parsed.args.concat(['-m', 'mpremote', '--version']);
      await execFileAsync(exe, args, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async isPythonModuleAvailable(moduleName: string, pythonPath?: string | null): Promise<boolean> {
    const py = pythonPath ?? await this.detectPythonPath();
    if (!py) return false;
    try {
      const parsed = splitCommand(py);
      const exe = parsed.exe;
      const args = parsed.args.concat(['-c', `import ${moduleName}`]);
      await execFileAsync(exe, args, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private getInternalPythonRoot(): string | null {
    try {
      const ext = vscode.extensions.getExtension('WebForks.mpy')
        || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.mpy'))
        || null;
      let candidate: string | null = null;
      if (ext) {
        candidate = path.join(ext.extensionPath, 'src', 'python');
      } else {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (ws) candidate = path.join(ws, 'VScodeMicroPython', 'src', 'python');
      }
      if (candidate) {
        const mainPath = path.join(candidate, 'mpremote', '__main__.py');
        if (fs.existsSync(mainPath)) return candidate;
      }
    } catch {}
    return null;
  }

  async findExecutable(): Promise<string | null> {
    // External mpremote executable is no longer used.
    return null;
  }

  async checkVersion(): Promise<VersionInfo> {
    const pythonPath = await this.detectPythonPath();
    if (!pythonPath) return { version: null, compatible: false, source: 'unknown' };
    try {
      const parsed = splitCommand(pythonPath);
      const exe = parsed.exe;
      const args = parsed.args.concat(['-m', 'mpremote', '--version']);
      const { stdout } = await execFileAsync(exe, args, { timeout: 5000 });
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      const version = match ? match[1] : null;
      const partsNum = version ? version.split('.').map(Number) : [];
      const compatible = partsNum.length >= 2 ? (partsNum[0] > 1 || (partsNum[0] === 1 && partsNum[1] >= 20)) : false;
      return { version, compatible, source: 'python-module' };
    } catch {
      return { version: null, compatible: false, source: 'unknown' };
    }
  }

  /**
   * Run a quick mpremote command that does NOT require device connection.
   * This bypasses the serial lock since these commands don't touch the serial port.
   * Use only for commands like "devs", "--version", etc.
   */
  async runQuick(args: string[], opts: { timeoutMs?: number; pythonPath?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    const pythonPath = opts.pythonPath || await this.detectPythonPath();
    if (!pythonPath) throw new Error('Python interpreter not found');
    const parsed = splitCommand(pythonPath);
    const exe = parsed.exe;
    const preArgs = parsed.args;
    const execArgs = preArgs.concat(['-m', 'mpremote']).concat(args);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const timeout = opts.timeoutMs ?? 5000;
    const { stdout, stderr } = await execFileAsync(exe, execArgs, { env, timeout });
    return { stdout: String(stdout), stderr: String(stderr) };
  }

  async run(args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    // Serialize all mpremote invocations to avoid simultaneous access to serial ports
    let release!: () => void;
    const myLock = new Promise<void>(res => { release = res; });
    const prev = this._lock;
    this._lock = prev.then(() => myLock);
    
    await prev;
    
    try {
      // Prefer python -m when available; use exec to obtain ChildProcess so it can be cancelled
      const pythonPath = opts.pythonPath || await this.detectPythonPath();
      // If this invocation opens a connection, remember the port while running
      const connIndex = args.findIndex(a => a === 'connect');
      if (connIndex >= 0 && args.length > connIndex + 1) {
        this.activeConnectionPort = args[connIndex + 1];
      }
      const escaped = args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '\"')}"` : a).join(' ');
      // Build execFile arguments to handle pythonPath that may contain extra args (e.g. 'py -3')
      const parsedCmd = splitCommand(pythonPath || 'python');
      const exe = parsedCmd.exe;
      const preArgs = parsedCmd.args;
      const execArgs = preArgs.concat(['-m', 'mpremote']).concat(args);
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
      const execOpt: any = { cwd: opts.cwd, env };

      return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        // Track if we've already resolved/rejected to avoid double-calling
        let settled = false;
        
        const settleWithError = (error: Error) => {
          if (settled) return;
          settled = true;
          this.activeChild = null;
          this.activeConnectionPort = null;
          if (this.activeChildKillTimeout) { 
            clearTimeout(this.activeChildKillTimeout); 
            this.activeChildKillTimeout = undefined; 
          }
          try { release(); } catch {}
          reject(error);
        };
        
        const settleWithResult = (result: { stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          this.activeChild = null;
          this.activeConnectionPort = null;
          if (this.activeChildKillTimeout) { 
            clearTimeout(this.activeChildKillTimeout); 
            this.activeChildKillTimeout = undefined; 
          }
          try { release(); } catch {}
          resolve(result);
        };

        try {
          const child = execFile(exe, execArgs, execOpt, (err, stdout, stderr) => {
            if (err) {
              settleWithError(err as Error);
            } else {
              settleWithResult({ stdout: String(stdout), stderr: String(stderr) });
            }
          });

          this.activeChild = child;

          // Optional hard timeout to kill child if requested via opts.timeoutMs
          if (opts.timeoutMs && this.activeChild) {
            this.activeChildKillTimeout = setTimeout(() => {
              console.warn(`[MpRemoteManager] Command timed out after ${opts.timeoutMs}ms, killing process`);
              try { this.activeChild?.kill(); } catch {}
              // Explicitly reject with timeout error - don't rely solely on execFile callback
              settleWithError(new Error(`mpremote command timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs);
          }
        } catch (e) {
          settleWithError(e as Error);
        }
      });
    } catch (outerError) {
      // Ensure lock is released even if detectPythonPath or other setup fails
      try { release(); } catch {}
      throw outerError;
    }
  }

  async spawn(args: string[], opts: RunOptions = {}): Promise<ChildProcess> {
    // Serialize spawn as well
    let release!: () => void;
    const myLock = new Promise<void>(res => { release = res; });
    const prev = this._lock;
    this._lock = prev.then(() => myLock);
    await prev;

    const pythonPath = opts.pythonPath || await this.detectPythonPath();
    const parsed = splitCommand(pythonPath || 'python');
    const exe = parsed.exe;
    const preArgs = parsed.args;
    const spawnArgs = preArgs.concat(['-m', 'mpremote']).concat(args);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
    const child = execFile(exe, spawnArgs, { cwd: opts.cwd, env });
    this.activeChild = child;
    // If this spawn is a connect <port> create, remember the port
    const connIndex = args.findIndex(a => a === 'connect');
    if (connIndex >= 0 && args.length > connIndex + 1) {
      this.activeConnectionPort = args[connIndex + 1];
    }
    // release will be done when child exits; attach listener
    child.on('exit', () => {
      this.activeChild = null;
      this.activeConnectionPort = null;
      try { release(); } catch {}
    });
    child.on('error', () => {
      this.activeChild = null;
      this.activeConnectionPort = null;
      try { release(); } catch {}
    });
    return child;
  }

  async installPackages(packages: string[], _pythonPath?: string, _opts: { silent?: boolean } = {}): Promise<void> {
    const pythonPath = _pythonPath ?? await this.detectPythonPath();
    if (!pythonPath) throw new Error('No python interpreter found');
    if (packages.length === 0) throw new Error('No Python packages specified for installation');
    const parsed = splitCommand(pythonPath);
    const exe = parsed.exe;
    const preArgs = parsed.args;
    // Ensure pip is available
    try {
      await execFileAsync(exe, preArgs.concat(['-m', 'pip', '--version']), { timeout: 10000 });
    } catch (e) {
      throw new Error('pip not available for the selected Python');
    }

    // Run pip install --upgrade <packages...>
    try {
      await execFileAsync(exe, preArgs.concat(['-m', 'pip', 'install', '--upgrade']).concat(packages), { timeout: 120000 });
      return;
    } catch (e: any) {
      const msg = e?.message || String(e);
      throw new Error(`Installation failed: ${msg}`);
    }
  }

  async install(_pythonPath?: string, _opts: { silent?: boolean } = {}): Promise<void> {
    await this.installPackages(['mpremote'], _pythonPath, _opts);
  }

  cancelActive(): void {
    try {
      if (this.activeChild) {
        try { this.activeChild.kill(); } catch (e) { /* ignore */ }
        this.activeChild = null;
      }
      this.activeConnectionPort = null;
      if (this.activeChildKillTimeout) { clearTimeout(this.activeChildKillTimeout); this.activeChildKillTimeout = undefined; }
    } catch (e) {
      console.warn('[MpRemoteManager] cancelActive error', e);
    }
  }

  // Query helpers
  getActiveConnectionPort(): string | null {
    return this.activeConnectionPort;
  }

  isBusy(): boolean {
    return this.activeChild !== null;
  }
}

export const MpRemoteManager = new MpRemoteManagerClass();
