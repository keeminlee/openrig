// R&D Exp 03 — the shared, PURE contract between a future Letta runtime
// adapter and the pane-hosted letta-runner process. Modelled on
// pi-runner-protocol.ts.
//
// Everything here is side-effect-free (constants + argv/env/stdin builders,
// the stdout record classifier, and the runner-state sidecar shape) so the
// runner entry can import it without daemon dependencies and tests can assert
// it hermetically against recorded Letta stream-json.
//
// v1 transport: headless Letta Code
//   letta -p --input-format stream-json --output-format stream-json …
// Facts this module encodes (Letta Code 0.34.x, probe of 2026-10-07 plus the
// CLI's own type declarations in dist/types/types/protocol.d.ts):
// - `system/init` is written before stdin is read and carries agent_id,
//   conversation_id, model and mcp_servers: the seat's identity.
// - stdin takes `{type:"user", message:{role:"user", content}}` lines. User
//   lines already waiting when a turn starts are MERGED into one turn
//   (queue_batch_dequeued merged_count>1), so the runner sends one line per
//   turn and waits for that turn's `result`.
// - Every bidirectional turn ends with a `result` record (success | error |
//   interrupted), including on a thrown error.
// - Resume is `--conversation <id>` ALONE: `--agent` with `--conversation`
//   exits 1 with no output. Bind is `--agent <id> --new`.
// - On Windows the CLI can exit 127 (libuv assertion) after a good turn, so
//   the `result` record, not the exit code, is the turn's outcome.

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

// ── Seat state layout ────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>/runner-state.json → the runner's identity sidecar.
// Deliberately NO per-seat LETTA_LOCAL_BACKEND_DIR: a bound Meep's memory
// lives in the shared local backend, and that memory is its identity.

export interface LettaSeatPaths {
  seatRoot: string;
  runnerStatePath: string;
}

export function lettaSeatPaths(stateRoot: string, sessionName: string): LettaSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return { seatRoot, runnerStatePath: nodePath.join(seatRoot, "runner-state.json") };
}

// ── Pane markers (runner-authored; never Letta UI) ──────────────────────────

export const LETTA_RUNNER_READY_MARKER = "[letta-runner] READY";
export const LETTA_RUNNER_EXIT_MARKER = "[letta-runner] EXITED";
export const LETTA_RUNNER_ERROR_MARKER = "[letta-runner] ERROR";

// ── Attention codes (proposed; not yet in runtime-adapter.ts) ───────────────

export type LettaAttentionCode =
  | "letta_auth_required"
  | "letta_agent_missing"
  | "letta_conversation_missing"
  | "letta_approval_pending"
  | "letta_identity_mismatch"
  | "runtime_error";

// ── Runner-state sidecar ─────────────────────────────────────────────────────

export interface LettaRunnerState {
  ready: boolean;
  /** Launch-attempt scope, as for Pi: polls ignore a state whose launchId differs. */
  launchId?: string;
  /** From system/init. */
  agentId?: string;
  /** From system/init; the resume handle (`--conversation <id>`). */
  conversationId?: string;
  model?: string;
  /** Highest `event_seq` seen on the wire this launch (per-process counter). */
  lastEventSeq?: number;
  /** Set when system/init does not have the shape this runner was built
   *  against. Advisory only: identity was still verified. */
  streamAdvisory?: string;
  /** Set when the runner raised an attention code the operator must clear. */
  attention?: LettaAttentionCode;
  updatedAt: string;
  /** Set when the letta child exited. `lastResult` is the last turn's
   *  `result.subtype`, which outranks the exit code (Windows exit-127). */
  exited?: { code: number | null; at: string; lastResult?: string };
}

/** The launch-scoped pending record written before the child starts. Nothing
 *  from the prior record is carried: event_seq is a per-process counter and
 *  identity must be re-proven by this launch's system/init. */
export function buildPendingLettaRunnerState(launchId: string, updatedAt: string): LettaRunnerState {
  return { ready: false, launchId, updatedAt };
}

export function parseLettaRunnerState(raw: string): LettaRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    return parsed as unknown as LettaRunnerState;
  } catch {
    return null;
  }
}

/** Resume token shape for the adapter: `<agent_id>/<conversation_id>`. The
 *  agent half is for verification only; resume argv uses the conversation. */
export const LETTA_RESUME_TYPE = "letta_conversation";

