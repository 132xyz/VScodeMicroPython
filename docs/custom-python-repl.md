# Custom Python REPL

[中文](custom-python-repl_zh-CN.md)

## Overview

MicroPython Workbench uses the bundled Python client under `scripts/mpyrepl` for its default board transport.

This path exists to avoid the limitations of a plain terminal running `mpremote connect`, especially:

- host-side multiline editing
- richer completion behavior
- safer Unicode output handling
- out-of-band interrupt / soft-reset control while the REPL process stays open

## Scope

`microPythonWorkBench.experimentalCustomRepl` is enabled by default. REPL, Run Active File, interrupt/reset, port listing, board file browsing, and sync use the `mpyrepl` helper path.

## Requirements

- Select a fixed serial port first. The REPL does not start with `auto`.
- Use Python 3.9 or newer for the `mpyrepl` script.
- The selected interpreter must have `pyserial` available.
If `pyserial` is missing, the extension prompts to install it into the selected Python environment before starting board operations.

Recommended installation for the shared Python environment:

```bash
python -m pip install --user pyserial
```

## How to enable it in VS Code

Enable the setting in workspace settings or user settings:

```json
{
  "microPythonWorkBench.experimentalCustomRepl": true
}
```

Recommended companion settings:

```json
{
  "microPythonWorkBench.pythonPath": "",
  "microPythonWorkBench.enableCodeCompletion": true,
  "microPythonWorkBench.serialAutoSuspend": true,
  "microPythonWorkBench.replRestoreBehavior": "openReplEmpty"
}
```

Then:

1. Run `MicroPython WorkBench: Select Serial Port`
2. Run `MicroPython WorkBench: Open REPL`
3. The extension will launch the bundled `scripts/mpyrepl/__main__.py` client

## What it adds

### 1. Host-side editing

The REPL prompt is implemented with prompt-toolkit rather than board-side line editing.

Current behavior includes:

- multiline editing
- Python syntax highlighting
- input history
- smart Enter behavior for complete / incomplete blocks
- Tab indent vs completion selection
- indentation-aware Backspace handling

### 2. Completion sources

The completer currently merges candidates from several sources:

- Python keywords
- host builtins
- a default set of common MicroPython modules
- symbols recorded from successful commands in the current REPL session
- top-level modules discovered from the active stub root
- dotted runtime completion by querying device attributes with `dir()`

This means completion quality is highest when both of these are true:

- code completion is enabled in the extension
- the current board session has already imported or defined the names you want to complete

### 3. Control-channel actions

When the custom REPL is active, the extension talks to it through a JSON control file stored under the system temp directory.

Supported control commands are:

- `interrupt`
- `soft-reset`
- `interrupt-reset`
- `exit`
- `exec`
- `fs`

This is how extension commands such as interrupt, stop, close, Run Active File, and file operations can affect the still-running REPL process without killing the whole terminal first.

### 4. Unicode handling

The Python client incrementally decodes REPL output and uses a Unicode-safe stream write fallback when the host console encoding cannot represent the decoded text.

That makes the custom REPL more robust on hosts where direct console output can still fail, especially older Windows console code-page setups.

## Key controls inside the REPL

- `Ctrl-D`: request a soft reset
- `Ctrl-X`: exit the prompt
- `Ctrl-]`: exit the prompt
- `:q`, `:quit`, `:exit`: exit on a single-line meta command
- `Ctrl-C`: forwarded to the device as an interrupt when possible

## Interaction with auto-suspend and restore

The custom REPL integrates with the same extension-level suspend/restore flow as the default REPL.

If `microPythonWorkBench.serialAutoSuspend` is enabled:

- sync operations close the REPL before using the serial port
- the extension restores the REPL after the operation when appropriate
- `microPythonWorkBench.replRestoreBehavior` still decides whether the restored REPL stays empty, soft-resets, or re-imports the changed file

## Manual CLI usage from a source checkout

You can also run the client directly while developing the repository:

```bash
python scripts/mpyrepl/__main__.py --port COM4 async-repl
```

With an explicit stub root:

```bash
python scripts/mpyrepl/__main__.py --port COM4 async-repl --stub-root .mpy-workbench/pyi
```

Useful options include:

- `--baudrate`
- `--follow-timeout`
- `--control-file`
- `--dir-query-timeout`

## Current limitations

- Runtime dotted completion depends on live device state and may time out.
- A raw REPL session owns the serial port; file operations are routed through its control channel when it is active.
- If the chosen interpreter is older than Python 3.9 or lacks `pyserial`, startup will fail.

## Troubleshooting

### REPL does not start

Check:

- a fixed serial port is selected
- `microPythonWorkBench.pythonPath` points to a valid Python interpreter
- that interpreter can import `serial`

### Completion is too limited

Check:

- `microPythonWorkBench.enableCodeCompletion` is enabled
- a stub package is installed and selected
- the current REPL session has already imported the target module or created the expected symbols

### Interrupt or soft reset feels delayed

The client serializes protocol operations through an internal gate. If a blocking execution is in progress, the requested action may be applied right after the active operation yields control.

### Windows terminal output is still problematic

If the problem is inside the extension REPL terminal, prefer the custom REPL path.

If the problem is an external shell running `python -m mpremote ...`, that remains an upstream `mpremote` / terminal path issue. See [mpremote-windows-utf8.md](mpremote-windows-utf8.md) for the current project notes.
