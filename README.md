# MicroPython Workbench — MicroPython file manager for VS Code

[中文](README_zh-CN.md)

Inspired by Thonny’s simplicity, this extension streamlines MicroPython development across multiple boards. It provides remote file management, an integrated REPL, and automatic two-way synchronization, enabling a smoother workflow within VS Code.

The extension leverages **mpremote** for all board interactions, including file transfer, REPL connectivity, and command execution.

## Main features

- 📂 Remote file explorer for the device (open, download files/folders, upload, rename, delete)
- 🔄 Two-way sync: compare local files with the device and sync changed files
- 📝 Create a new file in the Files view and upload it to the board on first save
- 💻 Integrated MicroPython REPL terminal
- ⏯️ Send commands to the board (stop, soft reset, etc.)
- 🧭 Files view shows the detected board name and status bar displays last auto-sync time
- 🧠 **IntelliSense code completion** for MicroPython modules with auto-detection and multi-language support

## Quick Start

1. Install the extension from the VS Code Marketplace or build and install the `.vsix`:

```bash
# build package (requires vsce)
npm ci
npm run compile
npm run package
# then install the generated .vsix in VS Code (Extensions > ... > Install from VSIX)
```

2. Ensure dependencies are available on your machine:

```bash
# Python 3.8+ (recommended >=3.10)
# `mpremote` is required by this extension. Install it into the Python environment
# you want the extension to use:
python -m pip install --user mpremote
```

## Configuration

Key settings (see extension settings in VS Code):

- `microPythonWorkBench.syncLocalRoot`: local folder to sync (default: `""` meaning workspace root).
- `microPythonWorkBench.autoSyncOnSave`: enable auto-sync on save (default: `false`).
- `microPythonWorkBench.pythonPath`: Python executable to use when invoking `esptool`/helpers.

For full list of configuration options see `package.json` -> `contributes.configuration`.

## Current limitations and notes

- Compatibility validation currently focuses on ESP32 variants (ESP32-S3, ESP32-C3). Before relying on other boards, verify serial, sync, and REPL behavior end to end.
- The project includes a CI workflow that runs build/tests across multiple OS and Node.js versions; however unit test coverage is limited—please run `npm test` locally and extend tests for core modules (`sync`, `board`, `completion`).

**⚡ Connect to board and run a file**
![Run file demo](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/run-file.gif?raw=true)

