import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as mp from "./mpremote";
import { runMpremote } from "./mpremote";
import { MpRemoteManager } from './MpRemoteManager';
import { showInfo, showError, showWarning } from "../core/localization";
import { codeCompletionManager } from '../completion/codeCompletion';

let runTerminal: vscode.Terminal | undefined;
let replTerminal: vscode.Terminal | undefined;
let userClosedRepl = false;
let runTerminalInitialized = false;
// Track if REPL was open before Run started, so we can restore it when Run finishes
let replWasOpenBeforeRun = false;
let replUsesCustomClient = false;
let replControlFile: string | undefined;
let replControlSequence = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Debug logging helper. Controlled by the `microPythonWorkBench.debug` setting (default: false).
const debugLog = (...args: any[]) => {
  try {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("microPythonWorkBench.debug", false);
    if (enabled) console.debug(...args);
  } catch {}
};

function getInternalPythonRoot(): string | null {
  try {
    // Only use the packaged extension's internal Python helpers (production).
    // Do NOT fall back to any workspace copy to avoid depending on local sources.
    const ext = vscode.extensions.getExtension('WebForks.mpy')
      || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.mpy'))
      || null;

    if (ext) {
      const candidate = path.join(ext.extensionPath, 'src', 'python');
      const mainPath = path.join(candidate, 'mpremote', '__main__.py');
      if (fs.existsSync(mainPath)) return candidate;
    }
  } catch {}
  return null;
}

function useExperimentalCustomRepl(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(
    "microPythonWorkBench.experimentalCustomRepl",
    false,
  );
}

function getExtensionRoot(): string | null {
  try {
    const ext = vscode.extensions.getExtension('WebForks.mpy')
      || vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.mpy'))
      || null;
    return ext?.extensionPath || null;
  } catch {}
  return null;
}

