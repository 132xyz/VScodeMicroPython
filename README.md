# MicroPython Workbench for VS Code

[中文](README_zh-CN.md)

MicroPython Workbench is a VS Code extension for MicroPython development on ESP32-class boards and similar devices. It combines board file browsing, diff-based sync, run/REPL terminals, and workspace-scoped MicroPython stub management in one workflow.

Board file operations still use `mpremote`. The REPL terminal can optionally switch to an experimental Python client (`scripts/mpyrepl`) that adds host-side editing, richer completion, and more robust Unicode handling.

## Main features


- Remote file explorer for the connected board: open, download, upload, rename, delete
- Diff-based sync in both directions between workspace files and board files
- Active-file sync and optional auto-sync on save
- Integrated REPL terminal and separate Run Active File terminal
- Board actions such as interrupt, soft reset, and reconnect
- MicroPython code completion with stub installation, auto-selection, and Pylance integration
- Optional experimental custom Python REPL with multiline editing, completion, and control-channel based interrupt/reset handling

**Connect to the board and run a file**
![Run file demo](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/run-file.gif?raw=true)

**Auto-sync local folder contents**
![Sync files demo](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/sync%20new%20files.gif?raw=true)

## Quick start

1. Install the extension from the VS Code Marketplace, or build a `.vsix` locally:

```bash
npm ci
npm run compile
npm run package
```

2. Install `mpremote` into the Python environment used by the extension:

```bash
python -m pip install --user mpremote
```

3. Open a workspace, run `MicroPython WorkBench: Select Serial Port`, then use the Files view or Command Palette to sync, browse, or open the REPL.

4. Optional but recommended:
   - Install the Python and Pylance VS Code extensions for the best completion experience.
   - Enable `microPythonWorkBench.enableCodeCompletion` for workspace-scoped MicroPython IntelliSense.
   - Enable `microPythonWorkBench.experimentalCustomRepl` if you want the experimental host-side REPL client.

## Requirements

- Python 3.8+ for the extension's standard `mpremote`-based workflows
- Python 3.9+ if you enable `microPythonWorkBench.experimentalCustomRepl`
- `mpremote` installed in the Python environment selected by the extension
- The Python extension (`ms-python.python`) is required
- Pylance (`ms-python.vscode-pylance`) is recommended for the full code-completion workflow

Use `microPythonWorkBench.pythonPath` if the extension should use a specific interpreter instead of the default VS Code Python environment.

## Core workflows

### Files and sync

- `MicroPython WorkBench: Refresh` reloads the board file tree.
- `MicroPython WorkBench: Check files differences` compares board files with the configured local sync root.
- `MicroPython WorkBench: Sync changed Files Local → Board` and `MicroPython WorkBench: Sync changed Files Board → Local` only transfer changed files.
- `MicroPython WorkBench: Sync all files (Local → Board)` and `MicroPython WorkBench: Sync all files (Board → Local)` perform full baseline sync operations.
- `MicroPython WorkBench: Sync Active File Local → Board` uploads only the current editor file when it belongs to the configured sync root.

Workspace-specific metadata is stored under `.mpy-workbench/`:

- `.mpy-workbench/config.json`: legacy workspace override file
- `.mpy-workbench/esp32sync.json`: sync manifest used by board sync workflows
- `.mpy-workbench/pyi/`: default installation root for MicroPython stub packages

### REPL, Run, and auto-suspend

- The default REPL terminal opens `mpremote connect <port>` in a persistent VS Code terminal.
- `MicroPython WorkBench: Run Active File` runs the current local file through `mpremote connect <port> run <file>`.
- On Windows, the extension initializes REPL and Run terminals with UTF-8-oriented environment settings and PowerShell output encoding.
- `microPythonWorkBench.serialAutoSuspend` closes REPL/Run terminals before sync operations to avoid serial-port conflicts, then restores the previous session state afterward.
- `microPythonWorkBench.replRestoreBehavior` controls what happens after auto-suspend restores the REPL:
  - `runChanged`: import the synced file back into REPL when possible
  - `executeBootMain`: send `Ctrl-D` so boards that auto-run `boot.py` or `main.py` can restart
  - `openReplEmpty`: reopen REPL without sending a follow-up command
  - `none`: do not reopen REPL automatically

### Code completion

- `microPythonWorkBench.enableCodeCompletion` enables workspace-scoped MicroPython completion integration.
- The `MPY: Stub` status bar item manages installed stub packages.
- The extension can auto-select the best installed stub package for the connected board when `microPythonWorkBench.stubAutoSelect` is enabled.
- `microPythonWorkBench.codeCompletionExtraPaths` lets you merge extra stub directories or `.pyi` files into the active MicroPython stub root.
- If a selected stub package contains a typeshed-style standard library layout, the extension also updates the Pylance analysis source layout for better MicroPython symbol resolution.

### Experimental custom Python REPL

