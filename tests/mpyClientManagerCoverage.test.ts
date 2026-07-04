jest.mock("vscode");
jest.mock("node:fs", () => ({
  statSync: jest.fn(() => ({ size: 10 })),
}));
jest.mock("../src/board/serialManager", () => ({
  cancelManagerOperation: jest.fn(),
  closeManager: jest.fn(),
  ensureManagerStarted: jest.fn(),
  getActiveManagerRuntime: jest.fn(),
  getManagerClient: jest.fn(),
  interruptManager: jest.fn(),
  isRecoverableSerialManagerError: jest.fn((error: any) => error?.code === "transport_lost"),
  softResetManager: jest.fn(),
}));

import {
  cancelManagerOperation,
  closeManager,
  ensureManagerStarted,
  getActiveManagerRuntime,
  getManagerClient,
  interruptManager,
  isRecoverableSerialManagerError,
} from "../src/board/serialManager";
import * as mpyClient from "../src/board/mpyClient";

describe("mpyClient manager-backed operations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (cancelManagerOperation as jest.Mock).mockReset();
    (closeManager as jest.Mock).mockReset();
    (ensureManagerStarted as jest.Mock).mockReset();
    (getActiveManagerRuntime as jest.Mock).mockReset();
    (getManagerClient as jest.Mock).mockReset();
    (interruptManager as jest.Mock).mockReset();
    (isRecoverableSerialManagerError as jest.Mock).mockImplementation((error: any) => error?.code === "transport_lost");
  });

  test("listdir routes through active serial manager", async () => {
    const manager = {
      connected: true,
      call: jest.fn().mockResolvedValue([{ name: "main.py" }]),
    };
    (getManagerClient as jest.Mock).mockReturnValue(manager);
    (getActiveManagerRuntime as jest.Mock).mockReturnValue({ device: "COM21" });

    const result = await mpyClient.listdir("COM21", "/lib");

    expect(result).toEqual([{ name: "main.py" }]);
    expect(manager.call).toHaveBeenCalledWith(
      "fs.listdir",
      expect.objectContaining({ op: "listdir", path: "/lib", devicePath: "/lib" }),
      30000,
    );
  });

  test("listdir starts serial manager when no client is active", async () => {
    const manager = {
      connected: true,
      call: jest.fn().mockResolvedValue([{ name: "boot.py" }]),
    };
    (getActiveManagerRuntime as jest.Mock).mockReturnValue(undefined);
    (ensureManagerStarted as jest.Mock).mockResolvedValue({
      device: "COM21",
      endpoint: { host: "127.0.0.1", port: 5000, token: "tok" },
    });
    (getManagerClient as jest.Mock)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(manager);

    const result = await mpyClient.listdir("COM21", "/");

    expect(result).toEqual([{ name: "boot.py" }]);
    expect(ensureManagerStarted).toHaveBeenCalledWith("COM21");
    expect(manager.call).toHaveBeenCalledWith(
      "fs.listdir",
      expect.objectContaining({ op: "listdir", path: "/", devicePath: "/" }),
      30000,
    );
  });

  test("listdir closes stale manager and retries once after transport loss", async () => {
    const staleManager = {
      connected: true,
      call: jest.fn().mockRejectedValue(Object.assign(new Error("ReadFile failed"), { code: "transport_lost" })),
    };
    const restartedManager = {
      connected: true,
      call: jest.fn().mockResolvedValue([{ name: "after.py" }]),
    };
    (getActiveManagerRuntime as jest.Mock)
      .mockReturnValueOnce({ device: "COM21" })
      .mockReturnValueOnce(undefined);
    (ensureManagerStarted as jest.Mock).mockResolvedValue({
      device: "COM21",
      endpoint: { host: "127.0.0.1", port: 5000, token: "tok" },
    });
    (getManagerClient as jest.Mock)
      .mockReturnValueOnce(staleManager)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(restartedManager);

    const result = await mpyClient.listdir("COM21", "/");

    expect(result).toEqual([{ name: "after.py" }]);
    expect(closeManager).toHaveBeenCalled();
    expect(ensureManagerStarted).toHaveBeenCalledWith("COM21");
    expect(staleManager.call).toHaveBeenCalledTimes(1);
    expect(restartedManager.call).toHaveBeenCalledTimes(1);
  });

  test("listdir restarts manager when active runtime is for another device", async () => {
    const oldManager = {
      connected: true,
      call: jest.fn(),
    };
    const newManager = {
      connected: true,
      call: jest.fn().mockResolvedValue([{ name: "new.py" }]),
    };
    (getActiveManagerRuntime as jest.Mock).mockReturnValue({ device: "COM4" });
    (ensureManagerStarted as jest.Mock).mockResolvedValue({
      device: "COM21",
      endpoint: { host: "127.0.0.1", port: 5000, token: "tok" },
    });
    (getManagerClient as jest.Mock)
      .mockReturnValueOnce(oldManager)
      .mockReturnValueOnce(newManager);

    const result = await mpyClient.listdir("COM21", "/");

    expect(result).toEqual([{ name: "new.py" }]);
    expect(ensureManagerStarted).toHaveBeenCalledWith("COM21");
    expect(oldManager.call).not.toHaveBeenCalled();
    expect(newManager.call).toHaveBeenCalledWith(
      "fs.listdir",
      expect.objectContaining({ path: "/" }),
      30000,
    );
  });


  test("interrupt starts manager and sends device interrupt", async () => {
    (ensureManagerStarted as jest.Mock).mockResolvedValue({
      device: "COM21",
      endpoint: { host: "127.0.0.1", port: 5000, token: "tok" },
    });
    (interruptManager as jest.Mock).mockResolvedValue(true);

    await mpyClient.interrupt("COM21");

    expect(ensureManagerStarted).toHaveBeenCalledWith("COM21");
    expect(interruptManager).toHaveBeenCalled();
  });

  test("writeFileWithProgress subscribes to manager progress events", async () => {
    let progressHandler: ((payload: Record<string, unknown>) => void) | undefined;
    const manager = {
      connected: true,
      on: jest.fn((_event: string, handler: (payload: Record<string, unknown>) => void) => {
        progressHandler = handler;
      }),
      off: jest.fn(),
      call: jest.fn(async () => {
        progressHandler?.({
          op: "write_file",
          path: "/main.py",
          local_path: "main.py",
          bytes: 5,
          total: 10,
        });
      }),
    };
    (getManagerClient as jest.Mock).mockReturnValue(manager);
    (getActiveManagerRuntime as jest.Mock).mockReturnValue({ device: "COM21" });
    const events: mpyClient.FileTransferProgress[] = [];

    await mpyClient.writeFileWithProgress("COM21", "main.py", "/main.py", event => events.push(event));

    expect(manager.on).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(manager.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(manager.call).toHaveBeenCalledWith(
      "fs.writeFile",
      expect.objectContaining({ op: "write_file", path: "/main.py", localPath: "main.py" }),
      30 * 60 * 1000,
    );
    expect(events).toEqual([
      { localPath: "main.py", devicePath: "/main.py", bytes: 0, total: 10 },
      { localPath: "main.py", devicePath: "/main.py", bytes: 5, total: 10, done: false },
      { localPath: "main.py", devicePath: "/main.py", bytes: 10, total: 10, done: true },
    ]);
  });

  test("readFileWithProgress subscribes to manager progress events", async () => {
    let progressHandler: ((payload: Record<string, unknown>) => void) | undefined;
    const manager = {
      connected: true,
      on: jest.fn((_event: string, handler: (payload: Record<string, unknown>) => void) => {
        progressHandler = handler;
      }),
      off: jest.fn(),
      call: jest.fn(async () => {
        progressHandler?.({
          op: "read_file",
          path: "/main.py",
          local_path: "main.py",
          bytes: 5,
          total: 10,
        });
      }),
    };
    (getManagerClient as jest.Mock).mockReturnValue(manager);
    (getActiveManagerRuntime as jest.Mock).mockReturnValue({ device: "COM21" });
    const events: mpyClient.FileTransferProgress[] = [];

    await mpyClient.readFileWithProgress("COM21", "/main.py", "main.py", event => events.push(event));

    expect(manager.on).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(manager.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(manager.call).toHaveBeenCalledWith(
      "fs.readFile",
      expect.objectContaining({ op: "read_file", path: "/main.py", localPath: "main.py" }),
      30 * 60 * 1000,
    );
    expect(events).toEqual([
      { localPath: "main.py", devicePath: "/main.py", bytes: 0, total: 0 },
      { localPath: "main.py", devicePath: "/main.py", bytes: 5, total: 10, done: false },
      { localPath: "main.py", devicePath: "/main.py", bytes: 10, total: 10, done: true },
    ]);
  });

  test("writeFileWithProgress cancels active manager transfer", async () => {
    let cancelHandler: (() => void) | undefined;
    let rejectTransfer: ((error: Error) => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn((handler: () => void) => {
        cancelHandler = handler;
        return { dispose: jest.fn() };
      }),
    };
    const manager = {
      connected: true,
      on: jest.fn(),
      off: jest.fn(),
      call: jest.fn(() => new Promise<void>((_resolve, reject) => {
        rejectTransfer = reject;
      })),
    };
    (getManagerClient as jest.Mock).mockReturnValue(manager);
    (getActiveManagerRuntime as jest.Mock).mockReturnValue({ device: "COM21" });
    (cancelManagerOperation as jest.Mock).mockResolvedValue(true);

    const transfer = mpyClient.writeFileWithProgress(
      "COM21",
      "main.py",
      "/main.py",
      jest.fn(),
      token as any,
    );
    await Promise.resolve();
    token.isCancellationRequested = true;
    cancelHandler?.();
    rejectTransfer?.(new Error("manager cancelled transfer"));

    await expect(transfer).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelManagerOperation).toHaveBeenCalled();
  });
});
