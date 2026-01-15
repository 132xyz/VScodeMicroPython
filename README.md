# MicroPython Workbench — MicroPython file manager for VS Code

[中文](README_zh-CN.md)

Inspired by Thonny’s simplicity, this extension streamlines MicroPython development across multiple boards. It provides remote file management, an integrated REPL, and automatic two-way synchronization, enabling a smoother workflow within VS Code.

The extension leverages **mpremote** for all board interactions, including file transfer, REPL connectivity, and command execution.

## Main features

- 📂 Remote file explorer for the device (open, download files/folders, upload, rename, delete)
- 🔄 Two-way sync: compare local files with the device and sync changed files
- 📝 Create a new file in the Files view and upload it to the board on first save
- 💽 Flash MicroPython firmware via esptool with board auto-detection (catalog driven)
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
# Python 3.8+ (recommended >=3.10), mpremote and esptool
python -m pip install --user mpremote esptool
```

3. Open a workspace containing your MicroPython project, pick a serial port (`MPY Workbench: Select Serial Port`) and use the Files view to sync/upload files.

## Development & Tests

- Build: `npm run compile` (TypeScript -> `dist/`).
- Tests: `npm test` (Jest). CI is configured under `.github/workflows/ci.yml`.
- Packaging: `npm run package` (requires `vsce`).

## Configuration

Key settings (see extension settings in VS Code):

- `microPythonWorkBench.syncLocalRoot`: local folder to sync (default: `""` meaning workspace root).
- `microPythonWorkBench.autoSyncOnSave`: enable auto-sync on save (default: `false`).
- `microPythonWorkBench.pythonPath`: Python executable to use when invoking `esptool`/helpers.

For full list of configuration options see `package.json` -> `contributes.configuration`.

## Current limitations and notes

- Firmware catalog and board testing currently focused on ESP32 variants (ESP32-S3, ESP32-C3). Expand catalog entries before relying on automatic detection for other boards.
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
- `MPY Workbench: Upload Active File` — upload the current editor file
- `MPY Workbench: Select Serial Port` — pick device port
- `MPY Workbench: Open REPL Terminal` — open MicroPython REPL
- `MPY Workbench: Flash MicroPython Firmware` — flash firmware using the bundled catalog and esptool
- `MPY Workbench: Toggle workspace Auto-Sync on Save` — enable/disable workspace auto-sync
- `MPY Workbench: Toggle Code Completion` — enable/disable MicroPython code completion

## Workspace config

The extension stores per-workspace settings and manifests inside a workspace folder named `.mpy-workbench` at your project root.

- Workspace override file: `.mpy-workbench/config.json`
- Sync manifest: `.mpy-workbench/esp32sync.json`

Use the command `MicroPython WorkBench: Toggle workspace Auto-Sync on Save` to enable or disable auto-sync for the current workspace. If no workspace config exists the extension falls back to the global setting `microPythonWorkBench.autoSyncOnSave` (default: `false`).

### Local sync root directory

By default, sync operations use the workspace root directory. You can configure a different local root directory using the `microPythonWorkBench.syncLocalRoot` setting:

- **Empty (default)**: Uses the workspace root directory
- **Relative path**: e.g., `"src"` or `"micropython"` - relative to workspace root
- **Absolute path**: Full path to a directory outside the workspace

This is useful when your MicroPython project files are in a subdirectory of your workspace, or when you want to sync to a different location entirely.

**Example VS Code settings:**
```json
{
  "microPythonWorkBench.syncLocalRoot": "src/micropython"
}
```

See `example-workspace-settings.json` for a complete configuration example.

## Code Completion

The extension provides intelligent code completion for MicroPython modules using Python stub files. This feature integrates with VS Code's Pylance language server to provide IntelliSense support.

### Auto-detection

Code completion automatically enables when:
- A MicroPython project is detected (based on sync settings or project structure)
- The workspace contains MicroPython-specific files or configurations
- Manual override via command or settings

### Multi-language Support

- **English**: Default documentation language
- **Chinese**: Automatically used when VS Code language is set to Chinese
- Supports 47+ MicroPython modules with type annotations

### Configuration Options

```json
{
  "microPythonWorkBench.enableCodeCompletion": "auto",
  "microPythonWorkBench.enableMultiLanguageDocs": true
}
```

- `microPythonWorkBench.enableCodeCompletion`:
  - `"auto"` (default): Automatically enable for MicroPython projects
  - `"manual"`: Manual control via commands
  - `"forced"`: Always enabled regardless of project type
  - `"disabled"`: Completely disabled

- `microPythonWorkBench.enableMultiLanguageDocs`: Enable multi-language documentation based on VS Code locale

### Manual Control

Use `MPY Workbench: Toggle Code Completion` from the Command Palette to manually enable/disable code completion for the current workspace.

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

- **Python 3.13.2**
- **Mpremote v1.26.1**
- **Firmware flashing:** `esptool` available in the same Python environment. Install with `pip install esptool`. The extension checks `python`, `py -3` (Windows), and `esptool.py`/`esptool` on PATH.
- **Code Completion (optional):** [Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) extension for enhanced IntelliSense support
- The Python path used by the extension can be adjusted in the extension settings if a specific interpreter needs to be selected.

## Firmware flashing

- Choose a specific serial port (not `auto`), then run `MicroPython WorkBench: Flash MicroPython Firmware` from the Command Palette or Board Actions view.
- The extension detects the board, picks the matching entry from `assets/firmwareCatalog.json`, downloads the image, and runs `esptool` at 460800 baud.
- Put the board in bootloader mode first; the REPL is automatically closed during flashing to free the port.
- Add more boards by appending entries to `assets/firmwareCatalog.json` (chip, flash mode/freq, offset, download URL, and aliases).

## Next steps

- ✅ Broaden board compatibility (currently tested only with ESP32-S3 and ESP32-C3)
- 🔌 Expand the firmware catalog beyond the initial ESP32-C6 entry
- 🪟 Perform full Windows testing: validate mpremote compatibility with COM ports and ensure consistent behavior of file operations and REPL across Windows environments

## Contributing

Issues and pull requests are welcome.

## License

MIT — see the `LICENSE` file in this repository.

## Acknowledgements

- Thanks to walkline's code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython — this project provided the code completion data included in the `code_completion/` directory of this repository.
 - Thanks to walkline's code-completion-for-micropython: https://gitee.com/walkline/code-completion-for-micropython — this project provided the code completion data included in the `code_completion/` directory of this repository.
 - Thanks to the original `mpy-workbench` project by Daniel Bustillos for the initial design and implementation reference: https://github.com/DanielBustillos/mpy-workbench