function getCustomReplScriptPath(): string | null {
  try {
    const extensionRoot = getExtensionRoot();
    if (!extensionRoot) return null;
    const candidate = path.join(extensionRoot, 'scripts', 'mpyrepl', '__main__.py');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {}
  return null;
}

function quoteShellArg(value: string): string {
  return value.includes(' ') ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

function getCustomReplControlFile(device: string): string {
  return path.join(os.tmpdir(), 'vscodemicropython', `mpyrepl-${sanitizeForFileName(device)}.json`);
}

async function buildCustomReplCommand(device: string): Promise<{ command: string; controlFile: string }> {
  const pythonPath = await MpRemoteManager.detectPythonPath();
  if (!pythonPath) throw new Error('Python interpreter not found');

  const scriptPath = getCustomReplScriptPath();
  if (!scriptPath) {
    throw new Error('Experimental mpyrepl script not found in extension package');
  }

  const controlFile = getCustomReplControlFile(device);
  const stubRoot = codeCompletionManager.getActiveStubPath();
  const baudRate = vscode.workspace.getConfiguration('microPythonWorkBench').get<number>('baudRate', 115200);
  const args = [
    quoteShellArg(scriptPath),
    '--port',
    quoteShellArg(device),
    '--baudrate',
    String(baudRate),
    'async-repl',
    '--control-file',
    quoteShellArg(controlFile),
  ];

  if (stubRoot) {
    args.push('--stub-root', quoteShellArg(stubRoot));
  }

  const base = `"${pythonPath}" ${args.join(' ')}`;
  const command = process.platform === 'win32' ? `& ${base}` : base;
  return { command, controlFile };
}

async function sendCustomReplControl(command: 'interrupt' | 'soft-reset' | 'interrupt-reset' | 'exit'): Promise<void> {
  if (!replUsesCustomClient || !replControlFile) {
    throw new Error('Experimental REPL control channel is not active');
  }

  await fs.promises.mkdir(path.dirname(replControlFile), { recursive: true });
  replControlSequence += 1;
  await fs.promises.writeFile(
    replControlFile,
    JSON.stringify({ sequence: replControlSequence, command }),
    'utf8',
  );
}

async function clearCustomReplControlFile(): Promise<void> {
  if (!replControlFile) return;
  try {
    await fs.promises.unlink(replControlFile);
  } catch {}
}

function resetCustomReplState(): void {
  replUsesCustomClient = false;
  replControlFile = undefined;
  replControlSequence = 0;
}

const logAutoSuspend = (...args: any[]) => debugLog("[MPY auto-suspend]", ...args);

async function buildShellCommand(args: string[]): Promise<string> {
  const pythonPath = await MpRemoteManager.detectPythonPath();
  const joined = args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
  if (!pythonPath) throw new Error('Python interpreter not found');
  // On Windows, we use PowerShell which requires the & call operator when
  // the command starts with a quoted path. This is necessary because paths
  // containing spaces must be quoted, and PowerShell interprets quoted strings
  // as string literals rather than commands without the & operator.
  const base = `"${pythonPath}" -m mpremote ${joined}`;
  if (process.platform === 'win32') {
    return `& ${base}`;
  }
  return base;
}

type LastRunCommand = {
  device: string;
  filePath: string;
  cmd: string;
};

let lastRunCommand: LastRunCommand | undefined;

export type AutoSuspendSnapshot = {
  runWasOpen: boolean;
  replWasOpen: boolean;
  lastRunCommand?: LastRunCommand;
};

// Disconnect the ESP32 REPL terminal but leave it open
export async function disconnectReplTerminal() {
  if (replTerminal) {
    try {
      if (replUsesCustomClient) {
        await sendCustomReplControl('exit');
        await new Promise(r => setTimeout(r, 200));
        return;
      }
      // For mpremote, send Ctrl-X to exit cleanly
      replTerminal.sendText("\x18", false); // Ctrl-X
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
}

function setReplContext(open: boolean) {
  try { vscode.commands.executeCommand('setContext', 'microPythonWorkBench.replOpen', open); } catch {}
}

export async function restartReplInExistingTerminal(opts: { show?: boolean } = {}) {
  try {
    const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
    if (!connect || connect === "auto") return;
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");

    // If the previous terminal is gone, recreate it
    if (!replTerminal || !isReplOpen()) {
      logAutoSuspend("REPL terminal missing/closed, creating new instance");
      const term = await getReplTerminal();
      if (opts.show !== false) term.show(true);
      // give it a moment to connect
      await sleep(250);
      return;
    }

    // Reuse the existing terminal: send connect again
    let cmd: string;
    if (useExperimentalCustomRepl()) {
      const custom = await buildCustomReplCommand(device);
      replUsesCustomClient = true;
      replControlFile = custom.controlFile;
      cmd = custom.command;
    } else {
      resetCustomReplState();
      cmd = await buildShellCommand(["connect", device]);
    }
    logAutoSuspend("Reusing REPL terminal; sending reconnect command:", cmd);
    replTerminal.sendText(cmd, true);
    await sleep(200);
    if (opts.show !== false) {
      try { replTerminal.show(true); } catch {}
    }
  } catch {}
}

function rememberLastRunCommand(device: string, filePath: string, cmd: string) {
  lastRunCommand = { device, filePath, cmd };
  logAutoSuspend("Remembering last Run command for resume:", cmd);
}

async function rerunLastRunCommand(info: LastRunCommand): Promise<void> {
  // Ensure REPL is closed to free the port, mirroring runActiveFile behavior
  if (isReplOpen()) {
    await closeReplTerminal();
    await sleep(400);
  }

  const reuseExistingRunTerminal = isRunTerminalOpen();
  const terminal = getRunTerminal();

  if (reuseExistingRunTerminal) {
    try {
      terminal.sendText("\x03", false);
      await sleep(80);
    } catch {}
  }

  terminal.sendText(info.cmd, true);
  terminal.show(true);
}

export async function suspendSerialSessionsForAutoSync(): Promise<AutoSuspendSnapshot> {
  const runWasOpen = isRunTerminalOpen();
  const replWasOpen = isReplOpen();
  logAutoSuspend("Suspend start — runWasOpen:", runWasOpen, "replWasOpen:", replWasOpen);
  const snapshot: AutoSuspendSnapshot = {
    runWasOpen,
    replWasOpen,
    lastRunCommand: runWasOpen ? lastRunCommand : undefined
  };

  if (runWasOpen) await closeRunTerminal();
  if (replWasOpen) {
    await disconnectReplTerminal(); // send Ctrl-X to exit cleanly
    await sleep(120);
    await closeReplTerminal(); // dispose so restore always recreates a fresh REPL terminal
  }
  if (runWasOpen || replWasOpen) await sleep(250);

  logAutoSuspend("Suspend complete; snapshot captured");
  return snapshot;
}

export type ReplRestoreBehavior = "runChanged" | "executeBootMain" | "openReplEmpty" | "none";

export async function restoreSerialSessionsFromSnapshot(
  snapshot: AutoSuspendSnapshot,
  opts: { resumeReplCommand?: string; replBehavior?: ReplRestoreBehavior; restoreRun?: boolean } = {}
): Promise<void> {
  // By default do NOT automatically re-run the last Run command. Restoring
  // the Run execution must be explicitly requested via `opts.restoreRun`.
  if (snapshot.runWasOpen && snapshot.lastRunCommand) {
    if (opts.restoreRun) {
      logAutoSuspend("Restoring Run terminal with last command");
      await rerunLastRunCommand(snapshot.lastRunCommand);
      return;
    } else {
      logAutoSuspend("Skipping automatic re-run of last Run command (restoreRun not set)");
    }
  }
  if (snapshot.replWasOpen) {
    logAutoSuspend("Restoring REPL terminal");
    // If user manually closed REPL, do not reopen automatically
    if (userClosedRepl) {
      logAutoSuspend("User manually closed REPL; skipping reopen");
      return;
    }
    if (opts.replBehavior === "none") {
      logAutoSuspend("REPL restore behavior is 'none'; not reopening REPL");
      return;
    }
    await restartReplInExistingTerminal();
    if (opts.replBehavior === "executeBootMain" && replTerminal) {
      await sleep(400);
      try {
        logAutoSuspend("Sending soft reset (Ctrl-D) to REPL");
        replTerminal.sendText("\x04", false);
      } catch {}
      await sleep(250);
    }
    if (opts.replBehavior === "runChanged" && opts.resumeReplCommand && replTerminal) {
      // Give mpremote a bit more time to settle before sending the command
      await sleep(600);
      try {
        logAutoSuspend("Sending resume command to REPL:", opts.resumeReplCommand);
        replTerminal.sendText(opts.resumeReplCommand, true);
        // a slight follow-up delay helps ensure the command lands
        await sleep(150);
        replTerminal.show(true);
      } catch {}
    }
    if (opts.replBehavior === "openReplEmpty" && replTerminal) {
      try { replTerminal.show(true); } catch {}
    }
  }
}

export async function checkMpremoteAvailability(): Promise<void> {
  // Prefer system-installed mpremote. If missing, instruct the user to install it.
  const ok = await MpRemoteManager.isModuleAvailable();
  if (!ok) {
    vscode.window.showErrorMessage('Python 解释器未找到或 mpremote 未安装。请检查 Python 环境并安装 mpremote。');
    throw new Error('Python interpreter or mpremote not available');
  }
}

export async function serialSendCtrlC(): Promise<void> {
  if (isReplOpen() && replUsesCustomClient) {
    await sendCustomReplControl('interrupt');
    showInfo("messages.interruptSentViaRepl");
    return;
  }
  // Use robust interrupt method
  try {
    await robustInterrupt();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`serialSendCtrlC: robustInterrupt failed: ${error}`);
  }
}

export async function stop(): Promise<void> {
  if (isReplOpen() && replUsesCustomClient) {
    await sendCustomReplControl('interrupt-reset');
    showInfo("messages.interruptAndSoftResetSentViaRepl");
    return;
  }
  // Use the robust interrupt and reset function
  try {
    await robustInterruptAndReset();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`stop: robustInterruptAndReset failed: ${error}`);
  }
}

export async function softReset(): Promise<void> {
  // If REPL terminal is open, prefer sending through it to avoid port conflicts
  if (isReplOpen()) {
    try {
      if (replUsesCustomClient) {
        await sendCustomReplControl('soft-reset');
        showInfo("messages.softResetSentViaRepl");
        return;
      }
      const term = await getReplTerminal();
      term.sendText("\x03", false); // Ctrl-C
      await new Promise(r => setTimeout(r, 60));
      term.sendText("\x02", false); // Ctrl-B (friendly REPL)
      await new Promise(r => setTimeout(r, 80));
      term.sendText("\x04", false); // Ctrl-D (soft reset)
      showInfo("messages.softResetSentViaRepl");
      return;
    } catch {
      // fall back to mpremote below
    }
  }

  // Use mpremote connect with explicit port
  const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const cmd = await buildShellCommand(["connect", device, "reset"]);
  await new Promise<void>((resolve) => {
    exec(cmd, (error: any, stdout: any, stderr: any) => {
      if (error) {
        showError("messages.softResetFailed", stderr || error.message);
      } else {
        showInfo("messages.softResetSentViaMpremoteConnect");
      }
      resolve();
    });
  });
}

export async function runActiveFile(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { showError("messages.noActiveEditor"); return; }
  await ed.document.save();

  const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
  if (!connect || connect === "auto") {
    showError("messages.selectSpecificPort");
    return;
  }

  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const filePath = ed.document.uri.fsPath;

  // If the REPL terminal is open, close it before executing and remember to restore later
  replWasOpenBeforeRun = isReplOpen();
  if (replWasOpenBeforeRun) {
    await closeReplTerminal();
    // Wait for the system to release the port
    await new Promise(r => setTimeout(r, 400));
  }

  const reuseExistingRunTerminal = !!(runTerminal && vscode.window.terminals.some(t => t === runTerminal));
  const terminal = getRunTerminal();

  if (reuseExistingRunTerminal) {
    try {
      terminal.sendText("\x03", false);
      await new Promise(r => setTimeout(r, 80));
    } catch {}
  }

  // Windows: ensure UTF-8 output encoding on first use of the terminal.
  // PowerShell requires setting [Console]::OutputEncoding, cmd.exe uses chcp.
  if ((process as any).platform === 'win32' && !runTerminalInitialized) {
    try {
      // For PowerShell, set console encoding to UTF-8
      terminal.sendText('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', true);
      await sleep(100);
    } catch {}
    runTerminalInitialized = true;
  }

  const cmd = await buildShellCommand(["connect", device, "run", filePath]);
  rememberLastRunCommand(device, filePath, cmd);
  terminal.sendText(cmd, true);
  terminal.show(true);
}

export function isRunTerminalOpen(): boolean {
  if (!runTerminal) return false;
  const alive = vscode.window.terminals.some(t => t === runTerminal);
  if (!alive) {
    runTerminal = undefined;
    return false;
  }
  return true;
}

export async function closeRunTerminal() {
  if (!runTerminal) return;
  try {
    runTerminal.sendText("\x03", false);
    await new Promise(r => setTimeout(r, 120));
    runTerminal.dispose();
  } catch {}
  runTerminal = undefined;
  runTerminalInitialized = false;
  await new Promise(r => setTimeout(r, 250));
  
  // If REPL was open before Run started, restore it now
  if (replWasOpenBeforeRun) {
    replWasOpenBeforeRun = false;
    try {
      await restartReplInExistingTerminal({ show: true });
    } catch (e) {
      debugLog("Failed to restore REPL after Run closed:", e);
    }
  }
}

function getRunTerminal(): vscode.Terminal {
  if (runTerminal) {
    const alive = vscode.window.terminals.some(t => t === runTerminal);
    if (alive) return runTerminal;
    runTerminal = undefined;
  }

  const internalRoot = getInternalPythonRoot();
  const termEnv: { [key: string]: string } = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
  if (internalRoot) {
    const delim = path.delimiter;
    termEnv.PYTHONPATH = process.env.PYTHONPATH ? `${internalRoot}${delim}${process.env.PYTHONPATH}` : internalRoot;
  }
  // On Windows, use PowerShell instead of cmd.exe for better UTF-8 support.
  // PowerShell handles Unicode output more reliably than cmd.exe.
  runTerminal = vscode.window.createTerminal({
    name: "ESP32 Run File",
    shellPath: process.platform === 'win32' ? "powershell.exe" : (process.env.SHELL || '/bin/bash'),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    env: termEnv
  });
  // mark initialized false so caller can perform one-time terminal setup (eg. chcp)
  runTerminalInitialized = false;
  return runTerminal;
}

export async function getReplTerminal(
  context?: vscode.ExtensionContext,
  opts?: { interrupt?: boolean }
): Promise<vscode.Terminal> {
  if (replTerminal) {
    const alive = vscode.window.terminals.some(t => t === replTerminal);
    if (alive) return replTerminal;
    replTerminal = undefined;
  }

  const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
  if (!connect || connect === "auto") {
    throw new Error("Select a specific serial port first (not 'auto')");
  }

  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const shouldInterrupt = opts?.interrupt ?? vscode.workspace.getConfiguration().get<boolean>(
    "microPythonWorkBench.interruptOnConnect",
    true
  );
  const useCustomClient = useExperimentalCustomRepl();

  // Build the mpremote connect command
  let cmd: string;
  if (useCustomClient) {
    const custom = await buildCustomReplCommand(device);
    replUsesCustomClient = true;
    replControlFile = custom.controlFile;
    cmd = custom.command;
  } else {
    resetCustomReplState();
    cmd = await buildShellCommand(["connect", device]);
  }

  // Create a persistent terminal and send the connect command to it. Using
  // shellArgs to run the command at shell startup causes the underlying
  // shell process to exit when the command finishes, producing exit codes
  // (like the observed exit code 1). Sending the command via `sendText`
  // keeps the terminal alive for interactive REPL sessions.
  // Create terminal with UTF-8 environment to improve Unicode handling on Windows
  const internalRoot = getInternalPythonRoot();
  const termEnv: { [key: string]: string } = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
  if (internalRoot) {
    const delim = require('node:path').delimiter;
    termEnv.PYTHONPATH = process.env.PYTHONPATH ? `${internalRoot}${delim}${process.env.PYTHONPATH}` : internalRoot;
  }
  // On Windows, use PowerShell instead of cmd.exe for better UTF-8 support.
  replTerminal = vscode.window.createTerminal({
    name: "ESP32 REPL",
    shellPath: process.platform === 'win32' ? "powershell.exe" : (process.env.SHELL || '/bin/bash'),
    env: termEnv
  });
  // On Windows PowerShell, set console encoding to UTF-8 before running the connect command
  // so that Unicode output is handled correctly.
  try {
    if (process.platform === 'win32') {
      replTerminal.sendText('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', true);
    }
    replTerminal.sendText(cmd, true);
  } catch (e) { /* ignore */ }

  // Mark REPL as open in context and clear any prior manual-close flag
  userClosedRepl = false;
  setReplContext(true);

  // Note: We do NOT automatically send Ctrl-C/Ctrl-B here.
  // The mpremote connect command enters the REPL directly.
  // If the device has code running, the user can manually press Ctrl-C.
  // Sending control characters automatically was problematic because:
  // 1. They could arrive before mpremote started, going to PowerShell instead
  // 2. The Python extension's auto-activation of venv could interfere
  // 3. Fixed delays are unreliable and slow down the connection process

  return replTerminal;
}

export function isReplOpen(): boolean {
  if (!replTerminal) return false;
  const open = vscode.window.terminals.some(t => t === replTerminal);
  setReplContext(open);
  return open;
}

export async function closeReplTerminal(userInitiated: boolean = false) {
  if (replTerminal) {
    try {
      replTerminal.dispose();
    } catch {}
    replTerminal = undefined;
    await new Promise(r => setTimeout(r, 300));
  }
  await clearCustomReplControlFile();
  resetCustomReplState();
  userClosedRepl = userInitiated || userClosedRepl;
  setReplContext(false);
}

export async function openReplTerminal() {
  // Strict handshake like Thonny: ensure device is interrupted and responsive before opening REPL
  const cfg = vscode.workspace.getConfiguration();
  const interrupt = cfg.get<boolean>("microPythonWorkBench.interruptOnConnect", true);
  const strict = cfg.get<boolean>("microPythonWorkBench.strictConnect", true);
  let lastError: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (strict) {
        await strictConnectHandshake(interrupt);
      }
      // Removed mp.reset() call that was previously here - it caused device soft reset
      // and cleared all user-defined variables. The Ctrl-C/Ctrl-B sent by getReplTerminal
      // is sufficient to interrupt any running code without resetting state.
      const term = await getReplTerminal(undefined, { interrupt });
      term.show(true);
      // tiny delay to ensure terminal connects before next action
      await new Promise(r => setTimeout(r, 150));
      return;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err).toLowerCase();
      if (
        msg.includes("device not configured") ||
        msg.includes("serialexception") ||
        msg.includes("serial port not found") ||
        msg.includes("read failed")
      ) {
        // Wait and retry once
        if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
        else throw err;
      } else {
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
}

async function strictConnectHandshake(_interrupt: boolean) {
  // Previously this function called mp.reset() which performs a soft reset and
  // clears all user-defined variables on the device. This was undesirable because
  // users expect REPL sessions to preserve their work.
  // 
  // The strictConnectHandshake is now a no-op. The terminal-based mpremote connect
  // command handles the connection directly, and the optional Ctrl-C/Ctrl-B sent
  // via getReplTerminal is sufficient to ensure the device is in a responsive state.
  //
  // If connection issues occur, the retry logic in openReplTerminal() handles them.
  return;
}

export function toLocalRelative(devicePath: string, rootPath: string): string | null {
  // Delegate to central mapping in mpremote.ts which implements workspace-scoped device root
  // and may return null when devicePath maps outside the configured sync root.
  try {
    return (mp as any).toLocalRelative(devicePath, rootPath);
  } catch (e) {
    console.warn('[mpremoteCommands] toLocalRelative delegation failed', e);
    return null;
  }
}

export function toDevicePath(localRel: string, rootPath: string): string {
  try {
    return (mp as any).toDevicePath(localRel, rootPath);
  } catch (e) {
    console.warn('[mpremoteCommands] toDevicePath delegation failed', e);
    // Fallback: conservative mapping
    const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
    if (normRoot === "/") return "/" + (localRel || "");
    return normRoot + "/" + (localRel || "");
  }
}

export async function robustInterrupt(port?: string): Promise<void> {
  // If REPL terminal holds the port, send interrupt through it to avoid conflicts
  if (isReplOpen()) {
    try {
      const term = await getReplTerminal();
      term.sendText("\x03", false);
      await new Promise(r => setTimeout(r, 60));
      term.sendText("\x03", false);
        showInfo("messages.interruptSentViaRepl");
      return;
    } catch (error) {
      debugLog(`robustInterrupt: REPL interrupt path failed, falling back: ${error}`);
    }
  }

  // Get port from parameter or config
  let devicePort: string;
  if (port) {
    devicePort = port;
  } else {
    const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  }

  debugLog(`robustInterrupt: Starting for port ${devicePort}`);

  // Check device connection
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      console.warn(`robustInterrupt: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      debugLog(`robustInterrupt: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    console.warn(`robustInterrupt: Health check failed: ${error}, proceeding...`);
  }

  // Interrupt with Ctrl+C twice
  try {
    debugLog(`robustInterrupt: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          debugLog(`robustInterrupt: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
          debugLog(`robustInterrupt: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
    debugLog(`robustInterrupt: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
      try {
      await MpRemoteManager.run(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"], { retryOnFailure: true });
      debugLog(`robustInterrupt: Interrupt via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`robustInterrupt: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to interrupt device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }
  debugLog(`robustInterrupt: Completed for port ${devicePort}`);
}

export async function robustInterruptAndReset(port?: string): Promise<void> {
  // If REPL terminal holds the port, send commands through it to avoid conflicts
  if (isReplOpen()) {
    try {
      const term = await getReplTerminal();
      term.sendText("\x03", false);
      await new Promise(r => setTimeout(r, 60));
      term.sendText("\x03", false);
      await new Promise(r => setTimeout(r, 80));
      term.sendText("\x04", false);
      vscode.window.showInformationMessage("Board: Interrupt and soft reset sent via ESP32 REPL");
      return;
    } catch (error) {
      debugLog(`robustInterruptAndReset: REPL path failed, falling back: ${error}`);
    }
  }

  // Get port from parameter or config
  let devicePort: string;
  if (port) {
    devicePort = port;
  } else {
    const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  }

  debugLog(`robustInterruptAndReset: Starting for port ${devicePort}`);

  // Check device connection
  try {
      const health = await mp.healthCheck(devicePort);
      if (!health.healthy) {
        console.warn(`robustInterruptAndReset: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
        debugLog(`robustInterruptAndReset: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
      console.warn(`robustInterruptAndReset: Health check failed: ${error}, proceeding...`);
  }

  // Step 1: Interrupt with Ctrl+C twice
  let interruptSuccess = false;
  try {
      debugLog(`robustInterruptAndReset: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
            debugLog(`robustInterruptAndReset: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
            debugLog(`robustInterruptAndReset: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    interruptSuccess = true;
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
      debugLog(`robustInterruptAndReset: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
    try {
      await MpRemoteManager.run(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"], { retryOnFailure: true });
        debugLog(`robustInterruptAndReset: Interrupt via mpremote succeeded`);
      interruptSuccess = true;
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
        console.error(`robustInterruptAndReset: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      // Continue to reset even if interrupt fails
    }
  }

  // Step 2: Soft reset with Ctrl+D
  try {
      debugLog(`robustInterruptAndReset: Attempting soft reset via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x04' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
            debugLog(`robustInterruptAndReset: echo reset failed: ${stderr || error.message}`);
          reject(error);
        } else {
            debugLog(`robustInterruptAndReset: echo reset succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Soft reset sent via echo to ${devicePort}`);
  } catch (error) {
      debugLog(`robustInterruptAndReset: Soft reset via echo failed: ${error}, trying mpremote reset`);
    vscode.window.showWarningMessage(`Board: Direct serial reset failed, trying mpremote fallback...`);
    try {
      await MpRemoteManager.run(["connect", devicePort, "reset"], { retryOnFailure: true });
        debugLog(`robustInterruptAndReset: Soft reset via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote to ${devicePort}`);
    } catch (error2) {
        console.error(`robustInterruptAndReset: Soft reset via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Soft reset failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to reset device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }

    debugLog(`robustInterruptAndReset: Completed for port ${devicePort}`);
}
/**
 * Handle terminal close events. When the Run terminal is closed (by user or programmatically),
 * restore REPL if it was open before Run started.
 */
export function handleTerminalClose(closedTerminal: vscode.Terminal): void {
  // Check if the closed terminal is our Run terminal
  if (runTerminal && closedTerminal === runTerminal) {
    runTerminal = undefined;
    runTerminalInitialized = false;
    
    // If REPL was open before Run started, restore it
    if (replWasOpenBeforeRun) {
      replWasOpenBeforeRun = false;
      // Use setTimeout to avoid blocking the close handler
      setTimeout(async () => {
        try {
          await restartReplInExistingTerminal({ show: true });
        } catch (e) {
          debugLog("Failed to restore REPL after Run terminal closed:", e);
        }
      }, 300);
    }
  }
  
  // Check if the closed terminal is our REPL terminal
  if (replTerminal && closedTerminal === replTerminal) {
    replTerminal = undefined;
    clearCustomReplControlFile().catch(() => undefined);
    resetCustomReplState();
    userClosedRepl = true; // Mark as user-closed since they closed the terminal
    setReplContext(false);
  }
}