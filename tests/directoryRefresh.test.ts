jest.mock("vscode");
jest.mock("../src/board/mpremote", () => ({ refreshFileTreeCache: jest.fn() }));
jest.mock("../src/core/localization", () => ({ Localization: { showError: jest.fn() } }));

import { refresh } from "../src/core/utilityOperations";
import { refreshFileTreeCache } from "../src/board/mpremote";
import { Localization } from "../src/core/localization";

test("failed explicit refresh reports the error without triggering another device listing", async () => {
  const tree = { allowListing: jest.fn(), enableRawListForNext: jest.fn(), clearCache: jest.fn(), refreshTree: jest.fn() };
  (refreshFileTreeCache as jest.Mock).mockRejectedValue(new Error("REPL sync timeout"));
  const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await refresh(tree as any, {} as any);
    expect(refreshFileTreeCache).toHaveBeenCalledTimes(1);
    expect(tree.refreshTree).not.toHaveBeenCalled();
    expect(Localization.showError).toHaveBeenCalledWith("messages.fileTreeCacheRefreshFailed", "REPL sync timeout");
  } finally {
    warning.mockRestore();
  }
});