export function formatLettaResumeToken(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

export function parseLettaResumeToken(token: string): { agentId: string; conversationId: string } | null {
  const slash = token.indexOf("/");
  if (slash <= 0) return null;
  const agentId = token.slice(0, slash);
  const conversationId = token.slice(slash + 1);
  return isLettaAgentId(agentId) && isLettaConversationId(conversationId) ? { agentId, conversationId } : null;
}

// ── Identifiers ──────────────────────────────────────────────────────────────

export function isLettaAgentId(value: string): boolean {
  return /^agent-[A-Za-z0-9-]{1,128}$/.test(value);
}

/** Cloud `conv-…` and local-backend `local-conv-N`. `default` is refused here:
 *  it is not a conversation of its own and cannot be resumed without --agent. */
export function isLettaConversationId(value: string): boolean {
  return /^(?:local-)?conv-[A-Za-z0-9-]{1,128}$/.test(value);
}

// ── Launch modes and child argv ──────────────────────────────────────────────

export const LETTA_PERMISSION_MODES = ["standard", "acceptEdits", "unrestricted", "strict"] as const;
export type LettaPermissionMode = typeof LETTA_PERMISSION_MODES[number];

export type LettaLaunchMode =
  /** Existing agent, NEW conversation: never hijacks the agent's other rooms. */
  | { kind: "bind"; agentId: string }
  /** Existing conversation; the agent is inferred and verified from init. */
  | { kind: "resume"; conversationId: string; expectAgentId?: string }
  /** Disposable seats only. The literal `true` is the explicit opt-in. */
  | { kind: "create"; allowCreateAgent: true };

export interface LettaChildArgsOpts {
  mode: LettaLaunchMode;
  /** Always explicit (mirrors Pi BR-5): never leave posture ambient. */
  permissionMode: LettaPermissionMode;
  /** Model handle; only applied when creating an agent, so a bind or resume
   *  never rewrites an existing agent's model. */
  model?: string;
}

/** Argv for the `letta` child the RUNNER spawns (argv-style, no shell). */
export function buildLettaChildArgs(opts: LettaChildArgsOpts): string[] {
  if (!(LETTA_PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
    throw new Error(`unsupported Letta permission mode: ${String(opts.permissionMode)}`);
  }
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--permission-mode", opts.permissionMode,
    // Mods are machine-global trusted code (the town runs one); a managed
    // seat must not fire them. Paired with LETTA_DISABLE_MODS=1 in the env.
    "--no-mods",
  ];
  const mode = opts.mode;
  switch (mode.kind) {
    case "bind":
      if (!isLettaAgentId(mode.agentId)) throw new Error(`invalid Letta agent id: ${mode.agentId}`);
      args.push("--agent", mode.agentId, "--new");
      break;
    case "resume":
      if (!isLettaConversationId(mode.conversationId)) {
        throw new Error(`invalid Letta conversation id: ${mode.conversationId}`);
      }
      // NEVER --agent here: Letta exits 1 silently when both are given.
      args.push("--conversation", mode.conversationId);
      break;
    case "create":
      if (mode.allowCreateAgent !== true) throw new Error("creating a Letta agent requires an explicit opt-in");
      args.push("--new-agent");
      if (opts.model?.trim()) args.push("--model", opts.model.trim());
      break;
    default:
      throw new Error(`unknown Letta launch mode: ${(mode as { kind?: string }).kind}`);
  }
  return args;
}

// ── Child env (deny-by-default) ──────────────────────────────────────────────

const LETTA_ENV_BASELINE_VARS = ["PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR"] as const;
const LETTA_ENV_OPENRIG_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;
/** A Letta server credential and the endpoint it is valid for. The daemon
 *  admits these into a letta seat only when the operator names them in
 *  recovery.provider_auth_env_allowlist. */
export const LETTA_AUTH_ENV_VARS = ["LETTA_BASE_URL", "LETTA_API_KEY"] as const;
/** Non-secret locators: which local backend folder (and so which agents and
 *  provider logins) the CLI opens. The daemon forwards its own value. */
export const LETTA_LOCATOR_ENV_VARS = ["LETTA_LOCAL_BACKEND_DIR"] as const;
/** Letta's own variables. Provider credentials for the local backend live in
 *  the backend folder, not the environment; no other secret crosses. */
const LETTA_ENV_RUNTIME_VARS = [...LETTA_LOCATOR_ENV_VARS, ...LETTA_AUTH_ENV_VARS] as const;

export function buildLettaChildEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...LETTA_ENV_BASELINE_VARS, ...LETTA_ENV_OPENRIG_VARS, ...LETTA_ENV_RUNTIME_VARS]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.OPENRIG_RUNTIME = "letta";
  // A self-updating CLI broke the town fleet four times; pin it.
  env.DISABLE_AUTOUPDATER = "1";
  env.LETTA_DISABLE_MODS = "1";
  return env;
}

