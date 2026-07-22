jest.mock("vscode");

import { isConnectedManagerState, wrapReplClientCommand } from "../src/board/serialManager";

describe("serialManager command helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("wrapReplClientCommand keeps terminal open on non-zero exit", () => {
    const command = wrapReplClientCommand("python repl-client");

    expect(command).toContain("repl-client");
    expect(command).toContain("Terminal kept open for diagnostics");
    expect(command).not.toMatch(/;\s*exit\s*$/);
    if (process.platform === "win32") {
      expect(command).toContain("$LASTEXITCODE");
    } else {
      expect(command).toContain("code=$?");
    }
  });

  test("manager transport state excludes stopped and failed sessions", () => {
    expect(isConnectedManagerState("ready")).toBe(true);
    expect(isConnectedManagerState("busy")).toBe(true);
    expect(isConnectedManagerState("cancelling")).toBe(true);
    expect(isConnectedManagerState("stopped")).toBe(false);
    expect(isConnectedManagerState("failed")).toBe(false);
    expect(isConnectedManagerState("closing")).toBe(false);
  });
});
