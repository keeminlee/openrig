// R&D Exp 03 — hermetic tests for the letta-runner protocol, driven by real
// Letta Code stream-json recordings (2026-10-07 probe, isolated local backend,
// throwaway agent; local ids only). No letta process, no Letta server.
//
// fixtures/letta/
//   turn-success.jsonl            one real turn: init → 4 assistant chunks →
//                                 usage → stop_reason → result/success
//   provider-not-configured.jsonl init → error → stop_reason → error; no
//                                 result record (a one-shot run)
//   queued-batch-error.jsonl      two user lines queued then merged into one
//                                 turn (queue_batch_dequeued merged_count 2),
//                                 which fails → result/error

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildLettaChildArgs, buildLettaChildEnv, buildLettaRunnerCommand, classifyLettaError, classifyLettaExit,
  classifyLettaRecord, encodeLettaInterrupt, encodeLettaToolDenial, encodeLettaUserTurn, formatLettaResumeToken,
  mapLettaEvent, parseLettaLine, parseLettaResumeToken, parseLettaRunnerState, verifyLettaInit,
  buildPendingLettaRunnerState, lettaSeatPaths, lettaInitShapeGaps,
  type LettaEvent,
} from "../src/adapters/letta-runner-protocol.js";

function fixture(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(`./fixtures/letta/${name}`, import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AGENT = "agent-local-7b32f134-b521-41c0-98b1-8f9a31c39d08";

describe("classifyLettaRecord on recorded stream-json", () => {
  it("extracts identity from system/init", () => {
    const [init] = fixture("turn-success.jsonl").map(classifyLettaRecord);
    expect(init).toEqual({
      kind: "init", agentId: AGENT, conversationId: "local-conv-4", model: "openai-codex/gpt-5.5", mcpServers: [],
    });
  });

  it("recognizes the recorded system/init shape and names fields that drift", () => {
    for (const name of ["turn-success.jsonl", "queued-batch-error.jsonl", "provider-not-configured.jsonl"]) {
      expect(lettaInitShapeGaps(fixture(name)[0]!)).toEqual([]);
    }
    const { session_id: _s, tools: _t, ...drifted } = fixture("turn-success.jsonl")[0]!;
    expect(lettaInitShapeGaps({ ...drifted, permission_mode: null })).toEqual(["session_id", "permission_mode", "tools"]);
  });

  it("accumulated assistant chunks equal the result text", () => {
    const events = fixture("turn-success.jsonl").map(classifyLettaRecord);
    const chunks = events.filter((e): e is Extract<LettaEvent, { kind: "assistant_chunk" }> => e.kind === "assistant_chunk");
    expect(chunks.length).toBe(4);
    const result = events.find((e): e is Extract<LettaEvent, { kind: "result" }> => e.kind === "result");
    expect(result?.subtype).toBe("success");
    expect(result?.conversationId).toBe("local-conv-4");
    expect(chunks.map((c) => c.text).join("")).toBe(result?.text);
    expect(result?.text).toBe("PROBE-A OK");
  });

  it("classifies the full success sequence in order", () => {
    expect(fixture("turn-success.jsonl").map((r) => classifyLettaRecord(r).kind)).toEqual([
      "init", "assistant_chunk", "assistant_chunk", "assistant_chunk", "assistant_chunk", "usage", "stop_reason", "result",
    ]);
  });

  it("classifies the queued batch and its failure", () => {
    const events = fixture("queued-batch-error.jsonl").map(classifyLettaRecord);
    expect(events.map((e) => e.kind)).toEqual(["init", "queue", "queue", "queue", "queue", "error", "stop_reason", "result"]);
    const batch = events.find((e) => e.kind === "queue" && e.event === "queue_batch_dequeued");
    expect(batch).toEqual({ kind: "queue", event: "queue_batch_dequeued", mergedCount: 2 });
    const result = events.at(-1) as Extract<LettaEvent, { kind: "result" }>;
    expect(result).toMatchObject({ subtype: "error", stopReason: "error", text: "" });
  });

  it("parses non-JSON stdout as raw so it can be mirrored", () => {
    expect(parseLettaLine("  ")).toBeNull();
    expect(parseLettaLine("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)")).toEqual({ raw: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" });
    expect(parseLettaLine("[1,2]")).toEqual({ raw: "[1,2]" });
  });

  it("classifies tool and approval records from the CLI's declared wire types", () => {
    expect(classifyLettaRecord({ type: "message", message_type: "tool_call_message", tool_call: { name: "exec_command", tool_call_id: "tc-1" } }))
      .toEqual({ kind: "tool_call", toolCallId: "tc-1", toolName: "exec_command" });
    expect(classifyLettaRecord({ type: "tool_execution_finished", tool_call_id: "tc-1", status: "error" }))
      .toEqual({ kind: "tool_finished", toolCallId: "tc-1", failed: true });
    expect(classifyLettaRecord({ type: "control_request", request_id: "perm-tc-1", request: { subtype: "can_use_tool", tool_name: "exec_command", tool_call_id: "tc-1" } }))
      .toEqual({ kind: "approval_requested", toolCallId: "tc-1", toolName: "exec_command", requestId: "perm-tc-1" });
  });
});

describe("attention classification", () => {
  it("provider-not-configured errors map to letta_auth_required", () => {
    for (const name of ["provider-not-configured.jsonl", "queued-batch-error.jsonl"]) {
      const errors = fixture(name).map(classifyLettaRecord).filter((e): e is Extract<LettaEvent, { kind: "error" }> => e.kind === "error");
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) {
        expect(classifyLettaError(error.message)).toBe("letta_auth_required");
        const mapped = mapLettaEvent(error);
        expect(mapped.attention).toBe("letta_auth_required");
        expect(mapped.errorNotice).toMatch(/^\[letta-runner\] ERROR .*Provider is not configured: openai-codex/);
      }
    }
  });

  it("maps missing agents and conversations, and leaves the rest generic", () => {
    expect(classifyLettaError("Agent agent-x not found")).toBe("letta_agent_missing");
    expect(classifyLettaError("Conversation local-conv-9 not found")).toBe("letta_conversation_missing");
    expect(classifyLettaError("Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.")).toBe("runtime_error");
  });

  it("an approval request asks for operator attention", () => {
    const mapped = mapLettaEvent({ kind: "approval_requested", toolCallId: "tc-1", toolName: "exec_command", requestId: "perm-tc-1" });
    expect(mapped.attention).toBe("letta_approval_pending");
    expect(mapped.activity).toEqual({ hookEvent: "Notification", subtype: "permission_prompt" });
  });

  it("result records map to Stop, and result/error also to attention", () => {
    const base = { text: null, agentId: null, conversationId: null, stopReason: null };
    expect(mapLettaEvent({ kind: "result", subtype: "success", ...base }).activity).toEqual({ hookEvent: "Stop", subtype: "result_success" });
    expect(mapLettaEvent({ kind: "result", subtype: "interrupted", ...base }).attention).toBeUndefined();
    expect(mapLettaEvent({ kind: "result", subtype: "error", ...base, stopReason: "error" }).attention).toBe("runtime_error");
  });

  it("a merged batch is said out loud in the pane", () => {
    expect(mapLettaEvent({ kind: "queue", event: "queue_batch_dequeued", mergedCount: 2 }).mirrorLines)
      .toEqual(["[letta-runner] note: Letta merged 2 queued inputs into one turn"]);
    expect(mapLettaEvent({ kind: "queue", event: "queue_batch_dequeued", mergedCount: 1 }).mirrorLines).toEqual([]);
  });
});

describe("child argv", () => {
  it("bind opens a new conversation on an existing agent", () => {
    expect(buildLettaChildArgs({ mode: { kind: "bind", agentId: AGENT }, permissionMode: "standard" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "standard", "--no-mods",
      "--agent", AGENT, "--new",
    ]);
  });

  it("resume passes --conversation alone and never --agent", () => {
    for (const mode of [
      { kind: "resume" as const, conversationId: "local-conv-4" },
      { kind: "resume" as const, conversationId: "conv-abc123", expectAgentId: AGENT },
    ]) {
      const args = buildLettaChildArgs({ mode, permissionMode: "strict", model: "openai-codex/gpt-5.5" });
      expect(args).not.toContain("--agent");
      expect(args).not.toContain("--new");
      expect(args).not.toContain("--model");
      expect(args.slice(-2)).toEqual(["--conversation", mode.conversationId]);
    }
  });

  it("the pane command for resume never carries --agent either", () => {
    const command = buildLettaRunnerCommand({
      runnerEntryPath: "/dist/adapters/letta-runner.js", sessionName: "letta-a@rig", stateRoot: "/state/letta",
      cwd: "/work", launchId: "launch-1", permissionMode: "standard",
      mode: { kind: "resume", conversationId: "local-conv-4", expectAgentId: AGENT },
    });
    expect(command).not.toMatch(/--agent /);
    expect(command).toContain("--conversation 'local-conv-4'");
    expect(command).toContain(`--expect-agent '${AGENT}'`);
  });

  it("create requires the explicit opt-in and is the only mode that takes a model", () => {
    expect(buildLettaChildArgs({ mode: { kind: "create", allowCreateAgent: true }, permissionMode: "standard", model: "openai-codex/gpt-5.5" }).slice(-3))
      .toEqual(["--new-agent", "--model", "openai-codex/gpt-5.5"]);
    expect(() => buildLettaChildArgs({ mode: { kind: "create", allowCreateAgent: false as unknown as true }, permissionMode: "standard" }))
      .toThrow(/explicit opt-in/);
    expect(buildLettaChildArgs({ mode: { kind: "bind", agentId: AGENT }, permissionMode: "standard", model: "x/y" })).not.toContain("--model");
  });

  it("refuses malformed ids, `default`, and an unknown permission mode", () => {
    expect(() => buildLettaChildArgs({ mode: { kind: "bind", agentId: "--new-agent" }, permissionMode: "standard" })).toThrow(/agent id/);
    expect(() => buildLettaChildArgs({ mode: { kind: "resume", conversationId: "default" }, permissionMode: "standard" })).toThrow(/conversation id/);
    expect(() => buildLettaChildArgs({ mode: { kind: "bind", agentId: AGENT }, permissionMode: "yolo" as never })).toThrow(/permission mode/);
  });
});

describe("stdin encoding", () => {
  it("a multi-line user turn is exactly one stream-json line", () => {
    const line = encodeLettaUserTurn("From: claude-seat\nTo: letta-seat\n\nhello");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: "From: claude-seat\nTo: letta-seat\n\nhello" } });
  });

  it("interrupt and tool denial match the CLI's control shapes", () => {
    expect(JSON.parse(encodeLettaInterrupt("i-1"))).toEqual({ type: "control_request", request_id: "i-1", request: { subtype: "interrupt" } });
    expect(JSON.parse(encodeLettaToolDenial("perm-tc-1", "no"))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "perm-tc-1", response: { behavior: "deny", message: "no", interrupt: true } },
    });
  });
});

