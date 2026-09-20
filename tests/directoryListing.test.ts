jest.mock("vscode");
jest.mock("node:path", () => jest.requireActual("node:path"));
jest.mock("../src/board/mpyClient", () => ({ listdir: jest.fn(), tree: jest.fn() }));

import * as vscode from "vscode";
import * as client from "../src/board/mpyClient";
import { clearFileTreeCache, lsTyped, refreshFileTreeCache, setSelectedConnect } from "../src/board/mpremote";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("directory listing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearFileTreeCache();
    setSelectedConnect("COM7");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: (key: string, fallback: unknown) => key === "microPythonWorkBench.rootPath" ? "/sd/app" : fallback,
    });
    (client.listdir as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  test("refresh and expansion only list direct children, including after expiry", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    await refreshFileTreeCache();
    await lsTyped("/sd/app");
    expect(client.listdir).toHaveBeenCalledTimes(1);
    expect(client.listdir).toHaveBeenLastCalledWith("COM7", "/sd/app");
    await lsTyped("/sd/app/lib");
    now += 31000;
    await lsTyped("/sd/app/lib");
    expect(client.listdir).toHaveBeenCalledTimes(3);
    expect(client.tree).not.toHaveBeenCalled();
  });

  test("merges duplicate refreshes and directory requests and caches empty directories", async () => {
    const pending = deferred<[]>();
    (client.listdir as jest.Mock).mockReturnValue(pending.promise);
    const a = refreshFileTreeCache();
    const b = refreshFileTreeCache();
    const c = lsTyped("sd/app/");
    expect(client.listdir).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await Promise.all([a, b, c]);
    expect(await lsTyped("/sd/app")).toEqual([]);
    expect(client.listdir).toHaveBeenCalledTimes(1);
  });

  test("isolates ports, normalizes root and retries failed requests", async () => {
    const error = new Error("sync timeout");
    (client.listdir as jest.Mock).mockRejectedValueOnce(error);
    await expect(lsTyped("")).rejects.toBe(error);
    await lsTyped("/");
    setSelectedConnect("COM8");
    await lsTyped("");
    expect(client.listdir).toHaveBeenCalledTimes(3);
    expect(client.listdir).toHaveBeenLastCalledWith("COM8", "/");
  });

  test("an invalidated response cannot overwrite a fresh directory result", async () => {
    const pending = deferred<any[]>();
    (client.listdir as jest.Mock).mockReturnValueOnce(pending.promise);
    const old = lsTyped("/");
    clearFileTreeCache();
    (client.listdir as jest.Mock).mockResolvedValue([{ name: "new.py", is_dir: false }]);
    await lsTyped("/");
    pending.resolve([{ name: "old.py", is_dir: false }]);
    await old;
    expect(await lsTyped("/")).toEqual([{ name: "new.py", isDir: false }]);
  });
});