- Enable `microPythonWorkBench.experimentalCustomRepl` to replace the default `mpremote` REPL terminal with the bundled Python `mpyrepl` client.
- This affects the REPL terminal only. File browsing, file sync, and Run Active File still use `mpremote`.
- The custom REPL currently focuses on:
  - host-side multiline editing
  - prompt-toolkit based completion
  - session-aware symbol tracking
  - control-file based interrupt, soft reset, and exit
  - safer Unicode output handling on Windows and mixed-encoding hosts

See [docs/custom-python-repl.md](docs/custom-python-repl.md) for the English guide and [docs/custom-python-repl_zh-CN.md](docs/custom-python-repl_zh-CN.md) for the Chinese guide.

## Configuration highlights

These are the settings most users will touch first:

- `microPythonWorkBench.connect`: fixed serial device such as `COM3` or `/dev/ttyUSB0`
- `microPythonWorkBench.syncLocalRoot`: workspace-relative or absolute local sync root
- `microPythonWorkBench.rootPath`: board-side root path such as `/` or `/lib`
- `microPythonWorkBench.autoSyncOnSave`: upload local saves automatically
- `microPythonWorkBench.serialAutoSuspend`: suspend REPL/Run terminals around sync operations
- `microPythonWorkBench.replRestoreBehavior`: control how REPL is restored after auto-suspend
- `microPythonWorkBench.experimentalCustomRepl`: switch REPL terminal to the experimental Python client
- `microPythonWorkBench.pythonPath`: interpreter override used for `mpremote` and helper scripts
- `microPythonWorkBench.enableCodeCompletion`: enable workspace-scoped MicroPython completion
- `microPythonWorkBench.stubInstallPath`: default stub installation directory inside the workspace
- `microPythonWorkBench.stubAutoSelect`: automatically apply the best installed stub for the connected board
- `microPythonWorkBench.codeCompletionExtraPaths`: merge extra `.pyi` paths into the active stub root
- `microPythonWorkBench.usePyRawList`: use the Python raw-REPL directory listing helper instead of the default listing path

See `package.json` under `contributes.configuration` for the full setting list.

## Useful commands

- `MicroPython WorkBench: Select Serial Port`
- `MicroPython WorkBench: Refresh`
- `MicroPython WorkBench: Open REPL`
- `MicroPython WorkBench: Open Serial Monitor`
- `MicroPython WorkBench: Run Active File`
- `MicroPython WorkBench: Interrupt (Ctrl-C, Ctrl-B)`
- `MicroPython WorkBench: Soft Reset (Ctrl-D)`
- `MicroPython WorkBench: Check files differences`
- `MicroPython WorkBench: Sync changed Files Local → Board`
- `MicroPython WorkBench: Sync changed Files Board → Local`
- `MicroPython WorkBench: Sync all files (Local → Board)`
- `MicroPython WorkBench: Sync all files (Board → Local)`
- `MicroPython WorkBench: Toggle workspace Auto-Sync on Save`
- `MicroPython WorkBench: Toggle Code Completion`

## Build, test, and package

```bash
npm run compile
npm test
npm run test:js:coverage
npm run test:py
npm run test:coverage
npm run package
```

Current repository testing is split into two parts:

- JavaScript/TypeScript extension tests: Jest + ts-jest under `tests/`
- Python custom-REPL tests: `scripts/mpyrepl/test_*.py`

CI runs on GitHub Actions across:

- `ubuntu-latest`, `windows-latest`, `macos-latest`
- Node.js 24 and 22
- Python 3.11

The current workflow uses `actions/checkout@v6`, `actions/setup-node@v6`, and `actions/setup-python@v6`.

For more detail, see [docs/TEST_README.md](docs/TEST_README.md).

## Related docs

- [docs/custom-python-repl.md](docs/custom-python-repl.md)
- [docs/custom-python-repl_zh-CN.md](docs/custom-python-repl_zh-CN.md)
- [docs/TEST_README.md](docs/TEST_README.md)
- [docs/mpremote-windows-utf8.md](docs/mpremote-windows-utf8.md)
- [docs/repl_architecture_plan.md](docs/repl_architecture_plan.md)

## Current limitations

- Compatibility validation is still concentrated on ESP32 variants, especially ESP32-S3 and ESP32-C3.
- The experimental custom REPL only replaces the REPL terminal path. Sync, browsing, and Run Active File still depend on `mpremote`.
- Some board/runtime paths remain less covered than pure utility and configuration code, so board-specific regressions should still be validated on hardware.
- Automatic firmware flashing has been removed from this extension. Flash boards with `esptool` or vendor tooling outside the extension.

## Contributing

Issues and pull requests are welcome.

## License

MIT. See `LICENSE`.

## Acknowledgements

- Thanks to walkline's code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython
- Thanks to the original `mpy-workbench` project by Daniel Bustillos: https://github.com/DanielBustillos/mpy-workbench
