jest.mock("vscode");
jest.mock("../src/completion/codeCompletion", () => ({ codeCompletionManager: {
  getActiveStubPath: jest.fn(), getActiveCompletionRoots: jest.fn(() => []),
} }));
jest.mock("../src/board/serialManagerDescriptor", () => ({
  getSerialManagerDescriptorPath: jest.fn(), readSerialManagerDescriptor: jest.fn(),
  removeSerialManagerDescriptor: jest.fn(), writeSerialManagerDescriptor: jest.fn(),
}));
jest.mock("../src/board/serialManagerProcess");
jest.mock("../src/board/serialManagerClient");

import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { SerialManagerProcess } from "../src/board/serialManagerProcess";
import { SerialManagerClient } from "../src/board/serialManagerClient";
import { closeManager, ensureManagerStarted, getActiveManagerRuntime } from "../src/board/serialManager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("shared manager lifecycle", () => {
  const endpoint = { host: "127.0.0.1", port: 1234, token: "test-token" };
  let start: jest.Mock;
  let stop: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [];
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback });
    start = jest.fn().mockResolvedValue(endpoint);
    stop = jest.fn().mockResolvedValue(undefined);
    (SerialManagerProcess as jest.Mock).mockImplementation(() => ({ start, stop }));
    (SerialManagerClient as unknown as jest.Mock).mockImplementation(() => Object.assign(new EventEmitter(), {
      connected: true,
      connect: jest.fn().mockResolvedValue(undefined), dispose: jest.fn(),
      call: jest.fn().mockResolvedValue({ protocolVersion: 1, status: { state: "ready" } }),
    }));
  });

  afterEach(async () => { await closeManager(); });

  test("simultaneous refresh and REPL requests share one startup", async () => {
    const pending = deferred<typeof endpoint>();
    start.mockReturnValue(pending.promise);
    const requests = [ensureManagerStarted("COM7"), ensureManagerStarted("COM7"), ensureManagerStarted("COM7")];
    pending.resolve(endpoint);
    const runtimes = await Promise.all(requests);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(runtimes.every(runtime => runtime === runtimes[0])).toBe(true);
  });

  test("failed startup is shared and a later request can retry", async () => {
    start.mockRejectedValueOnce(new Error("failed to start"));
    const results = await Promise.allSettled([ensureManagerStarted("COM7"), ensureManagerStarted("COM7")]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    await ensureManagerStarted("COM7");
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("close during startup releases that instance, and a later open starts again", async () => {
    const pending = deferred<typeof endpoint>();
    start.mockReturnValueOnce(pending.promise);
    const first = ensureManagerStarted("COM7");
    const closed = closeManager();
    const second = ensureManagerStarted("COM7");
    pending.resolve(endpoint);
    await first;
    await closed;
    await second;
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getActiveManagerRuntime()?.device).toBe("COM7");
  });

  test("different device requests are serialized without overlapping startups", async () => {
    const pending = deferred<typeof endpoint>();
    start.mockReturnValueOnce(pending.promise);
    const first = ensureManagerStarted("COM7");
    const second = ensureManagerStarted("COM8");
    pending.resolve(endpoint);
    await first;
    await second;
    expect(start.mock.calls.map(([options]) => options.device)).toEqual(["COM7", "COM8"]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getActiveManagerRuntime()?.device).toBe("COM8");
  });
});
