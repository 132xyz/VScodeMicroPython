import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as mp from "./mpremote";

let runTerminal: vscode.Terminal | undefined;
let replTerminal: vscode.Terminal | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const logAutoSuspend = (...args: any[]) => console.log("[MPY auto-suspend]", ...args);

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
    const cmd = `mpremote connect ${device}`;
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
  return new Promise<void>((resolve, reject) => {
    exec('mpremote --version', (err: any, stdout: string, stderr: string) => {
      if (err) {
        vscode.window.showWarningMessage('mpremote not found. Please install mpremote: pip install mpremote');
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export async function serialSendCtrlC(): Promise<void> {
  // Use robust interrupt method
  try {
    await robustInterrupt();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`[DEBUG] serialSendCtrlC: robustInterrupt failed: ${error}`);
  }
}

export async function stop(): Promise<void> {
  // Use the robust interrupt and reset function
  try {
    await robustInterruptAndReset();
  } catch (error: any) {
    // The robust function already handles errors and shows messages
    console.error(`[DEBUG] stop: robustInterruptAndReset failed: ${error}`);
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
      vscode.window.showInformationMessage("Board: Soft reset sent via ESP32 REPL");
      return;
    } catch {
      // fall back to mpremote below
    }
  }

  // Use mpremote connect with explicit port
  const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const cmd = `mpremote connect ${device} reset`;
  await new Promise<void>((resolve) => {
    exec(cmd, (error: any, stdout: any, stderr: any) => {
      if (error) {
        vscode.window.showErrorMessage(`Board: Soft reset failed: ${stderr || error.message}`);
      } else {
        vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote connect auto reset`);
      }
      resolve();
    });
  });
}

export async function runActiveFile(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
  await ed.document.save();

  const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
  if (!connect || connect === "auto") {
    vscode.window.showErrorMessage("Select a specific serial port first (not 'auto').");
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

  // Use mpremote run command
  const cmd = `mpremote connect ${device} run "${filePath}"`;
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

  runTerminal = vscode.window.createTerminal({
    name: "ESP32 Run File",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  });
  return runTerminal;
}

export async function getReplTerminal(context?: vscode.ExtensionContext): Promise<vscode.Terminal> {
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

  // Simply execute mpremote connect command in terminal
  const cmd = `mpremote connect ${device}`;
  replTerminal = vscode.window.createTerminal({
    name: "ESP32 REPL",
    shellPath: process.platform === 'win32' ? "cmd.exe" : (process.env.SHELL || '/bin/bash'),
    shellArgs: process.platform === 'win32' ? ["/d", "/c", cmd] : ["-lc", cmd]
  });

  // Send interrupt (Ctrl-C) to ensure device is responsive
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

  return replTerminal;
}

export function isReplOpen(): boolean {
  if (!replTerminal) return false;
  return vscode.window.terminals.some(t => t === replTerminal);
}

export async function closeReplTerminal() {
  if (replTerminal) {
    try {
      replTerminal.dispose();
    } catch {}
    replTerminal = undefined;
    await new Promise(r => setTimeout(r, 300));
  }
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
      const term = await getReplTerminal();
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
  // Try reset + quick op, retry once if needed
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (interrupt) await mp.reset();
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

export function toLocalRelative(devicePath: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return devicePath.replace(/^\//, "");
  if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
  if (devicePath === normRoot) return "";
  // Fallback: strip leading slash
  return devicePath.replace(/^\//, "");
}

export function toDevicePath(localRel: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return "/" + localRel;
  return normRoot + "/" + localRel;
}

export async function robustInterrupt(port?: string): Promise<void> {
  // If REPL terminal holds the port, send interrupt through it to avoid conflicts
  if (isReplOpen()) {
    try {
      const term = await getReplTerminal();
      term.sendText("\x03", false);
      await new Promise(r => setTimeout(r, 60));
      term.sendText("\x03", false);
      vscode.window.showInformationMessage("Board: Interrupt sent via ESP32 REPL");
      return;
    } catch (error) {
      console.log(`[DEBUG] robustInterrupt: REPL interrupt path failed, falling back: ${error}`);
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

  console.log(`[DEBUG] robustInterrupt: Starting for port ${devicePort}`);

  // Check device connection
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      console.warn(`[DEBUG] robustInterrupt: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      console.log(`[DEBUG] robustInterrupt: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    console.warn(`[DEBUG] robustInterrupt: Health check failed: ${error}, proceeding...`);
  }

  // Interrupt with Ctrl+C twice
  try {
    console.log(`[DEBUG] robustInterrupt: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterrupt: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterrupt: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterrupt: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"]);
      console.log(`[DEBUG] robustInterrupt: Interrupt via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterrupt: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to interrupt device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }

  console.log(`[DEBUG] robustInterrupt: Completed for port ${devicePort}`);
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
      console.log(`[DEBUG] robustInterruptAndReset: REPL path failed, falling back: ${error}`);
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

  console.log(`[DEBUG] robustInterruptAndReset: Starting for port ${devicePort}`);

  // Check device connection
  try {
    const health = await mp.healthCheck(devicePort);
    if (!health.healthy) {
      console.warn(`[DEBUG] robustInterruptAndReset: Device at ${devicePort} is not healthy, but proceeding...`);
      vscode.window.showWarningMessage(`Device at ${devicePort} may not be responding properly.`);
    } else {
      console.log(`[DEBUG] robustInterruptAndReset: Device at ${devicePort} is healthy (response time: ${health.responseTime}ms)`);
    }
  } catch (error) {
    console.warn(`[DEBUG] robustInterruptAndReset: Health check failed: ${error}, proceeding...`);
  }

  // Step 1: Interrupt with Ctrl+C twice
  let interruptSuccess = false;
  try {
    console.log(`[DEBUG] robustInterruptAndReset: Attempting interrupt via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x03\\x03' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterruptAndReset: echo interrupt failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterruptAndReset: echo interrupt succeeded`);
          resolve();
        }
      });
    });
    interruptSuccess = true;
    vscode.window.showInformationMessage(`Board: Interrupt sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterruptAndReset: Interrupt via echo failed: ${error}, trying mpremote`);
    vscode.window.showWarningMessage(`Board: Direct serial interrupt failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "exec", "--no-follow", "import sys; sys.stdin.write(b'\\x03\\x03')"]);
      console.log(`[DEBUG] robustInterruptAndReset: Interrupt via mpremote succeeded`);
      interruptSuccess = true;
      vscode.window.showInformationMessage(`Board: Interrupt sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterruptAndReset: Interrupt via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Interrupt failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      // Continue to reset even if interrupt fails
    }
  }

  // Step 2: Soft reset with Ctrl+D
  try {
    console.log(`[DEBUG] robustInterruptAndReset: Attempting soft reset via echo to ${devicePort}`);
    await new Promise<void>((resolve, reject) => {
      exec(`echo -e '\\x04' > ${devicePort}`, (error, stdout, stderr) => {
        if (error) {
          console.log(`[DEBUG] robustInterruptAndReset: echo reset failed: ${stderr || error.message}`);
          reject(error);
        } else {
          console.log(`[DEBUG] robustInterruptAndReset: echo reset succeeded`);
          resolve();
        }
      });
    });
    vscode.window.showInformationMessage(`Board: Soft reset sent via echo to ${devicePort}`);
  } catch (error) {
    console.log(`[DEBUG] robustInterruptAndReset: Soft reset via echo failed: ${error}, trying mpremote reset`);
    vscode.window.showWarningMessage(`Board: Direct serial reset failed, trying mpremote fallback...`);
    try {
      await mp.runMpremote(["connect", devicePort, "reset"]);
      console.log(`[DEBUG] robustInterruptAndReset: Soft reset via mpremote succeeded`);
      vscode.window.showInformationMessage(`Board: Soft reset sent via mpremote to ${devicePort}`);
    } catch (error2) {
      console.error(`[DEBUG] robustInterruptAndReset: Soft reset via mpremote also failed: ${error2}`);
      vscode.window.showErrorMessage(`Board: Soft reset failed for ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
      throw new Error(`Failed to reset device on ${devicePort}: echo error: ${error}, mpremote error: ${error2}`);
    }
  }

  console.log(`[DEBUG] robustInterruptAndReset: Completed for port ${devicePort}`);
}
