// R&D Exp 03 — hermetic tests for the letta-runner core and its child seam,
// replaying recorded Letta stream-json (fixtures/letta/) through an injected
// fake child. No letta process, no Letta server.

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  LettaRunnerCore, attachLettaChild, parseLettaRunnerArgs, LETTA_ERROR_STALL_MS,
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

describe("LettaRunnerCore recovers a wedged turn by restarting letta in the same conversation (2026-10-13)", () => {
  const errorLine = (message: string) => JSON.stringify({ type: "error", message });
  function withRestart(start = "2026-10-13T03:00:00.000Z") {
    const t = core();
    let now = Date.parse(start);
    const restartChild = vi.fn();
    t.io.now = () => new Date(now).toISOString();
    t.io.restartChild = restartChild;
    return { ...t, restartChild, advance: (ms: number) => { now += ms; return now; } };
  }

  it("a dead run (\"already has an active run\") restarts at once, keeping the queue, and the fresh child takes it", () => {
    const t = withRestart();
    const [init] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("first");
    t.core.handleUserBlock("second");                     // held behind the turn in flight
    t.core.handleLine(errorLine("Conversation local-conv-4 already has an active run (local-run-235)"));
    expect(t.restartChild).toHaveBeenCalledTimes(1);
    expect(t.core.isRestarting()).toBe(true);
    expect(t.core.queuedCount()).toBe(1);
    expect(t.mirror.join("\n")).toMatch(/restarting letta in the same conversation \(1 queued input\(s\) kept\)/);
    expect(t.core.resumeTarget()).toEqual({ conversationId: "local-conv-4", agentId: AGENT });
    // the old child's exit is not the runner's end, and reports nothing undelivered
    t.core.handleChildExit(143);
    expect(t.mirror.join("\n")).not.toMatch(/were not delivered/);
    expect(t.mirror.join("\n")).toMatch(/letta stopped for a restart/);
    // the fresh child is up: the held input goes to it
    t.core.handleLine(init!);
    expect(t.core.isRestarting()).toBe(false);
    expect(userLines(t.stdin).map((m) => m.message.content)).toEqual(["first", "second"]);
  });

  it("an errored turn with no record and no result for the stall time restarts; not a moment before", () => {
    const t = withRestart();
    const [init] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("first");
    t.core.handleLine(errorLine("The operation was aborted due to timeout"));
    t.core.tick(t.advance(LETTA_ERROR_STALL_MS - 1_000));
    expect(t.restartChild).not.toHaveBeenCalled();
    t.core.tick(t.advance(1_000));
    expect(t.restartChild).toHaveBeenCalledTimes(1);
  });

  it("an error that letta goes on from (its own retry: more records) is not a wedge", () => {
    const t = withRestart();
    const [init, ...rest] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("first");
    t.core.handleLine(errorLine("exceeded request buffer limit while retrying upstream"));
    t.advance(40_000);
    t.core.handleLine(rest[0]!);                              // the turn goes on
    t.core.tick(t.advance(40_000));                           // 80 s after the error, 40 s after the last record
    expect(t.restartChild).not.toHaveBeenCalled();
    for (const line of rest.slice(1)) t.core.handleLine(line); // and ends with its result
    t.core.tick(t.advance(LETTA_ERROR_STALL_MS));
    expect(t.restartChild).not.toHaveBeenCalled();
    expect(t.core.isTurnInFlight()).toBe(false);
  });

  it("an entry that cannot restart (no restartChild) keeps the old behaviour: nothing restarts", () => {
    const t = core();
    const [init] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("first");
    t.core.handleLine(errorLine("Conversation local-conv-4 already has an active run (local-run-1)"));
    expect(t.core.isRestarting()).toBe(false);
    expect(t.core.isTurnInFlight()).toBe(true);
  });
});

describe("a plain runtime error leaves the lead idle and taking input, not waiting on a person (2026-10-13)", () => {
  const errorLine = (message: string) => JSON.stringify({ type: "error", message });
  const resultError = JSON.stringify({ type: "result", subtype: "error", result: "", conversation_id: "local-conv-4" });

  it("a provider timeout that ends its turn posts Stop (idle), clears the attention, and the next input goes", () => {
    const t = core();
    t.core.handleLine(lines("turn-success.jsonl")[0]!);
    t.core.handleUserBlock("first");
    t.core.handleLine(errorLine("The operation was aborted due to timeout"));
    t.core.handleLine(resultError);
    expect(t.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "result_error" });
    expect(t.activity.at(-1)?.attentionCode).toBeUndefined();
    expect(t.sidecars.at(-1)?.attention).toBeUndefined();
    expect(t.mirror.join("\n")).toMatch(/ERROR The operation was aborted due to timeout/);  // the pane still says so
    t.core.handleUserBlock("carry on");
    expect(userLines(t.stdin).map((m) => m.message.content)).toEqual(["first", "carry on"]);
  });

  it("a restart posts Stop (idle) at once, and Stop again once the fresh child is up with nothing queued", () => {
    const t = core();
    const restartChild = vi.fn();
    t.io.restartChild = restartChild;
    const [init] = lines("turn-success.jsonl");
    t.core.handleLine(init!);
    t.core.handleUserBlock("first");
    t.core.handleLine(errorLine("Conversation local-conv-4 already has an active run (local-run-9)"));
    expect(restartChild).toHaveBeenCalledTimes(1);
    expect(t.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "result_error_restart" });
    expect(t.activity.some((a) => a.subtype === "runtime_error" && a.attentionCode === "runtime_error")).toBe(true); // the error itself was raised
    t.core.handleChildExit(143);
    t.core.handleLine(init!);
    expect(t.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "restarted_idle" });
  });

  it("the stall is a minute", () => {
    expect(LETTA_ERROR_STALL_MS).toBe(60_000);
  });
});