// ── Pane command (what a future adapter types into the seat's pane) ─────────

export interface LettaRunnerLaunchOpts {
  runnerEntryPath: string;
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  permissionMode: LettaPermissionMode;
  mode: LettaLaunchMode;
  model?: string;
}

export function buildLettaRunnerCommand(opts: LettaRunnerLaunchOpts): string {
  const parts = [
    "node", shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--state-root", shellQuote(opts.stateRoot),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    "--permission-mode", shellQuote(opts.permissionMode),
  ];
  switch (opts.mode.kind) {
    case "bind": parts.push("--agent", shellQuote(opts.mode.agentId)); break;
    case "resume":
      parts.push("--conversation", shellQuote(opts.mode.conversationId));
      if (opts.mode.expectAgentId) parts.push("--expect-agent", shellQuote(opts.mode.expectAgentId));
      break;
    case "create": parts.push("--create-agent"); break;
  }
  if (opts.mode.kind === "create" && opts.model?.trim()) parts.push("--model", shellQuote(opts.model.trim()));
  return parts.join(" ");
}

// ── stdin encoders ───────────────────────────────────────────────────────────

/** One user turn as a stream-json stdin line (newline-terminated). */
export function encodeLettaUserTurn(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

export function encodeLettaInterrupt(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}

/** Answer a `can_use_tool` request. The pane cannot approve interactively,
 *  so the runner denies and interrupts; the operator re-sends, or attaches a
 *  full_bypass permission_policy (builtin:yolo) to the seat. */
export function encodeLettaToolDenial(requestId: string, message: string): string {
  return `${JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message, interrupt: true } },
  })}\n`;
}

// ── stdout classifier ────────────────────────────────────────────────────────

export type LettaEvent =
  | { kind: "init"; agentId: string | null; conversationId: string | null; model: string | null; mcpServers: Array<{ name: string; status: string }> }
  | { kind: "assistant_chunk"; messageId: string | null; text: string }
  | { kind: "reasoning" }
  | { kind: "tool_call"; toolCallId: string | null; toolName: string }
  | { kind: "tool_return"; toolCallId: string | null; failed: boolean }
  | { kind: "tool_started"; toolCallId: string | null }
  | { kind: "tool_finished"; toolCallId: string | null; failed: boolean }
  | { kind: "approval_requested"; toolCallId: string | null; toolName: string; requestId: string | null }
  | { kind: "usage" }
  | { kind: "stop_reason"; stopReason: string }
  | { kind: "error"; message: string; stopReason: string | null }
  | { kind: "retry"; attempt: number | null; maxAttempts: number | null }
  | { kind: "result"; subtype: string; text: string | null; agentId: string | null; conversationId: string | null; stopReason: string | null }
  | { kind: "queue"; event: string; mergedCount: number | null }
  | { kind: "control_response"; requestId: string | null }
  | { kind: "other"; type: string };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
      ? (part as Record<string, unknown>).text as string : ""))
    .join("");
}

function firstToolCall(record: Record<string, unknown>): { id: string | null; name: string } {
  const single = record.tool_call as Record<string, unknown> | undefined;
  const list = Array.isArray(record.tool_calls) ? record.tool_calls as Record<string, unknown>[] : [];
  const call = single && typeof single === "object" ? single : list[0];
  return { id: str(call?.tool_call_id), name: str(call?.name) ?? "tool" };
}

