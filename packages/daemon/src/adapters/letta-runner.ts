// R&D Exp 03 — the pane-hosted letta-runner (compiled entry in the daemon
// dist), modelled on pi-runner.ts.
//
//   pane stdin (rig send / human typing)  ──▶ one stream-json `user` line per turn
//   letta stdout (typed stream-json)      ──▶ (a) human-readable pane mirror
//                                             (b) activity + session_identity
//                                                 POSTs to the daemon
//                                             (c) runner-state.json sidecar
//
// One user line per turn: Letta merges user lines that are already waiting
// when a turn starts, so the runner holds further pane input until the
// in-flight turn's `result` arrives, then sends the next.
//
// Honest failure: the `result` record decides a turn's outcome, not the exit
// code (Windows Letta can exit 127 after a good turn). A child that dies with
// a turn in flight is reported as such.
//
// Only node builtins and local runner helpers are imported so the compiled
// entry stays runnable as `node <dist>/adapters/letta-runner.js`.

import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createRunnerInput, resolveActivityEndpoint } from "./pi-runner.js";
import {
  lettaSeatPaths, buildLettaChildArgs, buildLettaChildEnv, buildPendingLettaRunnerState,
  classifyLettaRecord, classifyLettaExit, mapLettaEvent, parseLettaLine, verifyLettaInit,
  encodeLettaUserTurn, encodeLettaInterrupt, encodeLettaToolDenial, formatLettaResumeToken,
  LETTA_RUNNER_READY_MARKER, LETTA_RUNNER_EXIT_MARKER, LETTA_RUNNER_ERROR_MARKER, LETTA_RESUME_TYPE,
  LETTA_PERMISSION_MODES,
  type LettaAttentionCode, type LettaLaunchMode, type LettaPermissionMode, type LettaRunnerState,
} from "./letta-runner-protocol.js";

// ── The runner core (injected effects; owns turn state) ─────────────────────

export interface LettaRunnerIo {
  /** Write one newline-terminated line to letta stdin. */
  writeStdin(line: string): void;
  mirrorLine(line: string): void;
  mirrorAppend(text: string): void;
  postActivity(payload: Record<string, unknown>): void;
  writeSidecar(state: LettaRunnerState): void;
  /** Terminate the child when its identity cannot be trusted. */
  stopChild?(): void;
  now(): string;
}

export interface LettaTurnSummary {
  /** Concatenated assistant_message chunks. */
  streamedText: string;
  /** `result.result`, the CLI's own final text. */
  resultText: string | null;
  subtype: string;
}

/** Attention codes that the daemon's existing Notification subtypes cover. */
function notificationSubtype(code: LettaAttentionCode): string {
  return code === "letta_approval_pending" ? "permission_prompt" : "runtime_error";
}

export class LettaRunnerCore {
  private ready = false;
  private exited = false;
  private agentId: string | undefined;
  private conversationId: string | undefined;
  private model: string | undefined;
  private lastEventSeq: number | undefined;
  private attention: LettaAttentionCode | undefined;
  private pending: string[] = [];
  private turnInFlight = false;
  private turnActivePosted = false;
  private turnErrorShown = false;
  private streamedText = "";
  private lastResult: string | undefined;
  private lastTurnSummary: LettaTurnSummary | null = null;
  private toolNames = new Map<string, string>();
  private toolsReported = new Set<string>();
  private approvalsDenied = new Set<string>();
  private interruptCount = 0;

  constructor(
    private io: LettaRunnerIo,
    private identity: { sessionName: string; nodeId?: string; launchId?: string; generation?: string },
    private mode: LettaLaunchMode,
  ) {}

  isReady(): boolean { return this.ready; }
  isTurnInFlight(): boolean { return this.turnInFlight; }
  queuedCount(): number { return this.pending.length; }
  lastTurn(): LettaTurnSummary | null { return this.lastTurnSummary; }

