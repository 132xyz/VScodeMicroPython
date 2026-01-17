import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as mp from "./mpremote";
import { MpRemoteManager } from './MpRemoteManager';
import { showInfo, showError, showWarning } from "../core/localization";

let runTerminal: vscode.Terminal | undefined;
let replTerminal: vscode.Terminal | undefined;
let userClosedRepl = false;
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

const logAutoSuspend = (...args: any[]) => debugLog("[MPY auto-suspend]", ...args);

async function buildShellCommand(args: string[]): Promise<string> {
  const pythonPath = await MpRemoteManager.detectPythonPath();
  const joined = args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
  if (!pythonPath) throw new Error('Python interpreter not found');
  return `"${pythonPath}" -m mpremote ${joined}`;
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
    const cmd = await buildShellCommand(["connect", device]);
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
  opts: { resumeReplCommand?: string; replBehavior?: ReplRestoreBehavior } = {}
): Promise<void> {
  // Prefer restoring the run command to avoid port contention with REPL
  if (snapshot.runWasOpen && snapshot.lastRunCommand) {
    logAutoSuspend("Restoring Run terminal with last command");
    await rerunLastRunCommand(snapshot.lastRunCommand);
    return;
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
  // mpremote is bundled internally; always available if Python is present.
  const ok = await MpRemoteManager.isModuleAvailable();
  if (!ok) {
    vscode.window.showErrorMessage('Python 解释器未找到或内置 mpremote 加载失败。请检查 Python 环境。');
    throw new Error('Python interpreter not available');
  }
}

export async function serialSendCtrlC(): Promise<void> {
  // Use robust interrupt method
  try {
    await robustInterrupt();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`serialSendCtrlC: robustInterrupt failed: ${error}`);
  }
}

export async function stop(): Promise<void> {
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

  // If the REPL terminal is open, close it before executing
  if (isReplOpen()) {
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

  // Use mpremote run command (prefer python -m mpremote)
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
  await new Promise(r => setTimeout(r, 250));
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
  runTerminal = vscode.window.createTerminal({
    name: "ESP32 Run File",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    env: termEnv
  });
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

  // Build the mpremote connect command
  const cmd = await buildShellCommand(["connect", device]);

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
  replTerminal = vscode.window.createTerminal({
    name: "ESP32 REPL",
    shellPath: process.platform === 'win32' ? "cmd.exe" : (process.env.SHELL || '/bin/bash'),
    env: termEnv
  });
  // On Windows, set code page to UTF-8 before running the connect command so
  // console input/output handles Unicode correctly. Then send the connect command.
  try {
    if (process.platform === 'win32') {
      replTerminal.sendText('chcp 65001 >nul', true);
    }
    replTerminal.sendText(cmd, true);
  } catch (e) { /* ignore */ }

  // Mark REPL as open in context and clear any prior manual-close flag
  userClosedRepl = false;
  setReplContext(true);

  // Send interrupt (Ctrl-C) to ensure device is responsive
  if (shouldInterrupt) {
    setTimeout(() => {
      if (replTerminal) {
        replTerminal.sendText("\x03", false); // Ctrl-C
        // Small delay then send Ctrl-B for friendly REPL
        setTimeout(() => {
          if (replTerminal) {
            replTerminal.sendText("\x02", false); // Ctrl-B
          }
        }, 100);
      }
    }, 500); // Wait 500ms for terminal to initialize
  }

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
      } else if (interrupt) {
        try { await mp.reset(); } catch {}
      }
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

async function strictConnectHandshake(interrupt: boolean) {
  // Skip handshake entirely if interrupt is disabled, as mpremote's connect
  // command may send interrupt signals to ensure the device is in a known state.
  // Users who disable interruptOnConnect want no interrupts at all.
  if (!interrupt) return;

  // Try reset + quick op, retry once if needed
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await mp.reset();
      // quick check: ls root; if it returns without throwing, we assume we're good
      await mp.ls("/");
      return;
    } catch (e) {
      if (attempt === 2) break;
      // small backoff then retry
      await new Promise(r => setTimeout(r, 200));
    }
  }
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
