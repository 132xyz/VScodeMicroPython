jest.mock("vscode");
jest.mock("node:fs", () => ({ existsSync: jest.fn(() => true) }));
jest.mock("node:child_process", () => ({ spawn: jest.fn() }));
jest.mock("../src/board/MpRemoteManager", () => ({
  MpRemoteManager: {
    detectPythonPath: jest.fn(),
  },
}));

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { MpRemoteManager } from "../src/board/MpRemoteManager";
import {
  SerialManagerProcess,
  parseReadyLine,
  quoteShellArg,
  splitCommand,
} from "../src/board/serialManagerProcess";
import { MANAGER_READY_MARKER } from "../src/board/serialManagerTypes";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  kill = jest.fn(() => {
    this.killed = true;
    this.exitCode = 1;
    this.emit("exit", 1);
    return true;
  });
}

describe("SerialManagerProcess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({ extensionPath: "/extension" });
    (vscode.extensions as any).all = [];
    (vscode.workspace as any).workspaceFolders = [];
    (MpRemoteManager.detectPythonPath as jest.Mock).mockResolvedValue("py -3");
  });

  test("parses ready lines and python commands", () => {
    expect(splitCommand("py -3")).toEqual({ exe: "py", args: ["-3"] });
    expect(splitCommand("C:\\Program Files\\Python\\python.exe")).toEqual({
      exe: "C:\\Program Files\\Python\\python.exe",
      args: [],
    });
    expect(parseReadyLine(`${MANAGER_READY_MARKER}{"host":"127.0.0.1","port":123,"token":"tok"}`, "tok")).toEqual({
      host: "127.0.0.1",
      port: 123,
      token: "tok",
    });
    expect(parseReadyLine("noise")).toBeUndefined();
    expect(quoteShellArg("a b")).toContain("a b");
  });

  test("starts manager process and resolves endpoint", async () => {
    const child = new FakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
    const manager = new SerialManagerProcess();
    const started = manager.start({
      device: "COM21",
      baudRate: 1500000,
      token: "tok",
      scriptPath: "/extension/scripts/mpyrepl/__main__.py",
    });

    await Promise.resolve();
    await Promise.resolve();
    child.stdout.emit("data", Buffer.from(`${MANAGER_READY_MARKER}{"host":"127.0.0.1","port":50123,"token":"tok"}\n`));
    const endpoint = await started;
    child.exitCode = 0;
    await manager.stop();

    expect(endpoint.port).toBe(50123);
    expect(spawn).toHaveBeenCalledWith(
      "py",
      expect.arrayContaining(["-3", expect.stringContaining("__main__.py"), "--port", "COM21", "manager"]),
      expect.objectContaining({ windowsHide: true }),
    );
  });

  test("does not reuse stale endpoint after child exits", async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    (spawn as jest.Mock)
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const manager = new SerialManagerProcess();

    const firstStart = manager.start({
      device: "COM21",
      baudRate: 115200,
      token: "tok",
      scriptPath: "/extension/scripts/mpyrepl/__main__.py",
    });
    await Promise.resolve();
    firstChild.stdout.emit("data", Buffer.from(`${MANAGER_READY_MARKER}{"host":"127.0.0.1","port":50123,"token":"tok"}\n`));
    await firstStart;
    firstChild.exitCode = 1;
    firstChild.emit("exit", 1);

    const secondStart = manager.start({
      device: "COM21",
      baudRate: 115200,
      token: "tok",
      scriptPath: "/extension/scripts/mpyrepl/__main__.py",
    });
    await Promise.resolve();
    secondChild.stdout.emit("data", Buffer.from(`${MANAGER_READY_MARKER}{"host":"127.0.0.1","port":50124,"token":"tok"}\n`));
    const endpoint = await secondStart;

    expect(endpoint.port).toBe(50124);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