  /** One aggregated block from pane stdin. */
  handleUserBlock(block: string): void {
    if (block === "/abort") {
      if (!this.turnInFlight) {
        this.io.mirrorLine("[letta-runner] nothing to abort");
        return;
      }
      this.io.writeStdin(encodeLettaInterrupt(`letta-runner-interrupt-${++this.interruptCount}`));
      this.io.mirrorLine("[letta-runner] interrupt sent");
      return;
    }
    if (this.exited) {
      this.io.mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} letta has exited; input not delivered`);
      return;
    }
    this.pending.push(block);
    if (!this.ready || this.turnInFlight) {
      this.io.mirrorLine(`you (queued, ${this.pending.length} waiting) ▸ ${block}`);
      return;
    }
    this.pump();
  }

  /** One LF-delimited record from letta stdout. */
  handleLine(rawLine: string): void {
    const parsed = parseLettaLine(rawLine);
    if (!parsed) return;
    if ("raw" in parsed) {
      this.io.mirrorLine(parsed.raw);
      return;
    }
    const record = parsed.record;
    if (typeof record.event_seq === "number" && (this.lastEventSeq === undefined || record.event_seq > this.lastEventSeq)) {
      this.lastEventSeq = record.event_seq;
    }
    const event = classifyLettaRecord(record);

    switch (event.kind) {
      case "init":
        this.handleInit(event);
        return;
      case "assistant_chunk":
        this.streamedText += event.text;
        this.markTurnActive();
        break;
      case "reasoning":
        this.markTurnActive();
        break;
      case "tool_call":
        if (event.toolCallId) this.toolNames.set(event.toolCallId, event.toolName);
        break;
      case "tool_started":
        this.markTurnActive();
        return;
      case "tool_finished":
      case "tool_return": {
        const id = event.toolCallId;
        if (id && this.toolsReported.has(id)) return;
        if (id) this.toolsReported.add(id);
        const name = (id && this.toolNames.get(id)) || "tool";
        this.io.mirrorLine(`  ⚙ ${name} ${event.failed ? "FAILED" : "done"}`);
        return;
      }
      case "approval_requested": {
        // The canonical approval trigger is control_request/can_use_tool; it
        // blocks the turn until answered, so answer it (deny) at once.
        if (record.type === "control_request" && event.requestId) {
          this.io.writeStdin(encodeLettaToolDenial(event.requestId, "OpenRig managed pane cannot approve tool use; denied."));
        }
        const key = event.toolCallId ?? event.requestId ?? "unknown";
        if (this.approvalsDenied.has(key)) return;
        this.approvalsDenied.add(key);
        break;
      }
      case "queue":
        if (event.event === "queue_batch_dequeued") this.markTurnActive();
        break;
      case "result":
        this.handleResult(event, record);
        return;
      default:
        break;
    }

    const mapped = mapLettaEvent(event);
    if (mapped.mirrorAppend) this.io.mirrorAppend(mapped.mirrorAppend);
    for (const line of mapped.mirrorLines) this.io.mirrorLine(line);
    if (mapped.errorNotice && !this.turnErrorShown) {
      this.turnErrorShown = true;
      this.io.mirrorLine(mapped.errorNotice);
    }
    if (mapped.attention) this.raiseAttention(mapped.attention);
    else if (mapped.activity) this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
  }

  /** Child process exit — the last `result` outranks the exit code. */
  handleChildExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const outcome = classifyLettaExit({ code, turnInFlight: this.turnInFlight, lastResult: this.lastResult });
    this.ready = false;
    this.turnInFlight = false;
    const codeText = `code ${code ?? "unknown"}`;
    switch (outcome) {
      case "clean":
        this.io.mirrorLine(`${LETTA_RUNNER_EXIT_MARKER} letta exited (${codeText})`);
        break;
      case "crashed_after_result":
        this.io.mirrorLine(`${LETTA_RUNNER_EXIT_MARKER} letta exited (${codeText}) after its last turn completed with result/${this.lastResult}; that result stands`);
        break;
      case "crashed_mid_turn":
        this.io.mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} letta exited (${codeText}) with a turn in flight and no result`);
        this.io.mirrorLine(`${LETTA_RUNNER_EXIT_MARKER} letta exited (${codeText})`);
        break;
      case "failed":
        this.io.mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} letta exited (${codeText}) before completing a turn`);
        this.io.mirrorLine(`${LETTA_RUNNER_EXIT_MARKER} letta exited (${codeText})`);
        break;
    }
    if (this.pending.length > 0) {
      this.io.mirrorLine(`[letta-runner] ${this.pending.length} queued input(s) were not delivered`);
    }
    this.writeSidecar({ exited: { code, at: this.io.now(), lastResult: this.lastResult } });
    this.io.postActivity(this.activityPayload("Stop", "letta_exited"));
  }

  private handleInit(event: { agentId: string | null; conversationId: string | null; model: string | null }): void {
    const verdict = verifyLettaInit(this.mode, event);
    if (!verdict.ok) {
      this.ready = false;
      this.attention = "letta_identity_mismatch";
      this.writeSidecar({});
      this.io.mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} identity: ${verdict.reason}`);
      this.io.postActivity({ ...this.activityPayload("Notification", "runtime_error"), attentionCode: this.attention });
      this.io.stopChild?.();
      return;
    }
    this.agentId = event.agentId!;
    this.conversationId = event.conversationId!;
    this.model = event.model ?? undefined;
    this.ready = true;
    this.writeSidecar({});
    this.io.mirrorLine(`${LETTA_RUNNER_READY_MARKER} agent=${this.agentId} conversation=${this.conversationId}${this.model ? ` model=${this.model}` : ""}`);
    this.io.postActivity({
      eventFamily: "session_identity",
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      runtime: "letta",
      generation: this.identity.generation ?? null,
      hookEvent: "SessionStart",
      sessionId: this.conversationId,
      sessionFile: null,
      agentId: this.agentId,
      conversationId: this.conversationId,
      resumeType: LETTA_RESUME_TYPE,
      resumeToken: formatLettaResumeToken(this.agentId, this.conversationId),
      occurredAt: this.io.now(),
    });
    this.pump();
  }

  private handleResult(
    event: { subtype: string; text: string | null; stopReason: string | null },
    record: Record<string, unknown>,
  ): void {
    // The CLI's own final text covers a turn whose chunks never streamed.
    if (event.subtype === "success" && !this.streamedText && event.text) this.io.mirrorAppend(event.text);
    this.lastTurnSummary = { streamedText: this.streamedText, resultText: event.text, subtype: event.subtype };
    this.lastResult = event.subtype;
    if (typeof record.conversation_id === "string" && record.conversation_id !== this.conversationId && this.conversationId) {
      this.io.mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} result reported conversation ${record.conversation_id}, expected ${this.conversationId}`);
    }
    const mapped = mapLettaEvent({ kind: "result", subtype: event.subtype, text: event.text, agentId: null, conversationId: null, stopReason: event.stopReason });
    for (const line of mapped.mirrorLines) this.io.mirrorLine(line);
    if (mapped.errorNotice && !this.turnErrorShown) {
      this.turnErrorShown = true;
      this.io.mirrorLine(mapped.errorNotice);
    }
    // A failed turn already raised a specific attention from its `error`
    // record; a generic result/error only raises one if none is set.
    if (mapped.attention && !this.attention) this.attention = mapped.attention;
    this.turnInFlight = false;
    this.writeSidecar({});
    if (this.attention) {
      // The turn ended but the operator must act: the final state is the
      // attention, not idle.
      this.io.postActivity({ ...this.activityPayload("Notification", notificationSubtype(this.attention)), attentionCode: this.attention });
    } else if (mapped.activity) {
      this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
    }
    this.pump();
  }

  /** Send the next queued block, only when idle and ready. */
  private pump(): void {
    if (!this.ready || this.turnInFlight || this.exited) return;
    const block = this.pending.shift();
    if (block === undefined) return;
    this.turnInFlight = true;
    this.turnActivePosted = false;
    this.turnErrorShown = false;
    this.streamedText = "";
    this.attention = undefined;
    this.io.writeStdin(encodeLettaUserTurn(block));
    this.io.mirrorLine(`you ▸ ${block}`);
  }

  private markTurnActive(): void {
    if (!this.turnInFlight || this.turnActivePosted) return;
    this.turnActivePosted = true;
    this.io.postActivity(this.activityPayload("active", "turn_start"));
  }

  private raiseAttention(code: LettaAttentionCode): void {
    if (this.attention === code) return;
    // Auth/missing-identity outrank a generic runtime error or an approval.
    if (this.attention && this.attention !== "runtime_error" && this.attention !== "letta_approval_pending") return;
    this.attention = code;
    this.writeSidecar({});
    this.io.postActivity({ ...this.activityPayload("Notification", notificationSubtype(code)), attentionCode: code });
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: "letta",
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<LettaRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      launchId: this.identity.launchId,
      agentId: this.agentId,
      conversationId: this.conversationId,
      model: this.model,
      lastEventSeq: this.lastEventSeq,
      attention: this.attention,
      updatedAt: this.io.now(),
      ...patch,
    });
  }
}

// ── Child seam ───────────────────────────────────────────────────────────────

/** The subset of ChildProcess the runner uses; tests inject a fake. */
export interface LettaChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): unknown;
}

export type SpawnLettaChild = (args: string[], opts: { cwd: string; env: Record<string, string> }) => LettaChildLike;

const defaultSpawn: SpawnLettaChild = (args, opts) =>
  spawn("letta", args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });

/** Wire a child's streams and lifecycle into a core. `onExit` runs after
 *  the core records the exit. */
export function attachLettaChild(
  child: LettaChildLike,
  core: LettaRunnerCore,
  mirrorLine: (line: string) => void,
  onExit?: (code: number | null) => void,
): void {
  let finished = false;
  let stdoutDrained = false;
  let exitCode: number | null | undefined;
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    core.handleChildExit(code);
    onExit?.(code);
  };
  child.stdin.on("error", () => { /* exit handler owns the diagnosis */ });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    .on("line", (line) => core.handleLine(line))
    // Record the exit only once stdout is drained, so a `result` written just
    // before the process died is still counted.
    .on("close", () => {
      stdoutDrained = true;
      if (exitCode !== undefined) finish(exitCode);
    });
  readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
    if (line.trim()) mirrorLine(`[letta:err] ${line}`);
  });
  child.on("error", (err) => {
    mirrorLine(`${LETTA_RUNNER_ERROR_MARKER} failed to spawn letta: ${err.message}`);
    finish((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
  });
  child.on("exit", (code) => {
    exitCode = code;
    if (stdoutDrained) finish(code);
    // A grandchild holding stdout open must not hide the exit forever.
    else setTimeout(() => finish(code), LETTA_EXIT_GRACE_MS).unref();
  });
}

/** How long after letta's own exit to wait for its stdout to drain. */
const LETTA_EXIT_GRACE_MS = 1_000;

// ── CLI entry ────────────────────────────────────────────────────────────────

export interface LettaRunnerArgs {
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  permissionMode: LettaPermissionMode;
  mode: LettaLaunchMode;
  model?: string;
}

export function parseLettaRunnerArgs(argv: string[]): LettaRunnerArgs {
  const out: Partial<LettaRunnerArgs> & { agent?: string; conversation?: string; expectAgent?: string; create?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--session-name": out.sessionName = next(); break;
      case "--state-root": out.stateRoot = next(); break;
      case "--cwd": out.cwd = next(); break;
      case "--launch-id": out.launchId = next(); break;
      case "--permission-mode": {
        const mode = next();
        if (!(LETTA_PERMISSION_MODES as readonly string[]).includes(mode)) throw new Error(`unsupported permission mode: ${mode}`);
        out.permissionMode = mode as LettaPermissionMode;
        break;
      }
      case "--agent": out.agent = next(); break;
      case "--conversation": out.conversation = next(); break;
      case "--expect-agent": out.expectAgent = next(); break;
      case "--create-agent": out.create = true; break;
      case "--model": out.model = next(); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!out.sessionName) throw new Error("--session-name is required");
  if (!out.stateRoot) throw new Error("--state-root is required");
  if (!out.cwd) throw new Error("--cwd is required");
  if (!out.launchId) throw new Error("--launch-id is required (launch-attempt scoping)");
  if (!out.permissionMode) throw new Error("an explicit --permission-mode is required");
  const modes = [out.agent !== undefined, out.conversation !== undefined, out.create === true].filter(Boolean).length;
  if (modes !== 1) throw new Error("exactly one of --agent, --conversation or --create-agent is required");
  if (out.expectAgent !== undefined && out.conversation === undefined) throw new Error("--expect-agent only applies with --conversation");
  let mode: LettaLaunchMode;
  if (out.agent !== undefined) mode = { kind: "bind", agentId: out.agent };
  else if (out.conversation !== undefined) mode = { kind: "resume", conversationId: out.conversation, ...(out.expectAgent ? { expectAgentId: out.expectAgent } : {}) };
  else mode = { kind: "create", allowCreateAgent: true };
  return {
    sessionName: out.sessionName, stateRoot: out.stateRoot, cwd: out.cwd, launchId: out.launchId,
    permissionMode: out.permissionMode, mode, ...(out.model ? { model: out.model } : {}),
  };
}

export async function main(argv = process.argv.slice(2), spawnChild: SpawnLettaChild = defaultSpawn): Promise<void> {
  let args: LettaRunnerArgs;
  let childArgs: string[];
  try {
    args = parseLettaRunnerArgs(argv);
    childArgs = buildLettaChildArgs({ mode: args.mode, permissionMode: args.permissionMode, model: args.model });
  } catch (err) {
    console.error(`${LETTA_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const paths = lettaSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true });
  try {
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(buildPendingLettaRunnerState(args.launchId, new Date().toISOString())));
  } catch { /* best-effort; the pane markers still report readiness */ }

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildLettaChildEnv(process.env as Record<string, string | undefined>);
  console.log(`[letta-runner] starting letta ${args.mode.kind} (seat ${args.sessionName}, permission mode ${args.permissionMode})`);
  console.log(`[letta-runner] send text normally; one message per turn (later input waits for the turn to finish); "/abort" interrupts`);

  const child = spawnChild(childArgs, { cwd: args.cwd, env: childEnv });
  const io: LettaRunnerIo = {
    writeStdin: (line) => {
      try { child.stdin.write(line); } catch { /* exit handler reports */ }
    },
    mirrorLine: (line) => process.stdout.write(`${line}\n`),
    mirrorAppend: (text) => process.stdout.write(text),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* best-effort — never blocks the loop */ }).finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => {
      try { fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state)); } catch { /* best-effort */ }
    },
    stopChild: () => { child.kill(); },
    now: () => new Date().toISOString(),
  };

  const core = new LettaRunnerCore(io, {
    sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, launchId: args.launchId,
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
  }, args.mode);

  const input = createRunnerInput(process.stdin, process.stdout, (block) => core.handleUserBlock(block), "letta-runner");
  attachLettaChild(child, core, io.mirrorLine, (code) => {
    input.close();
    // Passed through as-is; turn outcomes live in the markers and the
    // sidecar's exited.lastResult, which outrank this code.
    process.exitCode = code ?? 1;
  });
}

// Compiled-entry guard: run main() only when executed directly.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(nodePath.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}
