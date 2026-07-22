# Agent CLI Reference

[中文](agent-cli_zh-CN.md)

## Purpose

The Agent CLI lets another local process use the serial connection already owned by MicroPython Workbench. It connects to the extension's loopback NDJSON manager and never opens or probes the physical serial port itself.

The early `agent` entry path uses only the Python standard library. It does not import `pyserial`, prompt-toolkit, Pygments, or another TUI package.

## Invocation

From this source checkout:

```bash
python scripts/mpyrepl/__main__.py agent [global options] <command> [command options]
```

Global options must appear before the command:

| Option | Default | Meaning |
| --- | --- | --- |
| `--session PATH` | empty | Use an explicit `serial-manager.json`. |
| `--workspace PATH` | empty | Use `PATH/.mpy-workbench/serial-manager.json`. |
| `--busy wait\|reject` | `wait` | Queue with a bound or fail immediately while busy. |
| `--queue-timeout SECONDS` | `30` | Maximum wait before a queued operation starts. |
| `--timeout SECONDS` | `120` | Client operation deadline; also the execution follow timeout for `exec`. |
| `--progress` | off | Write progress JSONL for the matching transfer to stderr. |

## Session discovery

The CLI resolves the manager descriptor in this order:

1. `--session PATH`
2. `MPY_MANAGER_SESSION`
3. `--workspace PATH`
4. `.mpy-workbench/serial-manager.json`, searched from the current directory upward

The descriptor is published atomically after the manager is ready and removed when the owning manager stops. The CLI validates schema and protocol versions, requires a loopback host, authenticates with the descriptor token, and verifies the manager instance ID. Missing, invalid, stale, or incompatible descriptors fail without falling back to direct serial access.

## Commands

| Command | Arguments | Result |
| --- | --- | --- |
| `status` | none | Manager/device status, client counts, and queue state. |
| `wait-idle` | `--idle-timeout SECONDS` | Poll until no operation is active or queued. |
| `exec` | `--code SOURCE` | Execute source without host REPL instrumentation. |
| `exec-file` | `LOCAL_PATH` | Read a UTF-8/UTF-8-BOM local file and execute it. |
| `ls` | `[DEVICE_PATH]` | List a directory; defaults to `/`. |
| `tree` | `[DEVICE_PATH]` | Return a recursive tree; defaults to `/`. |
| `stat` | `[DEVICE_PATH]` | Return path metadata; defaults to `/`. |
| `get` | `DEVICE_PATH LOCAL_PATH` | Download one device file. |
| `put` | `LOCAL_PATH DEVICE_PATH` | Upload one local file. |
| `mkdir` | `DEVICE_PATH [--no-parents]` | Create a directory, including parents by default. |
| `rm` | `DEVICE_PATH --yes [--recursive]` | Remove a file or directory; confirmation is mandatory. |
| `mv` | `SOURCE_PATH TARGET_PATH` | Rename or move a device path. |
| `interrupt` | none | Send an out-of-band Ctrl-C immediately. |
| `soft-reset` | none | Queue a device soft reset. |

Examples:

```bash
python scripts/mpyrepl/__main__.py agent status
python scripts/mpyrepl/__main__.py agent --busy reject exec --code "print(1)"
python scripts/mpyrepl/__main__.py agent --queue-timeout 60 --timeout 300 exec-file mpy/main.py
python scripts/mpyrepl/__main__.py agent --progress get /sd/data.bin ./data.bin
python scripts/mpyrepl/__main__.py agent put ./main.py /sd/main.py
python scripts/mpyrepl/__main__.py agent mkdir /sd/logs
python scripts/mpyrepl/__main__.py agent rm /sd/old --recursive --yes
python scripts/mpyrepl/__main__.py agent interrupt
```

## Queue and output behavior

Execution, filesystem operations, soft reset, and completion share one manager-side serial-operation lock. The default `--busy wait` policy enters a bounded FIFO-style wait controlled by `--queue-timeout`; `--busy reject` returns a `busy` error immediately. A queued request is cancelled when its client disconnects. `interrupt` bypasses the queue so it can stop active device code.

The human REPL remains the complete live console and receives device stdout/stderr from all clients, including background-thread output. An Agent command filters manager events by its request ID and writes exactly one final JSON object to stdout, so unrelated device output cannot corrupt machine-readable output. With `--progress`, matching progress events are written as JSONL to stderr.

Success shape:

```json
{"ok":true,"result":{}}
```

Error shape:

```json
{"ok":false,"error":{"code":"busy","message":"serial manager is busy","details":{}}}
```

For failed `exec` or `exec-file`, `result` is also included so the caller can inspect device stdout and stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | Invalid arguments, missing local file, or required confirmation omitted. |
| `3` | Manager discovery, descriptor, schema, protocol, or stale-instance failure. |
| `4` | Manager busy with `--busy reject`. |
| `5` | Queue, operation, socket, or `wait-idle` timeout. |
| `6` | Manager unavailable, transport lost, or device not ready. |
| `7` | Device/filesystem error or MicroPython execution stderr. |
| `8` | Other manager RPC error. |
| `130` | Interrupted locally with Ctrl-C. |

## Security and lifecycle

- The manager binds to loopback and the CLI rejects non-loopback descriptors.
- The descriptor contains a bearer token. Keep `.mpy-workbench/` ignored and do not print, commit, or share the descriptor.
- The Agent CLI attaches only while the extension-owned manager is alive. Open Serial or Open REPL in the extension before using it.
- Disconnecting an Agent client does not close the manager or the human REPL.
- Do not start a second direct serial client against the same COM device while the manager owns it.
