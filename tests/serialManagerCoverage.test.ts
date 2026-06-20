jest.mock("vscode");

import { wrapReplClientCommand } from "../src/board/serialManager";

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
});
