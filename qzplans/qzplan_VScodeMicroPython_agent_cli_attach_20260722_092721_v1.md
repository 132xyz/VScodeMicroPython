# VScodeMicroPython Agent CLI Attach Plan

Created: 2026-07-22
Status: Implementation complete

## 0. Confirmed Implementation Decisions

- The agent command path uses only the Python standard library. It does not import the bundled `prompt_toolkit`, `pygments`, or any TUI framework.
- The manager publishes `.mpy-workbench/serial-manager.json`; discovery never scans TCP ports and never falls back to opening the physical COM port.
- `manager.hello` registers `extension`, `repl`, and `agent` clients. Run Active File waits for `replClientCount`, not the total client count.
- Human REPL clients continue receiving all device stdout/stderr, including output caused by extension and agent requests. Agent clients use request results by default so unrelated output cannot corrupt JSON output.
- Agent operations support server-side bounded waiting. `queuePolicy=wait` uses a finite queue timeout; `queuePolicy=reject` remains available for immediate failure.
- The first implementation reuses the existing serial transport and operation gate. Idle background-output capture is added only if it can share serial read ownership without racing raw REPL and filesystem parsers.
- The extension version is incremented once, the VSIX may be packaged for verification, and it must not be installed or substituted automatically.

## 1. Goals And Boundaries

### Goals

- Allow a command-line process to reuse the serial connection already owned by the VS Code extension.
- Provide stable, non-interactive, JSON-oriented commands suitable for another LLM agent.
- Keep the existing interactive REPL, file tree, sync, and Run Active File workflows working while an agent client connects briefly.
- Make busy state, timeout, cancellation, and device-side errors deterministic enough for automation.

### Non-goals

- Do not allow a second process to open the physical COM port directly.
- Do not expose the manager outside loopback networking.
- Do not add remote network access, telemetry, or an unattended auto-reconnect loop.
- Do not make the manager token a public or committed workspace setting.
- Do not install or replace the VS Code extension during implementation.

### Success Criteria

- With the extension connected to a board, a shell command can discover the active manager without copying an endpoint/token from the REPL terminal.
- The agent can query status, execute code, list/read/write board files, create/remove/rename paths, interrupt, and soft reset through the existing manager.
- Commands produce one machine-readable final JSON result and meaningful exit codes.
- A connected agent cannot be mistaken for the interactive REPL client.
- A timed-out or disconnected queued request does not execute unexpectedly later.

## 2. Current Architecture

### Serial Ownership

- `src/board/serialManagerProcess.ts` starts one hidden Python `manager` process.
- The manager exclusively owns the serial port through `SerialReplTransport`.
- `src/board/serialManager.ts` keeps the manager endpoint and random token only in extension-host memory.
- `src/board/serialManagerClient.ts` connects to the manager over loopback NDJSON RPC.
- `scripts/mpyrepl/repl_client.py` is a second client used by the interactive VS Code terminal.

### Existing Multi-client Capability

- `scripts/mpyrepl/manager_server.py` accepts multiple TCP clients.
- `scripts/mpyrepl/operation_gate.py` serializes raw-REPL and filesystem operations on one transport.
- `manager.status` and `manager.ping` can run while another serial operation is active.
- `device.interrupt` and `manager.cancel` intentionally bypass normal queued work so a running operation can be interrupted.

### Existing RPC Methods

- Manager: `manager.ping`, `manager.status`, `manager.shutdown`, `manager.cancel`.
- Device: `device.interrupt`, `device.softReset`.
- REPL: `repl.exec`, `repl.complete`, `repl.clearRuntimeCache`.
- Filesystem: `fs.stat`, `fs.listdir`, `fs.tree`, `fs.mkdir`, `fs.remove`, `fs.rename`, `fs.readFile`, `fs.writeFile`, `fs.exec`.

### Existing CLI Limitation

- `repl-client` can attach to a running manager only when `--endpoint` and `--token` are already known.
- `exec`, `fs`, `interrupt`, and `soft-reset` open the COM port directly and therefore conflict with an extension-owned manager.
- No current command discovers the extension manager or performs one non-interactive manager RPC.
- The legacy `async-repl --control-file` path is not the active manager/repl-client path and should not be reused for the new interface.

## 3. Findings And Risks

### Endpoint Discovery Is Missing

- The port is OS-assigned and the token is randomly generated for each manager process.
- The ready payload is consumed from child stdout and then retained only in TypeScript memory.
- Copying the full `repl-client` command from a terminal is technically possible but unsuitable for an autonomous agent and exposes the token in shell history.

### Client Identity Is Missing

- `clientCount` includes every TCP client.
- `waitForReplClientReady()` currently treats `clientCount >= 2` as proof that the interactive REPL connected.
- A persistent or briefly connected agent can create a false positive and reintroduce Run Active File startup races.

### Queued Requests Are Unsafe For Automation

