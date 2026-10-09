# Letta Runtime Reference (`runtime: letta`)

Version: 1 (v1 transport: headless Letta Code stream-json)
Last validated against code: 2026-10-09, on the `letta-runtime` branch at `c529f98b` (on top of 0.6.7 `2caac7dd`)
Source of truth: `packages/daemon/src/adapters/letta-runtime-adapter.ts`, `packages/daemon/src/adapters/letta-runner.ts`, `packages/daemon/src/adapters/letta-runner-protocol.ts`, `packages/daemon/src/startup.ts`, `packages/daemon/src/domain/profile-resolver.ts`, `packages/daemon/src/domain/resume-token-validation.ts`

`runtime: letta` runs a [Letta](https://www.letta.com/) agent as an OpenRig seat. A Letta agent is
stateful: its memory, model and conversations live in a Letta backend, not in the seat. The seat binds
to an agent that already exists and opens a conversation with it; OpenRig addresses, stamps and
supervises that conversation like any other seat, and the agent replies to other seats with `rig send`.

---

## How it runs

Like Pi and OMP, Letta is RPC-first. OpenRig types its own runner into the seat's tmux pane:

```
node <daemon dist>/adapters/letta-runner.js --session-name … --permission-mode … --agent <agent_id>
```

The runner starts headless Letta Code as a child process:

```
letta -p --input-format stream-json --output-format stream-json --permission-mode <mode> --no-mods …
```

- **Pane input:** each block typed or delivered into the pane (`rig send`, startup `send_text`, a person
  typing) becomes one stream-json user turn. `/abort` interrupts the turn in flight.
- **Pane output:** the runner mirrors the agent's reply, tool calls and errors as readable lines. Lines
  it writes itself start with `[letta-runner]`; `[letta-runner] READY agent=… conversation=… model=…`
  marks a verified start.
- **Sidecar:** `$OPENRIG_HOME/state/letta/<session>/runner-state.json` records readiness, the agent
  and conversation from Letta's `system/init` record, the model, any attention code, and the exit.
  Readiness and the resume token come from this file and the runner's own markers, never from Letta's UI
  text.
- **Activity:** the runner posts turn start, tool use, stop and attention events to the daemon, plus a
  session-identity event carrying the resume token.

The same state directory holds `agent-binding.json` (the seat's binding, copied at projection) and
`pending-guidance.json` (guidance waiting to be sent as a first turn). It never holds a Letta backend.

---

## Install prerequisites

On the machine (and in the shell) where the seats run:

- **Letta Code** (`npm install -g @letta-ai/letta-code`), with `letta` on the `PATH` the seat's pane
  sees. Preflight does not probe `letta --version`; a missing binary shows up at launch as a runner
  error in the pane.
- **On a bare Ubuntu**, install `build-essential` and `python3` first: Letta Code depends on `node-pty`,
  which compiles a native module during install.
- **A backend that holds the agent.** For a local backend, run `letta backend local` (a fresh install
  in WSL was seen to target Letta Cloud instead, where local provider setup fails with 401).
  Connect a model provider in that backend. Provider logins are stored per backend folder, so a
  provider connected in one `LETTA_LOCAL_BACKEND_DIR` is not visible from another.
- **An agent to bind.** Create it with Letta Code and note its `agent-…` id. Prefer an agent made for
  the seat: a bound seat opens a new conversation, but it shares the agent's memory blocks.

Exercised live: Letta Code 0.34.8 on WSL Ubuntu (bind, startup guidance, `rig send` in both directions
with a Claude Code seat). The stream-json shape was also probed with 0.33.2 on Windows. The runner reads
no CLI version (Letta's `system/init` does not carry one); if `system/init` lacks a field this runner
expects, it says so as an advisory (see [Readiness](#readiness-and-attention)) and still starts.

---

## Binding a seat

A seat's agent is declared in its AgentSpec as a runtime resource of type `letta_agent_binding`.

`agents/letta-peer/agent.yaml`:

```yaml
name: letta-peer
version: "1.0"

resources:
  runtime_resources:
    - id: letta-agent
      path: letta-agent.json
      runtime: letta
      type: letta_agent_binding

profiles:
  default:
    uses:
      runtime_resources: [letta-agent]
```

`agents/letta-peer/letta-agent.json` is a JSON object with exactly one of:

| Field | Meaning |
|-------|---------|
| `"agent_id": "agent-…"` | **Bind** (the normal case). The existing agent opens a new conversation, so the seat never takes over the agent's other conversations. |
| `"create_agent": true` | **Create.** Letta creates a new, disposable agent at launch. The literal `true` is the explicit opt-in; the member's `model` applies only here. |

```json
{ "agent_id": "agent-0a1b2c3d-4e5f-6789-abcd-ef0123456789" }
```

Any other combination is refused at projection, and so is a `permission_mode` field: the seat's
permission posture comes from its permission policy (see [Permissions](#permissions)). A fresh launch
without a binding is refused before anything is typed into the pane.

`rig.yaml`, with a Claude Code seat beside the Letta seat:

```yaml
version: "0.2"
name: bridge

pods:
  - id: dev
    label: Development
    members:
      - id: claude
        agent_ref: "local:agents/implementer"   # any Claude Code AgentSpec
        profile: default
        runtime: claude-code
        cwd: "."
      - id: peer
        agent_ref: "local:agents/letta-peer"
        profile: default
        runtime: letta
        cwd: "."
        permission_policy: builtin:yolo
    edges: []

edges: []
```

### Bind, create and resume

| Launch | Letta Code arguments | Notes |
|--------|----------------------|-------|
| Fresh, bind | `--agent <agent_id> --new` | A new conversation on the bound agent. The agent's model is never changed. |
| Fresh, create | `--new-agent [--model <member model>]` | Only with `"create_agent": true`. |
| Resume | `--conversation <conversation_id>` alone | Letta Code exits when `--agent` and `--conversation` are both given; the runner checks the agent from `system/init` instead. |

The resume token type is `letta_conversation` and the token is `<agent_id>/<conversation_id>`. Resume
needs no binding: the token carries the conversation. If the conversation or agent can no longer be
opened, the launch returns `retry_fresh` rather than silently starting a new conversation. A runner
that comes up on a different agent or conversation than requested is refused (`letta_identity_mismatch`).

**Fork is refused in v1.** The headless transport has no conversation fork, and a Letta fork would share
the parent agent's memory anyway. `session_source: fork` on a letta member fails at launch.

---

## Permissions

The seat's permission posture comes from its permission policy, member-level or rig-level, as for
every other runtime:

| Resolved posture | Letta `--permission-mode` |
|------------------|---------------------------|
| `full_bypass` (`builtin:yolo`, or a custom flag policy with `launch_posture: full_bypass`) | `unrestricted` |
| `auto` (`builtin:auto`) | `standard` (Letta has no auto mode) |
| `floor` (no policy, `builtin:locked`, `builtin:standard`, `builtin:open`, `none`) | `standard` |
| none resolved | `unrestricted` when `OPENRIG_YOLO` is on, else `standard` (as for Pi and OMP) |

The pane cannot answer a tool approval. At `standard`, every approval request Letta raises is denied by
the runner at once, the turn is interrupted, and the pane shows
`[letta-runner] ERROR approval requested for <tool>; denied …`. The seat stays usable.

**To let a Letta seat run tools unattended** (including running `rig send` to reply to other seats),
attach `permission_policy: builtin:yolo` to its member, or a custom policy whose flag surface selects
`full_bypass`. Config-surface policies (`builtin:standard`, `builtin:open`, custom allow/ask/deny
rules) are recorded but not translated into Letta settings in v1.

---

## Environment

The daemon adds Letta's variables to letta seats only:

| Variable | Reaches a letta seat when |
|----------|---------------------------|
| `LETTA_LOCAL_BACKEND_DIR` | it is set in the daemon's environment. It is a folder path, not a credential, so it is not gated by the allowlist. |
| `LETTA_API_KEY`, `LETTA_BASE_URL` | it is set in the daemon's environment **and** named in `recovery.provider_auth_env_allowlist` (empty by default). |

The runner then passes Letta Code only `PATH`, `HOME`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`,
`SHELL`, `TMPDIR`, the OpenRig seat and instance variables (so `rig send` from the agent is stamped with
the seat's identity), and the three variables above. It always sets `DISABLE_AUTOUPDATER=1` and
`LETTA_DISABLE_MODS=1`, and passes `--no-mods`: a self-updating CLI or a machine-wide Letta mod must
not run inside a managed seat. Model-provider keys are not passed; a local backend keeps its provider
logins in its backend folder.

---

## Startup and projection

- **Skills** are installed to `<cwd>/.agents/skills/<id>/`.
- **Guidance** (`guidance_merge`) is merged as a managed block into `<cwd>/AGENTS.md` and, because Letta
  does not read `AGENTS.md` itself, also sent as the first turn of a fresh launch. A resumed
  conversation does not get it again. `rig-role` guidance is per-seat and goes only through `send_text`.
- **`send_text`** startup files are sent through the runner as one turn each.
- **Not projected in v1:** plugins, subagents, hooks and MCP servers (reported as skipped), and runtime
  resources other than `letta_agent_binding`.
- **Continuity** is Letta's: Letta compacts server-side and owns the agent's memory. Only
  `compaction_strategy: default-compaction` (alias `harness_native`) is accepted; `managed-compaction`,
  `handover` and `apprentice-handover` are refused for letta members.

---

## Readiness and attention

| Code | Blocking | Meaning |
|------|----------|---------|
| `letta_auth_required` | yes | Letta reported a missing or unconfigured provider (for example `Provider is not configured: <provider>`). Connect the provider in the agent's backend. |
| `letta_agent_missing` | yes | The bound agent does not exist in the backend the seat opened. Check `LETTA_LOCAL_BACKEND_DIR`. |
| `letta_conversation_missing` | yes | The conversation to resume is gone. |
| `letta_identity_mismatch` | yes | `system/init` reported another agent or conversation than requested; the runner stops Letta. |
| `letta_approval_pending` | no | An approval was requested and denied (see [Permissions](#permissions)). |
| `runtime_error` | no | A turn ended in error; the seat still takes input. |
| `runner_exited`, `runner_error`, `awaiting_runtime` | — | The runner exited, printed an error before readiness, or has not reported ready yet. |

Letta's exit code does not decide a turn: a turn's `result` record does (Letta Code on Windows can exit
127 after a good turn). When `system/init` does not have the shape this runner was built against, the
seat is still ready; the sidecar records `streamAdvisory`, the pane shows `[letta-runner] note: …`,
and readiness reports it as `letta-runner advisory: …`.

---

## Limits of v1

- **One turn at a time.** Letta Code merges user input already waiting when a turn starts into a single
  turn, so the runner sends one block, waits for that turn's `result`, then sends the next. Later input
  queues in the runner; the pane shows `you (queued, N waiting)`.
- **Fork is refused** (see above).
- **MCP, plugins, hooks and subagents are not projected**; Letta keeps its own tools.
- **Memory is owned by Letta.** OpenRig never writes the agent's memory and does not snapshot it; a bound
  agent's memory changes from every conversation it has, including the seat's.
- **Permissions are binary** in practice: `unrestricted` or `standard` with every approval denied.

---

## Known interactions

- **Claude Code prompt suggestions.** Claude Code can show a suggested next prompt as ghost text in an
  empty composer. In a Claude + Letta rig, OpenRig was seen to read that text as an operator draft and
  refuse delivery to the Claude seat with `prompt_draft`. This is a Claude-seat interaction, not a
  Letta one. Check the Claude pane: if the composer holds only a suggestion, sending with
  `--dangerously-interact --reason "<why>"` and then Enter delivered the message; in that run it
  cleared on the next launch.
- **Local backend login needs a terminal.** `letta connect` on a local backend expects a TTY; run it
  in an interactive shell on the seat's machine, in the same backend folder the seat will use.
