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

REPL, Run Active File, interrupt/reset, port listing, board file browsing, and sync use the bundled `mpyrepl` helper path. There is no separate opt-in setting for the old experimental REPL path.

## Package layout

`scripts/mpyrepl/__main__.py` is the stable entry used by the extension and direct CLI calls. It configures the package path, routes `agent` before loading serial or TUI dependencies, and delegates all other commands to `app.py`.

Runtime code is grouped by responsibility:

- `clients/`: human REPL and standard-library-only Agent clients
- `manager/`: NDJSON protocol, server, queueing, and shared device session
- `runtime/`: serial transport, filesystem operations, models, decoding, and operation gate
- `completion/`: parser, stub index, session symbols, fallback candidates, and device queries
- `repl/`: prompt session, editor behavior, semantics, legacy control channel, and async runner
- `tests/`: Python unit tests, test requirements, and recursive coverage runner

Internal imports use the single `mpyrepl.*` package identity. `_vendor/` remains isolated and is added only by bootstrap for interactive paths that need prompt-toolkit and Pygments.

## Requirements

- Select a fixed serial port first. The REPL does not start with `auto`.
- Use Python 3.9 or newer for the `mpyrepl` script.
- The selected interpreter must have `pyserial` available.
If `pyserial` is missing, the extension prompts to install it into the selected Python environment before starting board operations.

Recommended installation for the shared Python environment:

```bash
python -m pip install --user pyserial
```

## How to use it in VS Code

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

Stub-backed function and constructor completions include parameter details from `.pyi` files when available, such as `bpp: int = 3` and `timing: int = 1` in the completion menu.

For objects already imported or defined in the current session, the REPL merges and caches one device `dir()` result. Stubs continue to provide signatures and type details, while the device result adds custom-firmware members that the generic stub does not declare.

This means completion quality is highest when both of these are true:

- code completion is enabled in the extension
- the current board session has already imported or defined the names you want to complete

### 3. Shared serial manager

After the extension connects, a hidden manager process exclusively owns the physical serial port. VS Code, the human REPL, and agent CLI clients use local NDJSON RPC connections to that manager instead of opening the COM port independently. The manager serializes execution and filesystem work while keeping interrupt available out of band.

The human REPL continuously drains manager events on a background reader, so device stdout/stderr appears while the prompt is idle without waiting for another input or completion request. Prompt-toolkit redraws the current editable input above the live output. This includes output caused by Agent commands and device background threads. One-shot Agent commands consume only their own final RPC result by default, so unrelated output cannot corrupt their JSON response.

### 4. Unicode handling

The Python client incrementally decodes REPL output and uses a Unicode-safe stream write fallback when the host console encoding cannot represent the decoded text.

That makes the custom REPL more robust on hosts where direct console output can still fail, especially older Windows console code-page setups.

### 5. Failure and diagnostics behavior

Device-side exceptions are treated as normal REPL output. A traceback from code running on the board is printed and the prompt remains open for the next command.

While protocol operations are idle, the serial manager probes the device connection. If the USB serial device is removed or the driver reports a `ReadFile`, `WriteFile`, or `ClearCommError` failure, the extension marks the serial connection as closed and disposes the invalid REPL terminal. Reconnect the device, then run Open Serial or Open REPL again.

If the host-side REPL client itself crashes or exits with a non-zero code, VS Code keeps the terminal open instead of closing it automatically. The terminal should contain the Python traceback and a short `mpyrepl` diagnostic line.

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
- `--control-file` for the legacy standalone async-REPL control path
- `--dir-query-timeout`

## Agent CLI attachment

After the manager becomes ready, the extension or manager atomically publishes `.mpy-workbench/serial-manager.json` in the workspace. Agent commands search upward from the current directory, or accept `--workspace`, `--session`, or `MPY_MANAGER_SESSION`. Except for `connect PORT`, which can cold-start a manager when no session exists, an invalid descriptor is an error. The agent path never falls back to opening the serial port directly.

The agent path uses only the Python standard library and does not load prompt-toolkit, Pygments, or another TUI dependency. Common commands:

```bash
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 connect COM5
python scripts/mpyrepl/__main__.py agent status
python scripts/mpyrepl/__main__.py agent exec --code "print(1)"
python scripts/mpyrepl/__main__.py agent exec-file mpy/test.py
python scripts/mpyrepl/__main__.py agent ls /sd
python scripts/mpyrepl/__main__.py agent get /sd/main.py ./main.py
python scripts/mpyrepl/__main__.py agent put ./main.py /sd/main.py
python scripts/mpyrepl/__main__.py agent rm /sd/old.py --yes
python scripts/mpyrepl/__main__.py agent disconnect
python scripts/mpyrepl/__main__.py agent --timeout 20 reconnect
python scripts/mpyrepl/__main__.py agent shutdown
```

`--busy wait` uses the manager's bounded queue by default, `--queue-timeout 30` limits how long a command may wait to start, and `--busy reject` fails immediately while busy. `--timeout` applies after the operation starts. Stdout contains exactly one final JSON object. With `--progress`, matching transfer progress JSONL is written to stderr.

See [agent-cli.md](agent-cli.md) for discovery precedence, every command and option, JSON contracts, exit codes, and security constraints.

## Current limitations

- Runtime dotted completion depends on live device state and may time out.
- A raw REPL session owns the serial port; file operations are routed through its control channel when it is active.
- The session descriptor contains a manager token intended only for local processes. Keep `.mpy-workbench/` ignored and never copy the token into logs or version control.
- If the chosen interpreter is older than Python 3.9 or lacks `pyserial`, startup will fail.

## Troubleshooting

### REPL does not start

Check:

- a fixed serial port is selected
- `microPythonWorkBench.pythonPath` points to a valid Python interpreter
- that interpreter can import `serial`

### REPL terminal stays open after an error

This is intentional when the host-side `mpyrepl` process exits with a non-zero code. Read the traceback and diagnostic line left in the terminal, then close or reopen the REPL from the Workbench actions when finished.

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
