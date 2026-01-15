import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as https from "node:https";
import * as fsSync from "node:fs";
import { execFile } from "node:child_process";
import * as mp from "../board/mpremote";
import { PythonInterpreterManager } from "../python/pythonInterpreter";

// Helper function to get workspace folder
function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("No workspace folder open");
  return ws;
}

// Helper function for auto-suspend wrapper
function withAutoSuspend<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

// Board commands implementation
export const boardCommands = {
  pickPort: async () => {
    // Always get the most recent port list before showing the selector
    const devices = await mp.listSerialPorts();
    const items: vscode.QuickPickItem[] = [
      { label: "auto", description: "Auto-detect device" },
      ...devices.map(d => ({ label: d.port, description: d.name || "serial port" }))
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select Board serial port" });
    if (!picked) return;
    const value = picked.label === "auto" ? "auto" : picked.label;
    await vscode.workspace.getConfiguration().update("microPythonWorkBench.connect", value, vscode.ConfigurationTarget.Global);
    // updatePortContext(); // Assuming this function exists
    // tree.requireManualRefresh();
    // await refreshFilesViewTitle();
    vscode.window.showInformationMessage(`Board connect set to ${value}`);
    // tree.clearCache();
    // tree.refreshTree();
    // (no prompt) just refresh the tree after selecting port
  },

  setPort: async (port: string) => {
    await vscode.workspace.getConfiguration().update("microPythonWorkBench.connect", port, vscode.ConfigurationTarget.Global);
    // updatePortContext();
    // tree.requireManualRefresh();
    // await refreshFilesViewTitle();
    vscode.window.showInformationMessage(`ESP32 connect set to ${port}`);
    // tree.clearCache();
    // tree.refreshTree();
    // (no prompt) just refresh the tree after setting port
  },

  flashMicroPython: async () => {
    try {
      const connect = vscode.workspace.getConfiguration().get<string>("microPythonWorkBench.connect", "auto");
      if (!connect || connect === "auto") {
        vscode.window.showErrorMessage("Select a specific serial port first (not 'auto').");
        return;
      }

      // Detect board info to identify the firmware
      const info = await mp.detectBoardInfo();
      const machine = info?.machine || info?.sysname || "";
      const catalog = await loadFirmwareCatalog(vscode.extensions.getExtension("WebForks.MicroPython-WorkBench")?.extensionPath || "");
      let entry = findFirmwareForMachine(machine, catalog);

      if (!entry) {
        const pickItems = catalog.map(c => ({ label: c.id, description: c.chip, detail: c.url }));
        const picked = await vscode.window.showQuickPick(pickItems, { placeHolder: `Board not recognized (${machine || "unknown"}). Pick a firmware entry to flash.` });
        if (!picked) return;
        entry = catalog.find(c => c.id === picked.label);
      }

      if (!entry) {
        vscode.window.showWarningMessage("No firmware entry found for this board. Update assets/firmwareCatalog.json.");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Flash MicroPython for ${entry.id} to ${connect}? Ensure the board is in bootloader mode (BOOT/EN buttons).`,
        { modal: true },
        "Flash Now"
      );
      if (confirm !== "Flash Now") return;

      // Close REPL if open to free the port
      // Assuming isReplOpen and closeReplTerminal exist
      // if (isReplOpen()) {
      //   await closeReplTerminal();
      //   await new Promise(r => setTimeout(r, 300));
      // }

      const pythonCmd = await ensureEsptool();

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Flashing MicroPython (${entry.id})`,
        cancellable: false
      }, async progress => {
        progress.report({ message: "Downloading firmware..." });
        const fwPath = await downloadFirmware(entry.url);

        const args = [
          "-m", "esptool",
          "--chip", entry.chip,
          "--port", connect,
          "--baud", "460800",
          "--before", "default_reset",
          "--after", "hard_reset",
          "write_flash", "-z",
          "--flash_mode", entry.flashMode,
          "--flash_freq", entry.flashFreq,
          "--flash_size", "detect",
          entry.offset,
          fwPath
        ];
        progress.report({ message: "Flashing (esptool)..." });
        await new Promise<void>((resolve, reject) => {
          execFile(pythonCmd, args, {
            env: {
              ...process.env,
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8",
              TERM: "dumb"
            }
          }, (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message || "Flash failed"));
            } else {
              resolve();
            }
          });
        });
        progress.report({ message: "Flash complete. Resetting board..." });
      });

      vscode.window.showInformationMessage(`Flashed MicroPython for ${entry.id}. You may need to reset/reconnect the board.`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Flash failed: ${error?.message || error}`);
    }
  }
};

// Helper functions for board commands
type FirmwareEntry = {
  id: string;
  aliases: string[];
  chip: string;
  flashMode: string;
  flashFreq: string;
  offset: string;
  url: string;
};

async function loadFirmwareCatalog(extPath: string): Promise<FirmwareEntry[]> {
  try {
    const catalogPath = path.join(extPath, "assets", "firmwareCatalog.json");
    const txt = await fs.readFile(catalogPath, "utf8");
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed?.entries) ? parsed.entries as FirmwareEntry[] : [];
  } catch (e) {
    console.error("[DEBUG] loadFirmwareCatalog: failed to read catalog", e);
    return [];
  }
}

function normalizeBoardKey(machine: string | undefined): string | null {
  if (!machine) return null;
  const upper = machine.toUpperCase();
  const m = upper.match(/ESP32[-_\s]*([A-Z0-9]+)/);
  if (m && m[1]) return `ESP32${m[1].replace(/[^A-Z0-9]/g, "")}`;
  if (upper.startsWith("ESP32")) return upper.replace(/[^A-Z0-9]/g, "");
  return null;
}

function findFirmwareForMachine(machine: string | undefined, catalog: FirmwareEntry[]): FirmwareEntry | undefined {
  const key = normalizeBoardKey(machine);
  if (!key) return undefined;
  const simpleKey = key.replace(/[^A-Z0-9]/g, "");
  return catalog.find(entry => {
    const aliases = entry.aliases || [];
    return aliases.some(a => a.replace(/[^A-Z0-9]/g, "").toUpperCase() === simpleKey);
  });
}

async function getPythonCmd(): Promise<string> {
  try {
    const ws = vscode.workspace.workspaceFolders?.[0];
    return await PythonInterpreterManager.getPythonPath(ws);
  } catch {
    return "python";
  }
}

async function ensureEsptool(): Promise<string> {
  const attempts: { cmd: string; error?: string }[] = [];

  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    TERM: "dumb"
  };

  async function tryCmd(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { env }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message || "unknown error"));
        } else {
          resolve(cmd);
        }
      });
    });
  }

  const record = (cmd: string, err?: any) => {
    attempts.push({ cmd, error: err?.message || String(err || "") || undefined });
    if (err) console.warn("[DEBUG] ensureEsptool failed:", cmd, "-", err?.message || err);
  };

  const pyCheckArgs = ["-c", "import esptool; print(esptool.__version__)"];
  // Primary: VS Code / user configured interpreter
  const py = await getPythonCmd();
  try { return await tryCmd(py, pyCheckArgs); }
  catch (err) { record(`${py} ${pyCheckArgs.join(" ")}`, err); }

  // Windows convenience launcher
  if (process.platform === "win32") {
    try { return await tryCmd("py", ["-3", ...pyCheckArgs]); }
    catch (err) { record(["py", "-3", ...pyCheckArgs].join(" "), err); }
  }

  // Generic fallbacks
  for (const p of ["python", "python3"]) {
    try { return await tryCmd(p, pyCheckArgs); }
    catch (err) { record(`${p} ${pyCheckArgs.join(" ")}`, err); }
  }

  // Raw esptool executables if installed globally
  for (const tool of ["esptool.py", "esptool"]) {
    try { return await tryCmd(tool, ["--version"]); }
    catch (err) { record(`${tool} --version`, err); }
  }

  const attemptsList = attempts.map(a => `• ${a.cmd}${a.error ? ` → ${a.error}` : ""}`).join("\n");
  throw new Error(`esptool is not available using any Python command. Tried:\n${attemptsList}\nInstall with: pip install esptool\nIf Python differs from your shell, set microPythonWorkBench.pythonPath to the interpreter with esptool.`);
}

async function downloadFirmware(url: string): Promise<string> {
  const dest = path.join(os.tmpdir(), `mpy-fw-${Date.now()}.bin`);
  return new Promise((resolve, reject) => {
    const file = fsSync.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow simple redirect once
        https.get(res.headers.location, res2 => {
          if (res2.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res2.statusCode}`));
            return;
          }
          res2.pipe(file);
          file.on("finish", () => file.close(() => resolve(dest)));
          res2.on("error", reject);
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
      res.on("error", reject);
    }).on("error", reject);
  });
}