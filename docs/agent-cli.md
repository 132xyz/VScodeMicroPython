# Agent CLI Reference

[中文](agent-cli_zh-CN.md)

## Purpose

The Agent CLI lets another local process use the shared MicroPython Workbench serial manager. It can attach to an extension-started manager or cold-start a background manager with `connect`. Only the manager process opens the physical serial port; the Agent client never claims it directly through pyserial.

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
| `--timeout SECONDS` | `120` | Client operation wait; also the output follow timeout for `exec` and the shared reset-protocol deadline for `soft-reset`. |
| `--progress` | off | Write progress JSONL for the matching transfer to stderr. |

## Session discovery

The CLI resolves the manager descriptor in this order:

1. `--session PATH`
2. `MPY_MANAGER_SESSION`
3. `--workspace PATH`
4. `.mpy-workbench/serial-manager.json`, searched from the current directory upward

The extension or manager publishes the descriptor atomically after startup and removes it conditionally by token and instance ID when the manager exits. The CLI validates schema and protocol versions, requires a loopback host, authenticates with the descriptor token, and verifies the manager instance ID.

For commands other than `connect`, a missing, invalid, stale, or incompatible descriptor is an error. `connect` cold-starts a background manager when no descriptor exists or its endpoint is confirmed unreachable. With `--workspace` it publishes into that workspace; otherwise it uses the current directory. It never falls back to the legacy direct-serial commands.

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
| `connect` | `PORT [--baudrate N]` | Connect or switch to a selected serial port; cold-start a manager when needed. |
| `disconnect` | none | Release the physical serial port while keeping the manager and descriptor alive. |
| `reconnect` | none | Release and reopen the manager-owned serial port; `--timeout` bounds the wait. |
| `shutdown` | none | Stop the shared manager; this disconnects the human REPL and other Agents. |
| `soft-reset` | none | Queue a soft reset and wait for the new raw prompt and helper. |

Examples:

```bash
python scripts/mpyrepl/__main__.py agent --workspace C:\qzrobot\mpy --timeout 20 connect COM5 --baudrate 115200
python scripts/mpyrepl/__main__.py agent status
python scripts/mpyrepl/__main__.py agent --busy reject exec --code "print(1)"
python scripts/mpyrepl/__main__.py agent --queue-timeout 60 --timeout 300 exec-file mpy/main.py
python scripts/mpyrepl/__main__.py agent --progress get /sd/data.bin ./data.bin
python scripts/mpyrepl/__main__.py agent put ./main.py /sd/main.py
python scripts/mpyrepl/__main__.py agent mkdir /sd/logs
python scripts/mpyrepl/__main__.py agent rm /sd/old --recursive --yes
python scripts/mpyrepl/__main__.py agent interrupt
python scripts/mpyrepl/__main__.py agent disconnect
python scripts/mpyrepl/__main__.py agent --timeout 20 reconnect
python scripts/mpyrepl/__main__.py agent shutdown
```

## File transfer format

The fast file-transfer paths use continuous stdio streams, but the payload remains Base64-encoded rather than an unencoded binary protocol. When the device supports `stdin.buffer.readinto`, uploads start one receiver that reads encoded data, decodes it, and writes the file. Downloads start one sender that reads file chunks and continuously emits Base64 records. Neither streaming path executes a new REPL command for every chunk; uploads retain their existing per-chunk compatibility fallback when stdin streaming is unavailable.

Download Base64 is ASCII, so the sender uses text `sys.stdout.write()`. This avoids binary `stdout.buffer.write()` retrying bytes already sent to the primary serial output when a `dupterm` mirror short-writes. Files are still read and saved as binary; text handling applies only to transfer records, not file bytes or line endings. A full WebREPL mirror buffer is not guaranteed to display every byte of transfer output.

Start/end markers, final size checks, and byte progress remain unchanged. Downloads write to a `.mpydownload` temporary file and replace the local target only after validation succeeds. Failures preserve an existing target and remove the temporary file.

Internal records are additionally framed with a per-operation nonce and byte length. Download data records include block index and decoded size; completion verifies a device SHA-256 against the host's digest before replacement. The firmware must provide `hashlib.sha256` or `uhashlib.sha256`. Background text outside those frames goes to the human console. Interleaved/corrupt records fail validation instead of becoming file bytes. Streaming and the existing temporary-target protections are retained.

An already-running manager does not reload its Python code when the extension is upgraded. Before validating a fix, confirm that the attached manager was launched from the new version. Coordinate with all shared clients before ending an old manager; do not interrupt a device session that is in use.

## Soft reset and REPL recovery

