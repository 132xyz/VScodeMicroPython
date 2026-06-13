import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as mp from "./mpremote";
import * as mpyClient from "./mpyClient";
import { MpRemoteManager } from './MpRemoteManager';
import { showInfo, showError } from "../core/localization";
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
  const configured = vscode.workspace.getConfiguration().get<boolean>(
    "microPythonWorkBench.experimentalCustomRepl",
    true,
  );
  if (configured === false) {
    debugLog("microPythonWorkBench.experimentalCustomRepl=false is ignored; built-in mpyrepl transport is required.");
  }
  return true;
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

async function ensurePythonPackageForCustomRepl(
  pythonPath: string,
  moduleName: string,
  packageName: string,
): Promise<void> {
  const available = await MpRemoteManager.isPythonModuleAvailable(moduleName, pythonPath);
  if (available) return;

  const lang = vscode.env.language || '';
  const zh = lang.startsWith('zh');
  const installLabel = zh ? '安装到此 Python' : 'Install to this Python';
  const showPathLabel = zh ? '显示 Python 路径' : 'Show Python Path';
  const laterLabel = zh ? '稍后' : 'Later';
  const message = zh
    ? `实验性自定义 REPL 需要 ${packageName}（import ${moduleName}），但当前所选 Python 环境中未检测到。是否安装到该环境？`
    : `The experimental custom REPL requires ${packageName} (import ${moduleName}), but it is not available in the selected Python environment. Install it into this environment?`;

  const choice = await vscode.window.showInformationMessage(
    message,
    installLabel,
    showPathLabel,
    laterLabel,
  );

  if (choice === showPathLabel) {
    await vscode.window.showInformationMessage(
      zh ? `Python 路径：${pythonPath}` : `Python path: ${pythonPath}`,
    );
  }

  if (choice !== installLabel) {
    throw new Error(
      zh
        ? `未检测到 ${packageName}，无法启动实验性自定义 REPL。`
        : `${packageName} is required to start the experimental custom REPL.`,
    );
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: zh ? `正在安装 ${packageName}...` : `Installing ${packageName}...`,
    },
    async () => {
      await MpRemoteManager.installPackages([packageName], pythonPath);
    },
  );

  const installed = await MpRemoteManager.isPythonModuleAvailable(moduleName, pythonPath);
  if (!installed) {
    throw new Error(
      zh
        ? `安装完成但仍未检测到 ${packageName}。请手动运行：${pythonPath} -m pip install --upgrade ${packageName}`
        : `Installation finished but ${packageName} is still unavailable. Please run: ${pythonPath} -m pip install --upgrade ${packageName}`,
    );
  }

  await vscode.window.showInformationMessage(
    zh ? `${packageName} 已成功安装。` : `${packageName} installed successfully.`,
  );
}

async function ensureCustomReplDependencies(pythonPath: string): Promise<void> {
  await ensurePythonPackageForCustomRepl(pythonPath, 'serial', 'pyserial');
}

async function buildCustomReplCommand(device: string): Promise<{ command: string; controlFile: string }> {
  const pythonPath = await MpRemoteManager.detectPythonPath();
  if (!pythonPath) throw new Error('Python interpreter not found');
  await ensureCustomReplDependencies(pythonPath);

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
  const command = process.platform === 'win32' ? `& ${base}; exit` : `${base}; exit`;
  return { command, controlFile };
}

type CustomReplControlCommand = 'interrupt' | 'soft-reset' | 'interrupt-reset' | 'exit' | 'exec';

type CustomReplControlPayload = {
  source?: string;
  label?: string;
};

async function readCustomReplControlSequence(controlFile: string): Promise<number> {
  try {
    const rawPayload = await fs.promises.readFile(controlFile, 'utf8');
    const payload = JSON.parse(rawPayload);
    const sequence = payload?.sequence;
    return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : -1;
  } catch {
    return -1;
  }
}

function getActiveCustomReplControlFile(): string | undefined {
  const connect = mp.getActiveConnect();
  if (!connect || connect === "auto") return undefined;
  return getCustomReplControlFile(mp.normalizeConnect(connect));
}

async function activateExistingCustomReplControl(): Promise<boolean> {
  if (replUsesCustomClient && replControlFile) return true;
  if (!useExperimentalCustomRepl()) return false;

  const controlFile = getActiveCustomReplControlFile();
  if (!controlFile || !fs.existsSync(controlFile)) return false;

  replUsesCustomClient = true;
  replControlFile = controlFile;
  replControlSequence = Math.max(replControlSequence, await readCustomReplControlSequence(controlFile));
  return true;
}

async function sendCustomReplControl(
  command: CustomReplControlCommand,
  payload: CustomReplControlPayload = {},
): Promise<void> {
  if (!replUsesCustomClient || !replControlFile) {
    throw new Error('Experimental REPL control channel is not active');
  }

  await fs.promises.mkdir(path.dirname(replControlFile), { recursive: true });
  replControlSequence = Math.max(replControlSequence, await readCustomReplControlSequence(replControlFile));
  replControlSequence += 1;
  await fs.promises.writeFile(
    replControlFile,
    JSON.stringify({ sequence: replControlSequence, command, ...payload }),
    'utf8',
  );
}

async function sendCustomReplControlIfActive(
  command: CustomReplControlCommand,
  payload: CustomReplControlPayload = {},
): Promise<boolean> {
  if (!(await activateExistingCustomReplControl())) return false;
  await sendCustomReplControl(command, payload);
  return true;
}

