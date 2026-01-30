"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MpRemoteManager = void 0;
const node_child_process_1 = require("node:child_process");
const util = require("node:util");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const execAsync = util.promisify(node_child_process_1.exec);
const execFileAsync = util.promisify(node_child_process_1.execFile);
class MpRemoteManagerClass {
    constructor() {
        this.activeChild = null;
        // Ensure only one mpremote invocation runs at a time
        this._lock = Promise.resolve();
        // Currently-owned connection (e.g. COM10) while a connect-based command is running
        this.activeConnectionPort = null;
    }
    // minimal adapter that delegates to existing implementations where possible
    async detectPythonPath() {
        // Try VS Code python extension / common candidates
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
        }
        catch (e) {
            // ignore
        }
        // Check configuration
        const config = vscode.workspace.getConfiguration('python');
        const configuredPath = config.get('defaultInterpreterPath') || config.get('pythonPath');
        if (configuredPath)
            return configuredPath;
        const candidates = process.platform === 'win32' ? ['python', 'python3', 'py', 'py -3'] : ['python3', 'python'];
        for (const c of candidates) {
            try {
                await execFileAsync(c, ['--version']);
                return c;
            }
            catch { }
        }
        return null;
    }
    async isModuleAvailable(pythonPath) {
        const py = pythonPath ?? await this.detectPythonPath();
        const root = this.getInternalPythonRoot();
        if (!py || !root)
            return false;
        try {
            const env = { ...process.env, PYTHONPATH: root };
            await execFileAsync(py, ['-m', 'mpremote', '--version'], { timeout: 5000, env });
            return true;
        }
        catch {
            return false;
        }
    }
    getInternalPythonRoot() {
        try {
            const ext = vscode.extensions.getExtension('WebForks.mpy')
                || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.mpy'))
                || null;
            let candidate = null;
            if (ext) {
                candidate = path.join(ext.extensionPath, 'src', 'python');
            }
            else {
                const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (ws)
                    candidate = path.join(ws, 'VScodeMicroPython', 'src', 'python');
            }
            if (candidate) {
                const mainPath = path.join(candidate, 'mpremote', '__main__.py');
                if (fs.existsSync(mainPath))
                    return candidate;
            }
        }
        catch { }
        return null;
    }
    async findExecutable() {
        // External mpremote executable is no longer used.
        return null;
    }
    async checkVersion() {
        const pythonPath = await this.detectPythonPath();
        const root = this.getInternalPythonRoot();
        if (!pythonPath || !root)
            return { version: null, compatible: false, source: 'unknown' };
        try {
            const env = { ...process.env, PYTHONPATH: root };
            const { stdout } = await execFileAsync(pythonPath, ['-m', 'mpremote', '--version'], { timeout: 5000, env });
            const match = stdout.match(/(\d+\.\d+\.\d+)/);
            const version = match ? match[1] : null;
            const parts = version ? version.split('.').map(Number) : [];
            const compatible = parts.length >= 2 ? (parts[0] > 1 || (parts[0] === 1 && parts[1] >= 20)) : false;
            return { version, compatible, source: 'python-module' };
        }
        catch {
            return { version: null, compatible: false, source: 'unknown' };
        }
    }
    async run(args, opts = {}) {
        // Serialize all mpremote invocations to avoid simultaneous access to serial ports
        let release;
        const myLock = new Promise(res => { release = res; });
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
        const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
        if (internalRoot) {
            const delim = path.delimiter;
            env.PYTHONPATH = env.PYTHONPATH ? `${internalRoot}${delim}${env.PYTHONPATH}` : internalRoot;
        }
        const execOpt = { cwd: opts.cwd, env };
        return await new Promise((resolve, reject) => {
            try {
                const child = (0, node_child_process_1.exec)(cmd, execOpt, (err, stdout, stderr) => {
                    try {
                        if (this.activeChild === child)
                            this.activeChild = null;
                        if (this.activeChildKillTimeout) {
                            clearTimeout(this.activeChildKillTimeout);
                            this.activeChildKillTimeout = undefined;
                        }
                        // clear active connection port when the child exits
                        this.activeConnectionPort = null;
                    }
                    finally {
                        // release lock
                        release();
                    }
                    if (err)
                        return reject(err);
                    return resolve({ stdout: String(stdout), stderr: String(stderr) });
                });
                this.activeChild = child;
                // Optional hard timeout to kill child if requested via opts.timeoutMs
                if (opts.timeoutMs && this.activeChild) {
                    this.activeChildKillTimeout = setTimeout(() => {
                        try {
                            this.activeChild?.kill();
                        }
                        catch { }
                        ;
                        this.activeChild = null;
                        this.activeConnectionPort = null;
                    }, opts.timeoutMs);
                }
            }
            catch (e) {
                this.activeChild = null;
                this.activeConnectionPort = null;
                if (this.activeChildKillTimeout) {
                    clearTimeout(this.activeChildKillTimeout);
                    this.activeChildKillTimeout = undefined;
                }
                try {
                    release();
                }
                catch { }
                return reject(e);
            }
        });
    }
    async spawn(args, opts = {}) {
        // Serialize spawn as well
        let release;
        const myLock = new Promise(res => { release = res; });
        const prev = this._lock;
        this._lock = prev.then(() => myLock);
        await prev;
        const pythonPath = opts.pythonPath || await this.detectPythonPath();
        const internalRoot = this.getInternalPythonRoot();
        const spawnCmd = [pythonPath, ['-m', 'mpremote', ...args].join(' ')].join(' ');
        // For simplicity, use exec to get a ChildProcess via exec (exec returns ChildProcess)
        const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
        if (internalRoot) {
            const delim = path.delimiter;
            env.PYTHONPATH = env.PYTHONPATH ? `${internalRoot}${delim}${env.PYTHONPATH}` : internalRoot;
        }
        const child = (0, node_child_process_1.exec)(spawnCmd, { cwd: opts.cwd, env });
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
            try {
                release();
            }
            catch { }
        });
        child.on('error', () => {
            this.activeChild = null;
            this.activeConnectionPort = null;
            try {
                release();
            }
            catch { }
        });
        return child;
    }
    async install(_pythonPath, _opts = {}) {
        // Installation is no longer required; mpremote is bundled internally.
        return;
    }
    cancelActive() {
        try {
            if (this.activeChild) {
                try {
                    this.activeChild.kill();
                }
                catch (e) { /* ignore */ }
                this.activeChild = null;
            }
            this.activeConnectionPort = null;
            if (this.activeChildKillTimeout) {
                clearTimeout(this.activeChildKillTimeout);
                this.activeChildKillTimeout = undefined;
            }
        }
        catch (e) {
            console.warn('[MpRemoteManager] cancelActive error', e);
        }
    }
    // Query helpers
    getActiveConnectionPort() {
        return this.activeConnectionPort;
    }
    isBusy() {
        return this.activeChild !== null;
    }
}
exports.MpRemoteManager = new MpRemoteManagerClass();
//# sourceMappingURL=MpRemoteManager.js.map