`soft-reset` sends Ctrl-D only once. The pre-reset raw prompt, `soft reboot` marker, post-reset raw banner, and actual `>` prompt share the full `--timeout` deadline. A 100ms gap during startup does not end the wait early. Human REPL and extension requests without an override retain the manager's default protocol deadline, normally 10 seconds. Success remains `{"ok":true,"result":true}` and includes helper reinjection.

The CLI forwards milliseconds through the optional `softResetTimeoutMs` parameter of `device.softReset`, which must be a positive finite number. Omitting it retains the manager configuration. This bounds the reset protocol; queueing and helper initialization add separate waiting overhead.

If synchronization still fails within that deadline, the command returns `repl_sync_timeout` (exit code 5) without closing the serial handle. Error `details` contains:

- `resetSent`: whether this protocol attempt sent Ctrl-D.
- `resetObserved`: whether the `soft reboot` marker was received. This does not prove final REPL readiness.
- `replReady`: `false`, indicating that protocol synchronization is required.

`status.state` still describes the retained serial connection, for example `ready`, while the new `status.replReady=false` signals that raw protocol operations cannot start directly. The next execution, filesystem, or completion command uses the same manager and serial handle to restore raw REPL with Ctrl-C/Ctrl-A and reinject the helper, without another Ctrl-D. `status` itself is read-only and does not trigger recovery. Actual serial I/O failure still returns `transport_lost`, closes the invalid handle, and enters `stopped`.

Do not blindly retry `soft-reset` after a synchronization timeout: the first Ctrl-D may already have taken effect. In particular, `resetSent=true` with `resetObserved=false` leaves the reset outcome uncertain. Use the next normal command to restore REPL first. The human REPL remains open and does not receive a disconnected status for this protocol error.

Execution and filesystem commands also return `repl_sync_timeout` when raw stdout/stderr EOF is missing, keeping the existing serial handle. This indicates protocol uncertainty, not confirmed physical disconnection. The failed operation is not automatically replayed. The next active command may interrupt unfinished device code with Ctrl-C while restoring REPL, so inspect the operation's effects before retrying writes or other side effects. `ls` reads one directory; explicit `tree` still scans recursively and can take longer on a large or slow filesystem.

## Queue and output behavior

Execution, filesystem operations, connect, disconnect, reconnect, soft reset, and completion share one manager-side serial-operation lock. The default `--busy wait` policy enters a bounded FIFO-style wait controlled by `--queue-timeout`; `--busy reject` returns a `busy` error immediately. A queued request is cancelled when its client disconnects. `interrupt` bypasses the queue so it can stop active device code.

New managers advertise `request-cancel` and `ordered-output` capabilities. `request.cancel` takes `requestId` on the same authenticated connection: queued requests are removed without device input, and a running request can interrupt only its own serial operation. The operation lock is retained until the interrupt send completes. Clients use this on local timeout only when the capability is advertised; no global interrupt fallback is used for old managers. Cancellation is a request to stop, not a rollback of device-side effects.

Status may include `activeOperation` with client ID, request ID, method, phase, and elapsed milliseconds. Event `sequence` identifies manager stream ordering. These IDs identify the active host operation, not the originating device thread. CLI waits use a monotonic deadline even when events continue arriving. Extension filesystem requests use a 2-second queue budget and a bounded device-operation budget; timing out a view does not restart the shared owner.

After `machine.reset()` or USB serial re-enumeration, the manager may temporarily enter `stopped`. `reconnect` releases the manager's stale serial handle, retries the same configured port for up to `--timeout`, then enters raw REPL and injects the helper again. The existing manager owns the entire sequence; the Agent never opens COM directly and does not need to automate the VS Code UI.

Use `connect NEW_PORT` when the device re-enumerates under a different COM number. `disconnect` releases only the serial port and leaves the endpoint available; `shutdown` stops the manager. Cold-start diagnostics are written to `.mpy-workbench/serial-manager-startup.log`; the ready token is not written to that log.

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
| `5` | Queue, operation, REPL synchronization, socket, or `wait-idle` timeout. |
| `6` | Manager unavailable, transport lost, or device not ready. |
| `7` | Device/filesystem error or MicroPython execution stderr. |
| `8` | Other manager RPC error. |
| `130` | Interrupted locally with Ctrl-C. |

## Security and lifecycle

- The manager binds to loopback and the CLI rejects non-loopback descriptors.
- The descriptor contains a bearer token. Keep `.mpy-workbench/` ignored and do not print, commit, or share the descriptor.
- `connect` can create a background manager before the extension opens a serial connection; the extension can later attach through the same descriptor.
- Disconnecting an Agent client does not close the manager or the human REPL.
- `shutdown` is an explicit global lifecycle action that closes the shared manager and all of its clients.
- Do not start a second direct serial client against the same COM device while the manager owns it.
