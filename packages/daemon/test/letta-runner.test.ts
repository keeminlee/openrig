// R&D Exp 03 — hermetic tests for the letta-runner core and its child seam,
// replaying recorded Letta stream-json (fixtures/letta/) through an injected
// fake child. No letta process, no Letta server.

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  LettaRunnerCore, attachLettaChild, parseLettaRunnerArgs,
  type LettaChildLike, type LettaRunnerIo,
} from "../src/adapters/letta-runner.js";
import {
  LETTA_RUNNER_READY_MARKER, LETTA_RUNNER_EXIT_MARKER, LETTA_RUNNER_ERROR_MARKER,
  type LettaLaunchMode, type LettaRunnerState,
} from "../src/adapters/letta-runner-protocol.js";

const AGENT = "agent-local-7b32f134-b521-41c0-98b1-8f9a31c39d08";

function lines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/letta/${name}`, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.trim());
}

function fakeIo() {
  const stdin: string[] = [];
  const mirror: string[] = [];
  const appends: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: LettaRunnerState[] = [];
  const stopChild = vi.fn();
  const io: LettaRunnerIo = {
    writeStdin: (line) => stdin.push(line),
    mirrorLine: (line) => mirror.push(line),
    mirrorAppend: (text) => appends.push(text),
    postActivity: (payload) => activity.push(payload),
    writeSidecar: (state) => sidecars.push(state),
    stopChild,
    now: () => "2026-10-08T00:00:00Z",
  };
  return { io, stdin, mirror, appends, activity, sidecars, stopChild };
}

function core(mode: LettaLaunchMode = { kind: "bind", agentId: AGENT }) {
  const f = fakeIo();
  const c = new LettaRunnerCore(f.io, { sessionName: "letta-a@rig", nodeId: "node-1", launchId: "launch-1" }, mode);
  return { core: c, ...f };
}

const userLines = (stdin: string[]) => stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user");

describe("LettaRunnerCore on a recorded successful turn", () => {
  it("becomes ready from system/init and posts identity", () => {
    const t = core();
    const [init] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    expect(t.core.isReady()).toBe(true);
    expect(t.mirror).toContain(`${LETTA_RUNNER_READY_MARKER} agent=${AGENT} conversation=local-conv-4 model=openai-codex/gpt-5.5`);
    expect(t.sidecars.at(-1)).toMatchObject({ ready: true, launchId: "launch-1", agentId: AGENT, conversationId: "local-conv-4" });
    expect(t.activity[0]).toMatchObject({
      eventFamily: "session_identity", runtime: "letta", sessionId: "local-conv-4",
      resumeType: "letta_conversation", resumeToken: `${AGENT}/local-conv-4`,
    });
    expect(t.sidecars.at(-1)?.streamAdvisory).toBeUndefined();
    expect(t.mirror.some((l) => l.includes("note: system/init"))).toBe(false);
  });

  it("an unrecognized system/init shape is an advisory, not a failure: still ready, still verified", () => {
    const t = core();
    const [init] = lines("turn-success.jsonl");
    const { tools: _tools, slash_commands: _slash, ...rest } = JSON.parse(init!) as Record<string, unknown>;
    t.core.handleLine(JSON.stringify(rest));
    expect(t.core.isReady()).toBe(true);
    const advisory = t.sidecars.at(-1)?.streamAdvisory;
    expect(advisory).toMatch(/system\/init shape not recognized \(missing or retyped: tools, slash_commands\)/);
    expect(t.sidecars.at(-1)).toMatchObject({ ready: true, agentId: AGENT, conversationId: "local-conv-4" });
    expect(t.mirror).toContain(`[letta-runner] note: ${advisory}`);
    expect(t.activity[0]).toMatchObject({ eventFamily: "session_identity", resumeToken: `${AGENT}/local-conv-4` });
  });

  it("sends one user line per turn and holds the next until result", () => {
    const t = core();
    const [init, ...rest] = lines("turn-success.jsonl");
    t.core.handleUserBlock("first");           // before init: held
    expect(t.stdin).toEqual([]);
    t.core.handleLine(init!);                  // ready: first is sent
    t.core.handleUserBlock("second");          // turn in flight: held
    expect(userLines(t.stdin).map((m) => m.message.content)).toEqual(["first"]);
    expect(t.core.queuedCount()).toBe(1);
    for (const line of rest) t.core.handleLine(line);
    // result arrived: second is sent now, and only now
    expect(userLines(t.stdin).map((m) => m.message.content)).toEqual(["first", "second"]);
    expect(t.core.isTurnInFlight()).toBe(true);
  });

  it("mirrors the streamed text, which equals the result text", () => {
    const t = core();
    const [init, ...rest] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("say PROBE-A OK");
    for (const line of rest) t.core.handleLine(line);
    expect(t.appends.join("")).toBe("PROBE-A OK");
    expect(t.core.lastTurn()).toEqual({ streamedText: "PROBE-A OK", resultText: "PROBE-A OK", subtype: "success" });
    const hooks = t.activity.filter((a) => !a.eventFamily).map((a) => `${a.hookEvent}/${a.subtype}`);
    expect(hooks).toEqual(["active/turn_start", "Stop/result_success"]);
  });

  it("falls back to the result text when no chunks streamed", () => {
    const t = core();
    const all = lines("turn-success.jsonl");
    t.core.handleLine(all[0]!);
    t.core.handleUserBlock("x");
    for (const line of all.slice(1).filter((l) => !l.includes("\"assistant_message\""))) t.core.handleLine(line);
    expect(t.appends.join("")).toBe("PROBE-A OK");
  });
});

describe("LettaRunnerCore on a recorded auth failure", () => {
  it("raises letta_auth_required and ends the turn as attention, not idle", () => {
    const t = core();
    const all = lines("queued-batch-error.jsonl");
    t.core.handleLine(all[0]!);
    t.core.handleUserBlock("hello");
    for (const line of all.slice(1)) t.core.handleLine(line);
    expect(t.mirror.filter((l) => l.startsWith(LETTA_RUNNER_ERROR_MARKER))).toEqual([
      `${LETTA_RUNNER_ERROR_MARKER} Provider is not configured: openai-codex`,
    ]);
    const hooks = t.activity.filter((a) => !a.eventFamily);
    expect(hooks.some((a) => a.hookEvent === "Stop")).toBe(false);
    expect(hooks.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "runtime_error", attentionCode: "letta_auth_required" });
    expect(t.sidecars.at(-1)).toMatchObject({ attention: "letta_auth_required" });
    expect(t.mirror).toContain("[letta-runner] note: Letta merged 2 queued inputs into one turn");
    expect(t.core.isTurnInFlight()).toBe(false);
  });

  it("clears the attention when the next turn is sent", () => {
    const t = core();
    const all = lines("queued-batch-error.jsonl");
    t.core.handleLine(all[0]!);
    t.core.handleUserBlock("hello");
    for (const line of all.slice(1)) t.core.handleLine(line);
    t.core.handleUserBlock("again");
    expect(userLines(t.stdin)).toHaveLength(2);
    t.core.handleLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", conversation_id: "local-conv-2" }));
    expect(t.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "result_success" });
    expect(t.sidecars.at(-1)?.attention).toBeUndefined();
  });
});

describe("LettaRunnerCore identity and control", () => {
  it("refuses an init that does not match the bound agent", () => {
    const t = core({ kind: "bind", agentId: "agent-local-someone-else" });
    t.core.handleUserBlock("hi");
    t.core.handleLine(lines("turn-success.jsonl")[0]!);
    expect(t.core.isReady()).toBe(false);
    expect(t.stdin).toEqual([]);
    expect(t.stopChild).toHaveBeenCalledOnce();
    expect(t.mirror.at(-1)).toMatch(/^\[letta-runner\] ERROR identity: bound agent/);
    expect(t.sidecars.at(-1)).toMatchObject({ ready: false, attention: "letta_identity_mismatch" });
  });

  it("accepts a resume whose init reports the same conversation", () => {
    const t = core({ kind: "resume", conversationId: "local-conv-4", expectAgentId: AGENT });
    t.core.handleLine(lines("turn-success.jsonl")[0]!);
    expect(t.core.isReady()).toBe(true);
  });

  it("denies a can_use_tool request at once and asks for attention", () => {
    const t = core();
    t.core.handleLine(lines("turn-success.jsonl")[0]!);
    t.core.handleUserBlock("run ls");
    t.core.handleLine(JSON.stringify({ type: "message", message_type: "tool_call_message", tool_call: { name: "exec_command", tool_call_id: "tc-1" } }));
    t.core.handleLine(JSON.stringify({ type: "approval_requested", request_id: "perm-tc-1", tool_call_id: "tc-1", tool_name: "exec_command" }));
    t.core.handleLine(JSON.stringify({ type: "control_request", request_id: "perm-tc-1", request: { subtype: "can_use_tool", tool_name: "exec_command", tool_call_id: "tc-1", input: {} } }));
    const denials = t.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "control_response");
    expect(denials).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "perm-tc-1", response: expect.objectContaining({ behavior: "deny", interrupt: true }) } }]);
    expect(t.activity.filter((a) => a.attentionCode === "letta_approval_pending")).toHaveLength(1);
    expect(t.activity.some((a) => a.hookEvent === "PreToolUse" && a.subtype === "exec_command")).toBe(true);
  });

  it("/abort sends an interrupt only while a turn is in flight", () => {
    const t = core();
    t.core.handleLine(lines("turn-success.jsonl")[0]!);
    t.core.handleUserBlock("/abort");
    expect(t.stdin).toEqual([]);
    t.core.handleUserBlock("work");
    t.core.handleUserBlock("/abort");
    expect(JSON.parse(t.stdin.at(-1)!)).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
  });
});

class FakeChild extends EventEmitter implements LettaChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

function runChild(fixtureLines: string[], exitCode: number, beforeExit?: (c: LettaRunnerCore) => void) {
  const t = core();
  const child = new FakeChild();
  return new Promise<typeof t & { exitedWith: number | null }>((resolve) => {
    attachLettaChild(child, t.core, t.io.mirrorLine, (code) => resolve({ ...t, exitedWith: code }));
    t.core.handleUserBlock("say PROBE-A OK");
    for (const line of fixtureLines) child.stdout.write(`${line}\n`);
    setImmediate(() => {
      beforeExit?.(t.core);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", exitCode);
    });
  });
}

describe("attachLettaChild with a fake child", () => {
  it("exit 127 after a success result keeps the turn as success", async () => {
    const r = await runChild(lines("turn-success.jsonl"), 127);
    expect(r.exitedWith).toBe(127);
    expect(r.core.lastTurn()?.subtype).toBe("success");
    expect(r.mirror.some((l) => l.startsWith(LETTA_RUNNER_ERROR_MARKER))).toBe(false);
    expect(r.mirror.at(-1)).toBe(`${LETTA_RUNNER_EXIT_MARKER} letta exited (code 127) after its last turn completed with result/success; that result stands`);
    expect(r.sidecars.at(-1)).toMatchObject({ ready: false, exited: { code: 127, lastResult: "success" } });
  });

  it("exit with a turn in flight and no result is reported as such", async () => {
    const r = await runChild(lines("turn-success.jsonl").slice(0, 3), 127);
    expect(r.mirror).toContain(`${LETTA_RUNNER_ERROR_MARKER} letta exited (code 127) with a turn in flight and no result`);
    expect(r.sidecars.at(-1)?.exited?.lastResult).toBeUndefined();
  });

  it("a result written just before exit is still counted", async () => {
    // stdout and the exit event race; the exit is recorded after the drain.
    const r = await runChild(lines("turn-success.jsonl"), 0);
    expect(r.mirror.at(-1)).toBe(`${LETTA_RUNNER_EXIT_MARKER} letta exited (code 0)`);
  });
});

describe("parseLettaRunnerArgs", () => {
  const base = ["--session-name", "s", "--state-root", "/st", "--cwd", "/w", "--launch-id", "l1", "--permission-mode", "standard"];
  it("parses each launch mode", () => {
    expect(parseLettaRunnerArgs([...base, "--agent", AGENT]).mode).toEqual({ kind: "bind", agentId: AGENT });
    expect(parseLettaRunnerArgs([...base, "--conversation", "local-conv-4", "--expect-agent", AGENT]).mode)
      .toEqual({ kind: "resume", conversationId: "local-conv-4", expectAgentId: AGENT });
    expect(parseLettaRunnerArgs([...base, "--create-agent"]).mode).toEqual({ kind: "create", allowCreateAgent: true });
  });
  it("requires exactly one mode and an explicit permission mode", () => {
    expect(() => parseLettaRunnerArgs([...base, "--agent", AGENT, "--conversation", "local-conv-4"])).toThrow(/exactly one/);
    expect(() => parseLettaRunnerArgs(base)).toThrow(/exactly one/);
    expect(() => parseLettaRunnerArgs(base.slice(0, -2).concat("--agent", AGENT))).toThrow(/permission-mode/);
  });
});