describe("identity, exit and sidecar", () => {
  it("verifies init against the launch mode", () => {
    const init = { agentId: AGENT, conversationId: "local-conv-4" };
    expect(verifyLettaInit({ kind: "bind", agentId: AGENT }, init)).toEqual({ ok: true });
    expect(verifyLettaInit({ kind: "bind", agentId: "agent-other" }, init).ok).toBe(false);
    expect(verifyLettaInit({ kind: "resume", conversationId: "local-conv-4", expectAgentId: AGENT }, init)).toEqual({ ok: true });
    expect(verifyLettaInit({ kind: "resume", conversationId: "local-conv-5" }, init).ok).toBe(false);
    expect(verifyLettaInit({ kind: "create", allowCreateAgent: true }, { agentId: null, conversationId: "local-conv-1" }).ok).toBe(false);
  });

  it("exit 127 after a success result is not a failed turn", () => {
    expect(classifyLettaExit({ code: 127, turnInFlight: false, lastResult: "success" })).toBe("crashed_after_result");
    expect(classifyLettaExit({ code: 0, turnInFlight: false, lastResult: "success" })).toBe("clean");
    expect(classifyLettaExit({ code: 127, turnInFlight: true, lastResult: "success" })).toBe("crashed_mid_turn");
    expect(classifyLettaExit({ code: 1, turnInFlight: false, lastResult: undefined })).toBe("failed");
  });

  it("resume token round-trips and rejects malformed tokens", () => {
    const token = formatLettaResumeToken(AGENT, "local-conv-4");
    expect(parseLettaResumeToken(token)).toEqual({ agentId: AGENT, conversationId: "local-conv-4" });
    expect(parseLettaResumeToken("local-conv-4")).toBeNull();
    expect(parseLettaResumeToken(`${AGENT}/default`)).toBeNull();
  });

  it("the pending sidecar carries no prior identity and parses back", () => {
    const pending = buildPendingLettaRunnerState("launch-2", "2026-10-08T00:00:00Z");
    expect(pending).toEqual({ ready: false, launchId: "launch-2", updatedAt: "2026-10-08T00:00:00Z" });
    expect(parseLettaRunnerState(JSON.stringify(pending))).toEqual(pending);
    expect(parseLettaRunnerState("{\"ready\":\"yes\"}")).toBeNull();
    expect(lettaSeatPaths("/state/letta", "s1").runnerStatePath.replace(/\\/g, "/")).toBe("/state/letta/s1/runner-state.json");
  });

  it("child env is deny-by-default and pins the updater and mods off", () => {
    const env = buildLettaChildEnv({
      PATH: "/bin", HOME: "/home/x", LETTA_LOCAL_BACKEND_DIR: "/b", OPENRIG_SESSION_NAME: "s1",
      POSTMARK_API_KEY: "secret", DISCORD_BOT_TOKEN: "secret", OPENAI_API_KEY: "secret", OPENRIG_ACTIVITY_HOOK_TOKEN: "secret",
    });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/home/x", LETTA_LOCAL_BACKEND_DIR: "/b", OPENRIG_SESSION_NAME: "s1",
      OPENRIG_RUNTIME: "letta", DISABLE_AUTOUPDATER: "1", LETTA_DISABLE_MODS: "1",
    });
  });
});