- Serial calls wait on a thread lock and are not rejected when busy.
- If an agent times out or disconnects while its request waits, the server task can remain queued and execute the operation later.
- Cancellation is global and can interrupt another client's active operation.

### Events Are Broadcast And Not Request-scoped

- `stdout`, `stderr`, `execution`, and progress events are sent to all clients.
- Request IDs are chosen independently by each client, so they are not globally unique.
- A machine client cannot safely attribute every streamed event when other clients are active.
- Final RPC results are request-scoped and can be used safely if agent execution disables streaming.

### Shared Device State

- All clients operate in the same MicroPython `__main__` namespace.
- Agent imports and assignments can affect the human REPL, and vice versa.
- File writes, remove, interrupt, reset, and arbitrary code execution are destructive capabilities.

### Security

- The manager binds to `127.0.0.1`, which limits network exposure.
- Possession of the current token grants all methods, including shutdown and arbitrary device code.
- A descriptor containing the token must be ignored by Git, written atomically, restricted to the current user where supported, never logged, and removed on normal shutdown.

## 4. Recommended Design

### 4.1 Workspace Session Descriptor

Create `.mpy-workbench/serial-manager.json` for the active workspace after the manager is ready.

Suggested fields:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "extensionVersion": "0.4.x",
  "device": "COM7",
  "host": "127.0.0.1",
  "port": 50000,
  "token": "<secret>",
  "managerPid": 1234,
  "scriptPath": "<installed extension>/scripts/mpyrepl/__main__.py",
  "createdAt": "2026-07-22T00:00:00Z"
}
```

- Write through a temporary file and atomic rename.
- On POSIX, set mode `0600`; on Windows, rely on the user-profile/workspace ACL and document the limitation.
- Delete only a descriptor that still matches the manager token/PID being closed.
- The CLI must ping and validate every descriptor; stale files are never trusted as proof of a live session.

### 4.2 Client Registration

Add `manager.hello` or equivalent registration with roles:

- `extension`: the long-lived TypeScript client.
- `repl`: the interactive prompt client.
- `agent`: one-shot or interactive command-line automation.

Extend status with `replClientCount` and `agentClientCount`. Keep `clientCount` for compatibility. Change Run Active File readiness checks to `replClientCount >= 1`.

Role labels are routing/diagnostic metadata, not a security boundary.

### 4.3 Agent CLI

Add a dedicated command group that never opens the COM port:

```text
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json status
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json exec --code "print(machine.freq())"
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json exec-file local.py
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json ls /sd
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json get /sd/a.txt local/a.txt
python scripts/mpyrepl/__main__.py agent --session .mpy-workbench/serial-manager.json put local/a.txt /sd/a.txt
```

Recommended commands:

- `status`, `wait-idle`.
- `exec`, `exec-file`.
- `ls`, `tree`, `stat`, `get`, `put`, `mkdir`, `rm`, `mv`.
- `interrupt`, `soft-reset`.
- Optional `repl` alias for an additional interactive manager-backed prompt.

Do not expose `manager.shutdown` as a normal agent subcommand.

### 4.4 Machine-readable Contract

- Emit exactly one final JSON object to stdout.
- Send diagnostics and optional progress JSONL to stderr, or guard progress behind `--progress`.
- Use stable exit codes for success, usage/discovery failure, busy, timeout, transport loss, device stderr, and RPC failure.
- `exec` should default to `instrument: false` and should return nonzero when device stderr contains a traceback.
- Add `--timeout` and `--wait` explicitly; do not silently wait forever.

### 4.5 Busy And Cancellation Semantics

Preferred implementation:

- Add a manager-level request scheduler with request IDs and an explicit busy policy.
- Agent operations default to bounded waiting with a 30-second queue timeout; `queuePolicy: "reject"` remains available.
- Human extension/REPL operations can keep their current waiting behavior where required.
- A queued operation must be cancellable when its client disconnects or its deadline expires.
- Interrupt/reset remain explicit global operations and the CLI should label them as such.

A status preflight alone is insufficient because it has a race between checking `busy` and acquiring the operation slot.

### 4.6 Event Isolation

- Add a server-generated connection/request identity.
- Keep device stdout/stderr visible to every human REPL client, including output produced by extension or agent requests.
- Agent clients ignore broadcast stdout/stderr and consume their request-scoped final response; matching transfer progress is filtered by operation ID.
- Keep connection status broadcasts global.

## 9. Implementation Result

- Added protocol versioning, `manager.hello`, client role counts, bounded manager-side queue waits, and manager instance validation.
- Added atomic workspace descriptor publication and cleanup, plus extension reattachment to a still-running manager after extension-host restart.
- Added the standard-library-only `agent` CLI with status, wait, execution, filesystem, interrupt, and reset commands.
- Preserved global human REPL output and added gated idle output capture for device background threads.
- Updated English/Chinese documentation and bumped the extension to `0.4.30`.
- Verified through `build.ps1`: 187 Python tests with 84.2% local coverage, 110 Jest tests, TypeScript compilation, automatic patch versioning, and release-directory VSIX packaging.

## 5. Expected Files

### Python Manager And CLI

- `scripts/mpyrepl/cli.py`: agent command parser.
- `scripts/mpyrepl/__main__.py`: agent command dispatch.
- `scripts/mpyrepl/manager_protocol.py`: protocol/capability version and request metadata if needed.
- `scripts/mpyrepl/manager_server.py`: client registration, role counts, busy policy, event routing.
- `scripts/mpyrepl/manager_session.py`: non-streaming execution and scheduler integration.
- `scripts/mpyrepl/repl_client.py`: register the `repl` role.
- New candidate `scripts/mpyrepl/agent_client.py`: descriptor loading, RPC calls, JSON output, exit-code mapping.

### Extension

- `src/board/serialManagerProcess.ts`: expose child PID and manager metadata.
- `src/board/serialManager.ts`: register `extension`, publish/remove descriptor.
- `src/board/serialManagerClient.ts`: hello metadata and request options if needed.
- `src/board/serialManagerTypes.ts`: descriptor, role, status, protocol types.
- `src/board/mpremoteCommands.ts`: use `replClientCount` for readiness.
- `src/core/extension.ts`: provide workspace/runtime context for descriptor lifecycle.

### Tests And Docs

- `scripts/mpyrepl/test_manager_server.py`.
- `scripts/mpyrepl/test_manager_session.py`.
- New candidate `scripts/mpyrepl/test_agent_client.py`.
- `tests/serialManagerClient.test.ts`.
- `tests/serialManagerProcess.test.ts`.
- `tests/boardMpremoteCommandsCoverage.test.ts`.
- `docs/custom-python-repl.md` and `docs/custom-python-repl_zh-CN.md`.
- `README.md` for the supported agent CLI entry point.

## 6. Phased Implementation

### Phase 1: Protocol Identity And Descriptor

- Add protocol version/capability response and client roles.
- Publish and clean the ignored workspace descriptor.
- Replace `clientCount >= 2` readiness inference with `replClientCount`.
- Verify multiple clients do not change existing REPL startup behavior.

Completion standard: a shell can discover and ping the manager without copying a token, while Run Active File still waits for the real REPL client.

### Phase 2: Read-only Agent CLI

- Implement descriptor validation, `status`, `wait-idle`, `stat`, `ls`, and `tree`.
- Establish JSON output and exit-code contract.
- Reject stale descriptors and protocol mismatches.

Completion standard: an LLM agent can inspect board state without opening the serial port or affecting the interactive REPL.

### Phase 3: Mutating And Execution Commands

- Add `exec`, `exec-file`, `get`, `put`, `mkdir`, `rm`, `mv`, interrupt, and soft reset.
- Add non-streaming execution and device-stderr failure mapping.
- Add confirmation requirements or explicit flags for destructive commands where appropriate.

Completion standard: agent operations are scriptable and return deterministic machine-readable results.

### Phase 4: Busy Safety And Event Routing

- Implement atomic busy rejection/deadlines and disconnect-aware cancellation.
- Scope operation events to the requester or assign globally unique operation IDs.
- Test simultaneous REPL, file transfer, completion, and agent requests.

Completion standard: no timed-out agent request executes later, and one client's output is not misattributed to another.

## 7. Validation Plan

### Automated

```powershell
npm run compile
npm test -- --runInBand
C:\qzrobot\mpy\.venv\Scripts\python.exe scripts/mpyrepl/run_python_tests_with_coverage.py
```

Add tests for:

- Descriptor creation, atomic replacement, stale validation, and cleanup.
- Role registration and accurate role counts with multiple clients.
- Agent connection while the interactive REPL is starting.
- Busy rejection without delayed execution.
- Client disconnect/timeout before an operation starts.
- Request-scoped stdout/stderr/progress.
- Structured JSON and exit codes for every agent command.
- Authentication and protocol-version mismatch.

### Hardware

- Connect the extension to the board and keep the interactive REPL open.
- Run read-only CLI commands repeatedly from a separate terminal.
- Execute short code from the agent and verify the human REPL remains usable.
- Run upload/download through the agent and compare hashes.
- Start a long REPL task, confirm agent default behavior returns `busy`, then interrupt explicitly and verify state recovery.
- Unplug/replug USB and verify the descriptor reports stopped/stale correctly without another process opening the COM port.

## 8. Risks And Constraints

- Never allow the agent CLI to fall back to direct serial access when descriptor attachment fails.
- Never print or log the manager token.
- Never commit the runtime descriptor.
- Preserve the current single physical serial owner.
- Preserve REPL helper globals, completion cache behavior, and file transfer performance.
- Treat remove, overwrite, reset, interrupt, and arbitrary execution as destructive agent capabilities.
- Do not solve concurrency only with `manager.status` preflight; the check/acquire race remains.
- Do not install a generated VSIX automatically.
