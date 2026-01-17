import { ChildProcess, exec, execFile } from 'node:child_process';
import * as util from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

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
  // minimal adapter that delegates to existing implementations where possible
  async detectPythonPath(): Promise<string | null> {
    // Try VS Code python extension / common candidates
    try {
      const pythonExtension = vscode.extensions.getExtension('ms-python.python');
      if (pythonExtension && pythonExtension.isActive) {
        const pythonApi = (pythonExtension as any).exports;
        if (pythonApi && pythonApi.settings && pythonApi.settings.getExecutionDetails) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const executionDetails = pythonApi.settings.getExecutionDetails(workspaceFolder?.uri);
          if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
            return executionDetails.execCommand[0];
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // Check configuration
    const config = vscode.workspace.getConfiguration('python');
    const configuredPath = config.get<string>('defaultInterpreterPath') || config.get<string>('pythonPath');
    if (configuredPath) return configuredPath;

    const candidates = process.platform === 'win32' ? ['python', 'python3', 'py', 'py -3'] : ['python3', 'python'];
    for (const c of candidates) {
      try {
        await execFileAsync(c, ['--version']);
        return c;
      } catch { }
    }
    return null;
  }

  async isModuleAvailable(pythonPath?: string | null): Promise<boolean> {
    const py = pythonPath ?? await this.detectPythonPath();
    const root = this.getInternalPythonRoot();
    if (!py || !root) return false;
    try {
      const env = { ...process.env, PYTHONPATH: root };
      await execFileAsync(py, ['-m', 'mpremote', '--version'], { timeout: 5000, env });
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
    const root = this.getInternalPythonRoot();
    if (!pythonPath || !root) return { version: null, compatible: false, source: 'unknown' };
    try {
      const env = { ...process.env, PYTHONPATH: root };
      const { stdout } = await execFileAsync(pythonPath, ['-m', 'mpremote', '--version'], { timeout: 5000, env });
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      const version = match ? match[1] : null;
      const parts = version ? version.split('.').map(Number) : [];
      const compatible = parts.length >= 2 ? (parts[0] > 1 || (parts[0] === 1 && parts[1] >= 20)) : false;
      return { version, compatible, source: 'python-module' };
    } catch {
      return { version: null, compatible: false, source: 'unknown' };
    }
  }

  async run(args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    // Serialize all mpremote invocations to avoid simultaneous access to serial ports
    let release!: () => void;
    const myLock = new Promise<void>(res => { release = res; });
    const prev = this._lock;
    this._lock = prev.then(() => myLock);
    await prev;
    // Prefer python -m when available; use exec to obtain ChildProcess so it can be cancelled
    const pythonPath = opts.pythonPath || await this.detectPythonPath();
    const internalRoot = this.getInternalPythonRoot();
    // If this invocation opens a connection, remember the port while running
    const connIndex = args.findIndex(a => a === 'connect');
    if (connIndex >= 0 && args.length > connIndex + 1) {
      this.activeConnectionPort = args[connIndex + 1];
    }
    const escaped = args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '\"')}"` : a).join(' ');
    const cmd = `"${pythonPath}" -m mpremote ${escaped}`;
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
    if (internalRoot) {
      const delim = path.delimiter;
      env.PYTHONPATH = env.PYTHONPATH ? `${internalRoot}${delim}${env.PYTHONPATH}` : internalRoot;
    }
    const execOpt: any = { cwd: opts.cwd, env };

    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      try {
        const child = exec(cmd, execOpt, (err, stdout, stderr) => {
          try {
            if (this.activeChild === child) this.activeChild = null;
            if (this.activeChildKillTimeout) { clearTimeout(this.activeChildKillTimeout); this.activeChildKillTimeout = undefined; }
            // clear active connection port when the child exits
            this.activeConnectionPort = null;
          } finally {
            // release lock
            release();
          }
          if (err) return reject(err);
          return resolve({ stdout: String(stdout), stderr: String(stderr) });
        });

        this.activeChild = child;

        

        // Optional hard timeout to kill child if requested via opts.timeoutMs
        if (opts.timeoutMs && this.activeChild) {
          this.activeChildKillTimeout = setTimeout(() => {
            try { this.activeChild?.kill(); } catch {};
            this.activeChild = null;
            this.activeConnectionPort = null;
          }, opts.timeoutMs);
        }
      } catch (e) {
        this.activeChild = null;
        this.activeConnectionPort = null;
        if (this.activeChildKillTimeout) { clearTimeout(this.activeChildKillTimeout); this.activeChildKillTimeout = undefined; }
        try { release(); } catch {}
        return reject(e);
      }
    });
  }

  async spawn(args: string[], opts: RunOptions = {}): Promise<ChildProcess> {
    // Serialize spawn as well
    let release!: () => void;
    const myLock = new Promise<void>(res => { release = res; });
    const prev = this._lock;
    this._lock = prev.then(() => myLock);
    await prev;

    const pythonPath = opts.pythonPath || await this.detectPythonPath();
    const internalRoot = this.getInternalPythonRoot();
    const spawnCmd = [pythonPath, ['-m', 'mpremote', ...args].join(' ')].join(' ');
    // For simplicity, use exec to get a ChildProcess via exec (exec returns ChildProcess)
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
    if (internalRoot) {
      const delim = path.delimiter;
      env.PYTHONPATH = env.PYTHONPATH ? `${internalRoot}${delim}${env.PYTHONPATH}` : internalRoot;
    }
    const child = exec(spawnCmd as string, { cwd: opts.cwd, env });
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

  async install(_pythonPath?: string, _opts: { silent?: boolean } = {}): Promise<void> {
    // Installation is no longer required; mpremote is bundled internally.
    return;
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