**🔄 Autosync local folder contents**
![Sync files demo](https://github.com/132xyz/VScodeMicroPython/blob/main/assets/sync%20new%20files.gif?raw=true)

## Sync utilities

These commands perform full or incremental synchronization between your local workspace and the connected MicroPython board:

- **Check for differences:** Lists new, changed, or deleted files between local and board.
- **Sync Local → Board:** Uploads only local files that are new or modified.
- **Sync Board → Local:** Downloads only board files that are new or modified.
- **Upload all Local → Board:** Uploads all non-ignored local files to the device.
- **Download all Board → Local:** Downloads all board files, overwriting local copies.
- **Delete all files on board:** Removes all files on the device.

## Useful commands (Command Palette)

- `MPY Workbench: Refresh` — refresh the file tree
- `MPY Workbench: Check files differences` — show diffs and local-only files
- `MPY Workbench: Sync changed Files (Local → Board)` — upload changed local files
- `MPY Workbench: Sync changed Files (Board → Local)` — download changed board files
- `MPY Workbench: Sync all files` — full upload or download
- `MPY Workbench: Select Serial Port` — pick device port
- `MPY Workbench: Open REPL Terminal` — open MicroPython REPL
- `MPY Workbench: Toggle workspace Auto-Sync on Save` — enable/disable workspace auto-sync
- `MPY Workbench: Toggle Code Completion` — enable/disable MicroPython code completion

## Workspace config

The extension stores per-workspace settings and manifests inside a workspace folder named `.mpy-workbench` at your project root.

- Workspace override file: `.mpy-workbench/config.json`
- Sync manifest: `.mpy-workbench/esp32sync.json`

Use the command `MicroPython WorkBench: Toggle workspace Auto-Sync on Save` to enable or disable auto-sync for the current workspace. The toggle stores its workspace-specific value in the extension workspace state. If no stored value exists, the extension falls back to the VS Code setting `microPythonWorkBench.autoSyncOnSave`, and finally to the legacy `.mpy-workbench/config.json` value when present.

### Local sync root directory

By default, sync operations use the workspace root directory. You can configure a different local root directory using the `microPythonWorkBench.syncLocalRoot` setting:

- **Empty (default)**: Uses the workspace root directory
- **Relative path**: e.g., `"mpy"`, `"src"` or `"micropython"` — interpreted relative to workspace root
- **Absolute path**: Full path to a directory outside the workspace

For many users the practical workflow is to set a single project subfolder (for example `mpy`) as the local sync root. When mapping device paths to local files the extension now always maps device paths into the configured local sync root. Concretely:

- If your `microPythonWorkBench.syncLocalRoot` is `mpy` and a device file is `/mpy/t.py`, it maps to `./mpy/mpy/t.py` (device path components are preserved under the local sync root).
- If the device root is a workspace-scoped generated name (used when `microPythonWorkBench.rootPath` is `/`), that device root itself maps to the local sync root (empty relative path), and child paths map to their relative paths beneath it.

This behavior ensures device files are always placed under the configured sync directory. See `example-workspace-settings.json` for a complete configuration example.

## Code Completion

The extension provides intelligent code completion for MicroPython modules using Python stub files. This feature integrates with VS Code's Pylance language server to provide IntelliSense support.

### How It Works

- Enabling code completion makes the extension pick a workspace-installed MicroPython stub package when possible.
- If the selected stub root contains a typeshed-style tree, the extension also updates Pylance's standard-library source so MicroPython-specific builtins and stdlib modules can be resolved more accurately.
- If your workspace contains `pyrightconfig.json` or a `pyproject.toml` with a `[tool.pyright]` section, those files can override VS Code `python.analysis.*` settings.

### Configuration Options

```json
{
  "microPythonWorkBench.enableCodeCompletion": true,
  "microPythonWorkBench.stubInstallPath": ".mpy-workbench/pyi",
  "microPythonWorkBench.codeCompletionExtraPaths": [],
  "microPythonWorkBench.stubAutoSelect": true
}
```

- `microPythonWorkBench.enableCodeCompletion`:
  - `true`: Enable MicroPython code completion for the current workspace
  - `false`: Disable the extension-managed MicroPython completion integration
- `microPythonWorkBench.stubInstallPath`: Workspace-relative directory where installed stub packages are stored
- `microPythonWorkBench.codeCompletionExtraPaths`: Extra directories or .pyi files merged into the active MicroPython stub root when completion is enabled
- `microPythonWorkBench.stubAutoSelect`: Automatically pick and apply the best installed stub for the connected board when possible

### Installing And Switching Stubs

Use `MPY Workbench: Toggle Code Completion` from the Command Palette to manually enable/disable code completion for the current workspace.

- Use the `MPY: Stub` status bar item to manage MicroPython stubs for the workspace.
- The stub picker can choose from installed stubs, install the recommended version for the detected board, install a specific package/version, or refresh the installed stub index.
- Installed stubs are stored under `.mpy-workbench/pyi` by default so multiple versions can coexist inside the workspace.
- If you manually install a stub package with pip into that directory, it will appear in the installed stub picker after the index is refreshed.
- Some MicroPython stub packages are hybrid trees that contain both a typeshed-style stdlib and top-level stub-only modules such as `machine` or `time`. When MicroPython code completion is enabled, the extension suppresses `reportMissingModuleSource` for this case because the device runtime exists on the board, not in the local Python interpreter.

### Requirements

- **Pylance extension** (recommended): `ms-python.vscode-pylance` for full IntelliSense support
- Code completion works with any Python language server but provides enhanced experience with Pylance

### Auto-suspend and REPL restore

- `microPythonWorkBench.serialAutoSuspend` (default: `true`): closes REPL/Run terminals before file ops to avoid port conflicts, then restores what was open afterward (re-runs Run Active File, or reopens REPL).
- `microPythonWorkBench.replRestoreBehavior` (default: `none`): what to do when REPL is restored after auto-suspend/auto-sync:
  - `runChanged`: Auto run the changed/saved file in REPL after sync.
  - `executeBootMain`: send Ctrl-D so boards that auto-run `main.py`/`boot.py` after reset will restart.
  - `openReplEmpty`: reopen the REPL without sending anything.
  - `none`: do not reopen the REPL.

## Status indicators

- Status bar shows `MPY: AutoSync ON/OFF`, a cancel-all-tasks button, and `MPY: LastSync <time>` after each auto-sync run.
- Files view header displays the detected board name/ID once a fixed serial port is selected.

## Requirements

- **Python 3.8+** - The extension uses Python to run mpremote and related helpers
- **mpremote** - Required in the Python environment the extension uses, for example `python -m pip install --user mpremote`
- **Manual firmware flashing (optional):** If you want to flash boards outside the extension, install `esptool` in the same Python environment
- **Code Completion (optional):** [Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) extension for enhanced IntelliSense support
- The Python path used by the extension can be adjusted in the extension settings if a specific interpreter needs to be selected.

## Firmware flashing (removed)

- Automatic esptool-based firmware flashing has been removed from this extension.
- Please flash boards manually using `esptool` or vendor tools. Example:

```bash
pip install esptool
python -m esptool --chip esp32 --port COM3 write_flash -z --flash_mode qio --flash_freq 40m --flash_size detect 0x1000 firmware.bin
```

Replace `COM3` / options as appropriate for your board.

## Next steps

- ✅ Broaden board compatibility (currently tested only with ESP32-S3 and ESP32-C3)
- 🧪 Extend automated coverage for board, sync, and REPL runtime paths
- 🪟 Perform full Windows testing: validate mpremote compatibility with COM ports and ensure consistent behavior of file operations and REPL across Windows environments

## Contributing

Issues and pull requests are welcome.

## License

MIT — see the `LICENSE` file in this repository.

## Acknowledgements

- Thanks to walkline's code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython — this project helped shape the MicroPython completion support used by this repository.
- Thanks to the original `mpy-workbench` project by Daniel Bustillos for the initial design and implementation reference: https://github.com/DanielBustillos/mpy-workbench