export function classifyLettaRecord(record: Record<string, unknown>): LettaEvent {
  const type = str(record.type) ?? "";
  switch (type) {
    case "system":
      if (record.subtype === "init") {
        const servers = Array.isArray(record.mcp_servers) ? record.mcp_servers as Array<{ name: string; status: string }> : [];
        return { kind: "init", agentId: str(record.agent_id), conversationId: str(record.conversation_id), model: str(record.model), mcpServers: servers };
      }
      return { kind: "other", type: `system/${String(record.subtype)}` };
    case "message":
      switch (record.message_type) {
        case "assistant_message":
          return { kind: "assistant_chunk", messageId: str(record.id), text: textOf(record.content) };
        case "reasoning_message":
          return { kind: "reasoning" };
        case "tool_call_message": {
          const call = firstToolCall(record);
          return { kind: "tool_call", toolCallId: call.id, toolName: call.name };
        }
        case "approval_request_message": {
          const call = firstToolCall(record);
          return { kind: "approval_requested", toolCallId: call.id, toolName: call.name, requestId: null };
        }
        case "tool_return_message":
          return { kind: "tool_return", toolCallId: str(record.tool_call_id), failed: record.status === "error" };
        case "usage_statistics":
          return { kind: "usage" };
        case "stop_reason":
          return { kind: "stop_reason", stopReason: str(record.stop_reason) ?? "unknown" };
        default:
          return { kind: "other", type: `message/${String(record.message_type)}` };
      }
    case "tool_execution_started":
      return { kind: "tool_started", toolCallId: str(record.tool_call_id) };
    case "tool_execution_finished":
      return { kind: "tool_finished", toolCallId: str(record.tool_call_id), failed: record.status === "error" };
    case "approval_requested":
      return { kind: "approval_requested", toolCallId: str(record.tool_call_id), toolName: str(record.tool_name) ?? "tool", requestId: str(record.request_id) };
    case "control_request": {
      const request = record.request as Record<string, unknown> | undefined;
      if (request?.subtype === "can_use_tool") {
        return { kind: "approval_requested", toolCallId: str(request.tool_call_id), toolName: str(request.tool_name) ?? "tool", requestId: str(record.request_id) };
      }
      return { kind: "other", type: `control_request/${String(request?.subtype)}` };
    }
    case "control_response": {
      const response = record.response as Record<string, unknown> | undefined;
      return { kind: "control_response", requestId: str(response?.request_id) };
    }
    case "error":
      return { kind: "error", message: str(record.message) ?? "error", stopReason: str(record.stop_reason) };
    case "retry":
      return { kind: "retry", attempt: num(record.attempt), maxAttempts: num(record.max_attempts) };
    case "result":
      return {
        kind: "result", subtype: str(record.subtype) ?? "unknown", text: str(record.result),
        agentId: str(record.agent_id), conversationId: str(record.conversation_id), stopReason: str(record.stop_reason),
      };
    case "queue_item_enqueued":
    case "queue_batch_dequeued":
    case "queue_blocked":
    case "queue_cleared":
    case "queue_item_dropped":
      return { kind: "queue", event: type, mergedCount: num(record.merged_count) };
    default:
      return { kind: "other", type };
  }
}

/** Parse one stdout line; null for blank or non-object lines. Non-JSON is
 *  returned as `{raw}` so the runner can mirror it rather than hide it. */
export function parseLettaLine(line: string): { record: Record<string, unknown> } | { raw: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { raw: trimmed };
    return { record: parsed as Record<string, unknown> };
  } catch {
    return { raw: trimmed };
  }
}

// ── Readiness / attention classification ────────────────────────────────────

/** Map a Letta error message to an attention code. Message matching is the
 *  only signal Letta gives; patterns are from observed text where noted. */
export function classifyLettaError(message: string): LettaAttentionCode {
  // Observed: "Provider is not configured: openai-codex" (2026-10-07 probe).
  if (/provider is not configured|not authenticated|unauthori[sz]ed|\b401\b|invalid api key|missing api key|please (?:log ?in|sign in)|login required/i.test(message)) {
    return "letta_auth_required";
  }
  if (/agent[^\n]{0,80}not found|no agent (?:found|with id)/i.test(message)) return "letta_agent_missing";
  if (/conversation[^\n]{0,80}not found|no conversation (?:found|with id)/i.test(message)) return "letta_conversation_missing";
  return "runtime_error";
}

/** The system/init fields Letta Code 0.33.x-0.34.x declares as always present
 *  (SystemInitMessage in dist/types/types/protocol.d.ts, identical in 0.33.3,
 *  0.33.7 and 0.34.4). agent_id is typed nullable and is checked by
 *  verifyLettaInit instead. The record carries no CLI version, so the runner
 *  records none; a missing or retyped field is the only drift signal. */
const LETTA_INIT_STRING_FIELDS = ["session_id", "uuid", "conversation_id", "model", "cwd", "permission_mode"] as const;
const LETTA_INIT_ARRAY_FIELDS = ["tools", "mcp_servers", "slash_commands"] as const;

/** Names of expected system/init fields that are missing or of another type.
 *  Empty when the shape is the recognized one. */
export function lettaInitShapeGaps(record: Record<string, unknown>): string[] {
  return [
    ...LETTA_INIT_STRING_FIELDS.filter((name) => typeof record[name] !== "string"),
    ...LETTA_INIT_ARRAY_FIELDS.filter((name) => !Array.isArray(record[name])),
  ];
}