async function waitForCustomReplReady(controlFile: string, timeoutMs: number = 6000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const rawPayload = await fs.promises.readFile(controlFile, 'utf8');
      const payload = JSON.parse(rawPayload);
      if (payload && typeof payload === 'object' && payload.command === 'ready') {
        return;
      }
    } catch {}
    await sleep(100);
  }

  throw new Error('Experimental REPL did not become ready before running the file');
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

async function runActiveFileInCustomRepl(device: string, filePath: string): Promise<void> {
  const replOpen = isReplOpen();
  const hadCustomRepl = replOpen && replUsesCustomClient && !!replControlFile;

  if (replOpen && !hadCustomRepl) {
    await closeReplTerminal();
    await sleep(300);
  }

  const source = await fs.promises.readFile(filePath, 'utf8');
  const terminal = await getReplTerminal(undefined, { interrupt: false });
  terminal.show(true);

  if (!hadCustomRepl) {
    if (!replControlFile) {
      throw new Error('Experimental REPL control channel is not active');
    }
    await waitForCustomReplReady(replControlFile);
  }

  await sendCustomReplControl('exec', {
    source,
    label: path.basename(filePath),
  });
  debugLog("Sent active file to custom REPL:", device, filePath);
}

const logAutoSuspend = (...args: any[]) => debugLog("[MPY auto-suspend]", ...args);

async function buildShellCommand(args: string[]): Promise<string> {
  throw new Error(`Legacy mpremote terminal command is disabled; requested args: ${args.join(" ")}`);
}

async function buildLegacyShellCommand(args: string[]): Promise<string> {
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
    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") return;
    const device = mp.normalizeConnect(connect);

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
      cmd = await buildLegacyShellCommand(["connect", device]);
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
  const pythonPath = await MpRemoteManager.detectPythonPath();
  if (!pythonPath) {
    vscode.window.showErrorMessage('Python 解释器未找到。请检查 Python 环境。');
    throw new Error('Python interpreter not available');
  }
  await ensureCustomReplDependencies(pythonPath);
}

export async function serialSendCtrlC(): Promise<void> {
  if (await sendCustomReplControlIfActive('interrupt')) {
    showInfo("messages.interruptSentViaRepl");
    return;
  }
  try {
    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") {
      showError("messages.selectSpecificPort");
      return;
    }
    await mpyClient.interrupt(mp.normalizeConnect(connect));
    showInfo("messages.interruptSentViaRepl");
  } catch (error: any) {
    showError("messages.interruptFailed", error?.message || String(error));
  }
}

export async function stop(): Promise<void> {
  if (await sendCustomReplControlIfActive('interrupt-reset')) {
    showInfo("messages.interruptAndSoftResetSentViaRepl");
    return;
  }
  try {
    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") {
      showError("messages.selectSpecificPort");
      return;
    }
    const device = mp.normalizeConnect(connect);
    await mpyClient.interrupt(device);
    await sleep(100);
    await mpyClient.softReset(device);
    showInfo("messages.interruptAndSoftResetSentViaRepl");
  } catch (error: any) {
    showError("messages.interruptAndResetFailed", error?.message || String(error));
  }
}

export async function softReset(): Promise<void> {
  if (await sendCustomReplControlIfActive('soft-reset')) {
    showInfo("messages.softResetSentViaRepl");
    return;
  }

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
      // fall back to the helper process below
    }
  }

  const connect = mp.getActiveConnect();
  const device = mp.normalizeConnect(connect);
  try {
    await mpyClient.softReset(device);
    showInfo("messages.softResetSentViaRepl");
  } catch (error: any) {
    showError("messages.softResetFailed", error?.message || String(error));
  }
}

export async function runActiveFile(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { showError("messages.noActiveEditor"); return; }
  await ed.document.save();

  const connect = mp.getActiveConnect();
  if (!connect || connect === "auto") {
    showError("messages.selectSpecificPort");
    return;
  }

  const device = mp.normalizeConnect(connect);
  const filePath = ed.document.uri.fsPath;

  if (useExperimentalCustomRepl()) {
    await runActiveFileInCustomRepl(device, filePath);
    return;
  }

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

  const cmd = await buildLegacyShellCommand(["connect", device, "run", filePath]);
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

  const connect = mp.getActiveConnect();
  if (!connect || connect === "auto") {
    throw new Error("Select a specific serial port first (not 'auto')");
  }

  const device = mp.normalizeConnect(connect);
  const shouldInterrupt = opts?.interrupt ?? vscode.workspace.getConfiguration().get<boolean>(
    "microPythonWorkBench.interruptOnConnect",
    true
  );
  const useCustomClient = useExperimentalCustomRepl();

  // Build the serial REPL connect command
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
    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = mp.normalizeConnect(connect);
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

  try {
    await mpyClient.interrupt(devicePort);
    showInfo("messages.interruptSentViaRepl");
  } catch (error: any) {
    showError("messages.interruptFailed", error?.message || String(error));
    throw error;
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
    const connect = mp.getActiveConnect();
    if (!connect || connect === "auto") {
      throw new Error("Select a specific serial port first (not 'auto').");
    }
    devicePort = mp.normalizeConnect(connect);
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

  try {
    await mpyClient.interrupt(devicePort);
    await sleep(100);
    await mpyClient.softReset(devicePort);
    showInfo("messages.interruptAndSoftResetSentViaRepl");
  } catch (error: any) {
    showError("messages.interruptAndResetFailed", error?.message || String(error));
    throw error;
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