/** Check system/init against what this launch was asked to open. */
export function verifyLettaInit(
  mode: LettaLaunchMode,
  init: { agentId: string | null; conversationId: string | null },
): { ok: true } | { ok: false; reason: string } {
  if (!init.agentId || !init.conversationId) return { ok: false, reason: "system/init carried no agent_id or conversation_id" };
  if (mode.kind === "bind" && init.agentId !== mode.agentId) {
    return { ok: false, reason: `bound agent ${mode.agentId} but init reported ${init.agentId}` };
  }
  if (mode.kind === "resume") {
    if (init.conversationId !== mode.conversationId) {
      return { ok: false, reason: `resumed ${mode.conversationId} but init reported ${init.conversationId}` };
    }
    if (mode.expectAgentId && init.agentId !== mode.expectAgentId) {
      return { ok: false, reason: `expected agent ${mode.expectAgentId} but init reported ${init.agentId}` };
    }
  }
  return { ok: true };
}

export type LettaExitOutcome =
  /** Exit 0, no turn in flight. */
  | "clean"
  /** Non-zero exit, but the last turn's `result` already arrived: the turn
   *  stands (Windows exit-127 after a good run). */
  | "crashed_after_result"
  /** The child died with a turn in flight and no `result`. */
  | "crashed_mid_turn"
  /** Non-zero exit before any turn completed. */
  | "failed";

export function classifyLettaExit(opts: { code: number | null; turnInFlight: boolean; lastResult: string | undefined }): LettaExitOutcome {
  if (opts.turnInFlight) return "crashed_mid_turn";
  if (opts.code === 0) return "clean";
  return opts.lastResult ? "crashed_after_result" : "failed";
}

// ── Event → mirror + activity mapping (stateless) ───────────────────────────

export interface LettaMirrorAndActivity {
  mirrorLines: string[];
  mirrorAppend?: string;
  activity?: { hookEvent: string; subtype: string | null };
  errorNotice?: string;
  attention?: LettaAttentionCode;
}

function oneLine(text: string, max = 400): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Stateless mapping. Turn bookkeeping (first activity, tool names by id,
 *  text accumulation, one-line-per-turn gating) lives in the runner core. */
export function mapLettaEvent(event: LettaEvent): LettaMirrorAndActivity {
  switch (event.kind) {
    case "assistant_chunk":
      return event.text ? { mirrorLines: [], mirrorAppend: event.text } : { mirrorLines: [] };
    case "tool_call":
      return { mirrorLines: [`  ⚙ ${event.toolName} …`], activity: { hookEvent: "PreToolUse", subtype: event.toolName } };
    case "approval_requested":
      return {
        mirrorLines: [`${LETTA_RUNNER_ERROR_MARKER} approval requested for ${event.toolName}; denied because the managed pane cannot answer it. Re-send a safe instruction, or attach permission_policy builtin:yolo to the seat to let it run tools unattended.`],
        activity: { hookEvent: "Notification", subtype: "permission_prompt" },
        attention: "letta_approval_pending",
      };
    case "retry":
      return { mirrorLines: ["[letta] transient error — retrying"], activity: { hookEvent: "active", subtype: "auto_retry" } };
    case "error": {
      const message = oneLine(event.message);
      return {
        mirrorLines: [],
        errorNotice: `${LETTA_RUNNER_ERROR_MARKER} ${message || "request failed"}`,
        attention: classifyLettaError(event.message),
      };
    }
    case "result":
      if (event.subtype === "success") return { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "result_success" } };
      if (event.subtype === "interrupted") return { mirrorLines: ["", "[letta-runner] turn interrupted"], activity: { hookEvent: "Stop", subtype: "result_interrupted" } };
      return {
        mirrorLines: [""],
        activity: { hookEvent: "Stop", subtype: `result_${event.subtype}` },
        errorNotice: `${LETTA_RUNNER_ERROR_MARKER} turn ended with result/${event.subtype}${event.stopReason ? ` (${event.stopReason})` : ""}`,
        attention: "runtime_error",
      };
    case "queue":
      return event.event === "queue_batch_dequeued" && (event.mergedCount ?? 1) > 1
        ? { mirrorLines: [`[letta-runner] note: Letta merged ${event.mergedCount} queued inputs into one turn`] }
        : { mirrorLines: [] };
    default:
      return { mirrorLines: [] };
  }
}
