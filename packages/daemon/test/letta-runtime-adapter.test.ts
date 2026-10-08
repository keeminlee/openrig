// R&D Exp 03 step 3 — hermetic tests for the Letta runtime adapter. No live
// Letta and no daemon: launch COMMAND CONSTRUCTION (bind / resume / create),
// fork refusal, resume-token validation, readiness from the runner sidecar,
// startup/projection targets, and the harness-native continuity refusal are
// all pure or fake-backed. The live round trip is a separate step.

import nodePath from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  LettaRuntimeAdapter, parseLettaAgentBinding, LETTA_AGENT_BINDING_RESOURCE_TYPE,
  type LettaAdapterFsOps,
} from "../src/adapters/letta-runtime-adapter.js";
import { lettaSeatPaths } from "../src/adapters/letta-runner-protocol.js";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";
import { isAttentionRequiredReadinessCode } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import type { AgentSpec, RigSpecPodMember } from "../src/domain/types.js";

const STATE_ROOT = "/openrig-home/state/letta";
const RUNNER = "/daemon-dist/adapters/letta-runner.js";
const SESSION = "talk-letta@bridge-rig";
const AGENT = "agent-local-0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const CONV = "local-conv-2";
const TOKEN = `${AGENT}/${CONV}`;
const CWD = "/work";
const paths = lettaSeatPaths(STATE_ROOT, SESSION);
const BINDING_PATH = nodePath.join(paths.seatRoot, "agent-binding.json");
const PENDING_PATH = nodePath.join(paths.seatRoot, "pending-guidance.json");

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendShellCommand?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: overrides?.sendShellCommand ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "node"),
  } as unknown as TmuxAdapter;
}

function memFs(files: Record<string, string> = {}): LettaAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
  };
}

function launchIdFrom(cmd: string): string {
  const m = /--launch-id '([^']+)'/.exec(cmd);
  if (!m) throw new Error("typed command carries no --launch-id");
  return m[1]!;
}

function sidecar(fields: Record<string, unknown>): string {
  return JSON.stringify({ updatedAt: "2026-10-08T10:00:00Z", ...fields });
}

function adapterWith(fs: LettaAdapterFsOps, tmux: TmuxAdapter, readyPollAttempts?: number) {
  return new LettaRuntimeAdapter({ tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sleep: async () => {}, readyPollAttempts });
}

/** A pane that "starts" the runner: on the typed command, write this
 *  launch's sidecar with the given fields and record the command. */
function startingPane(fs: { files: Record<string, string> }, fields: Record<string, unknown>) {
  const typed: string[] = [];
  const sendShellCommand = vi.fn(async (_t: string, text: string) => {
    typed.push(text);
    fs.files[paths.runnerStatePath] = sidecar({ launchId: launchIdFrom(text), ...fields });
    return { ok: true as const };
  });
  return { typed, sendShellCommand };
}

const binding = { tmuxSession: SESSION, cwd: CWD } as never;

let savedYolo: string | undefined;
beforeEach(() => { savedYolo = process.env.OPENRIG_YOLO; delete process.env.OPENRIG_YOLO; });
afterEach(() => { if (savedYolo === undefined) delete process.env.OPENRIG_YOLO; else process.env.OPENRIG_YOLO = savedYolo; });

// ── binding resource ──────────────────────────────────────────────────────────

describe("parseLettaAgentBinding", () => {
  it("accepts bind (agent_id) and create (create_agent: true) with an optional permission mode", () => {
    expect(parseLettaAgentBinding(JSON.stringify({ agent_id: AGENT }))).toEqual({ ok: true, binding: { agentId: AGENT } });
    expect(parseLettaAgentBinding(JSON.stringify({ create_agent: true, permission_mode: "acceptEdits" })))
      .toEqual({ ok: true, binding: { createAgent: true, permissionMode: "acceptEdits" } });
  });

  it("refuses both, neither, a malformed agent id, a non-true create flag, an unknown mode, and non-JSON", () => {
    expect(parseLettaAgentBinding(JSON.stringify({ agent_id: AGENT, create_agent: true })).ok).toBe(false);
    expect(parseLettaAgentBinding(JSON.stringify({})).ok).toBe(false);
    expect(parseLettaAgentBinding(JSON.stringify({ agent_id: "not-an-agent" })).ok).toBe(false);
    expect(parseLettaAgentBinding(JSON.stringify({ create_agent: "yes" })).ok).toBe(false);
    expect(parseLettaAgentBinding(JSON.stringify({ agent_id: AGENT, permission_mode: "yolo" })).ok).toBe(false);
    expect(parseLettaAgentBinding("agent_id: x").ok).toBe(false);
  });
});

// ── resume-token validation ───────────────────────────────────────────────────

describe("letta_conversation resume tokens", () => {
  it("maps the runtime to letta_conversation and accepts <agent>/<conversation>", () => {
    expect(resumeTypeForRuntime("letta")).toBe("letta_conversation");
    expect(validateResumeToken("letta", ` ${TOKEN} `)).toEqual({ ok: true, resumeType: "letta_conversation", token: TOKEN });
    expect(validateResumeToken("letta", `${AGENT}/conv-abc123`).ok).toBe(true);
  });

  it("refuses a bare conversation, 'default', a bad agent and an over-long token, never echoing the value", () => {
    for (const bad of [CONV, `${AGENT}/default`, `bogus/${CONV}`, `${AGENT}/${CONV}/x`, `${AGENT}/conv-${"a".repeat(500)}`]) {
      const result = validateResumeToken("letta", bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain(bad);
    }
  });
});

// ── launchHarness ─────────────────────────────────────────────────────────────

describe("LettaRuntimeAdapter.launchHarness", () => {
  it("bind (default): types the runner with --agent, an explicit floor permission mode, and captures agent/conversation", async () => {
    const fs = memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }) });
    const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: CONV });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }));

    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: TOKEN, resumeType: "letta_conversation" });
    const cmd = pane.typed[0]!;
    expect(cmd).toContain(`node '${RUNNER}'`);
    expect(cmd).toContain(`--session-name '${SESSION}'`);
    expect(cmd).toContain(`--state-root '${STATE_ROOT}'`);
    expect(cmd).toContain(`--cwd '${CWD}'`);
    expect(cmd).toContain(`--agent '${AGENT}'`);
    expect(cmd).toContain("--permission-mode 'standard'");
    expect(cmd).not.toContain("--conversation");
    expect(cmd).not.toContain("--create-agent");
    expect(cmd).not.toContain("--model"); // a bind never rewrites the agent's model
  });

  it("refuses to launch fresh without a bound agent, before typing anything", async () => {
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/letta_agent_binding/);
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("create mode only behind the explicit create_agent opt-in, and then applies the member model", async () => {
    const fs = memFs({ [BINDING_PATH]: JSON.stringify({ create_agent: true }) });
    const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: CONV });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }));
    const result = await adapter.launchHarness({ tmuxSession: SESSION, cwd: CWD, model: "openai-codex/gpt-5.5" } as never, { name: SESSION });
    expect(result.ok).toBe(true);
    expect(pane.typed[0]).toContain("--create-agent");
    expect(pane.typed[0]).toContain("--model 'openai-codex/gpt-5.5'");
    expect(pane.typed[0]).not.toContain("--agent ");
  });

  it("resume: --conversation alone plus --expect-agent, returns the SAME token, and needs no binding", async () => {
    const fs = memFs({ [PENDING_PATH]: JSON.stringify({ blocks: [{ id: "g", content: "stale" }] }) });
    const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: CONV });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand, sendText }));

    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: TOKEN });
    expect(result).toEqual({ ok: true, resumeToken: TOKEN, resumeType: "letta_conversation" });
    const cmd = pane.typed[0]!;
    expect(cmd).toContain(`--conversation '${CONV}'`);
    expect(cmd).toContain(`--expect-agent '${AGENT}'`);
    expect(cmd).not.toMatch(/--agent '/);
    // A resumed conversation already had its guidance: nothing replayed, queue cleared.
    expect(sendText).not.toHaveBeenCalled();
    expect(JSON.parse(fs.files[PENDING_PATH]!)).toEqual({ blocks: [] });
  });

  it("resume with a malformed token fails validation before touching the pane", async () => {
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: CONV });
    expect(result.ok).toBe(false);
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("resume whose conversation is gone returns retry_fresh (stop-and-ask), never a silent fresh start", async () => {
    const fs = memFs();
    const pane = startingPane(fs, { ready: false, attention: "letta_conversation_missing", exited: { code: 1, at: "t" } });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: TOKEN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("retry_fresh");
  });

  it("resume that comes up on a different conversation is refused", async () => {
    const fs = memFs();
    const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: "local-conv-9" });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: TOKEN });
    expect(result.ok).toBe(false);
  });

  it("refuses forkSource (v1) and resumeToken + forkSource together, before typing anything", async () => {
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }) }), mockTmux({ sendShellCommand }));
    const fork = await adapter.launchHarness(binding, { name: SESSION, forkSource: { kind: "native_id", value: TOKEN } });
    expect(fork.ok).toBe(false);
    if (!fork.ok) expect(fork.error).toMatch(/fork is not supported in v1/);
    const both = await adapter.launchHarness(binding, { name: SESSION, resumeToken: TOKEN, forkSource: { kind: "native_id", value: TOKEN } });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toMatch(/mutually exclusive/);
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("permission posture: an attached policy is authoritative; without one YOLO lifts it, else the declared mode", async () => {
    const run = async (declared: Record<string, unknown>, extra: Record<string, unknown>) => {
      const fs = memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT, ...declared }) });
      const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: CONV });
      await adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }))
        .launchHarness({ tmuxSession: SESSION, cwd: CWD, ...extra } as never, { name: SESSION });
      return pane.typed[0]!;
    };
    expect(await run({}, { launchPosture: "full_bypass" })).toContain("--permission-mode 'unrestricted'");
    expect(await run({ permission_mode: "unrestricted" }, { launchPosture: "floor" })).toContain("--permission-mode 'standard'");
    expect(await run({ permission_mode: "acceptEdits" }, {})).toContain("--permission-mode 'acceptEdits'");
    process.env.OPENRIG_YOLO = "1";
    expect(await run({}, {})).toContain("--permission-mode 'unrestricted'");
  });

  it("a runner that exits during this launch is attention_required with pane evidence", async () => {
    const fs = memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }) });
    const pane = startingPane(fs, { ready: false, exited: { code: 127, at: "t" } });
    const capturePaneContent = vi.fn(async () => "[letta-runner] ERROR letta exited (code 127) before completing a turn");
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand, capturePaneContent }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toContain("[letta-runner] ERROR");
    }
  });

  it("an auth failure raised before ready surfaces as attention_required", async () => {
    const fs = memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }) });
    const pane = startingPane(fs, { ready: false, attention: "letta_auth_required" });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("letta_auth_required");
    }
  });

  it("ignores a stale ready sidecar from another launch and times out instead of going green", async () => {
    const fs = memFs({ [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }) });
    const sendShellCommand = vi.fn(async () => {
      fs.files[paths.runnerStatePath] = sidecar({ ready: true, launchId: "an-older-launch", agentId: AGENT, conversationId: CONV });
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand }), 3);
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });

  it("a fresh launch sends queued guidance as its first turn, then clears the queue", async () => {
    const fs = memFs({
      [BINDING_PATH]: JSON.stringify({ agent_id: AGENT }),
      [PENDING_PATH]: JSON.stringify({ blocks: [{ id: "openrig-start.md", content: "Use rig send to reply." }] }),
    });
    const pane = startingPane(fs, { ready: true, agentId: AGENT, conversationId: CONV });
    const sendText = vi.fn(async (_t: string, _text: string) => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(fs, mockTmux({ sendShellCommand: pane.sendShellCommand, sendText, sendKeys }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0]![1]).toContain("Use rig send to reply.");
    expect(sendKeys).toHaveBeenCalledWith(SESSION, ["Enter"]);
    expect(JSON.parse(fs.files[PENDING_PATH]!)).toEqual({ blocks: [] });
  });
});

// ── checkReady ────────────────────────────────────────────────────────────────

describe("LettaRuntimeAdapter.checkReady", () => {
  const check = (state: Record<string, unknown> | null, opts?: { paneCommand?: string; pane?: string }) => {
    const fs = memFs(state ? { [paths.runnerStatePath]: sidecar(state) } : {});
    return adapterWith(fs, mockTmux({
      getPaneCommand: async () => opts?.paneCommand ?? "node",
      capturePaneContent: async () => opts?.pane ?? "",
    })).checkReady(binding);
  };

  it("ready after system/init while the runner owns the pane", async () => {
    expect(await check({ ready: true, agentId: AGENT, conversationId: CONV })).toEqual({ ready: true });
  });

  it("a ready sidecar with the pane back at a shell is runner_exited", async () => {
    expect((await check({ ready: true }, { paneCommand: "bash" })).code).toBe("runner_exited");
  });

  it("blocking runner attention maps to attention-required readiness codes", async () => {
    for (const code of ["letta_auth_required", "letta_agent_missing", "letta_conversation_missing", "letta_identity_mismatch"]) {
      const result = await check({ ready: true, attention: code });
      expect(result.ready).toBe(false);
      expect(result.code).toBe(code);
      expect(isAttentionRequiredReadinessCode(result.code)).toBe(true);
    }
  });

  it("an answered approval or a generic turn error leaves the seat ready", async () => {
    expect(await check({ ready: true, attention: "letta_approval_pending" })).toEqual({ ready: true });
    expect(await check({ ready: true, attention: "runtime_error" })).toEqual({ ready: true });
  });

  it("an exited runner is runner_exited; before init it is awaiting_runtime", async () => {
    expect((await check({ ready: false, exited: { code: 0, at: "t" } })).code).toBe("runner_exited");
    expect((await check({ ready: false })).code).toBe("awaiting_runtime");
  });

  it("falls back to the runner's own pane markers when there is no sidecar", async () => {
    expect(await check(null, { pane: `[letta-runner] READY agent=${AGENT} conversation=${CONV}` })).toEqual({ ready: true });
    expect((await check(null, { pane: "[letta-runner] ERROR identity: mismatch" })).code).toBe("runner_error");
    expect((await check(null)).code).toBe("awaiting_runtime");
  });
});

// ── deliverStartup / project / listInstalled ─────────────────────────────────

describe("LettaRuntimeAdapter startup and projection", () => {
  const file = (path: string, absolutePath: string, deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text") =>
    ({ path, absolutePath, ownerRoot: "/spec", deliveryHint, required: true, appliesOn: ["fresh_start"] as ("fresh_start")[] });

  it("send_text goes through the runner as one turn; skills install under .agents/skills; guidance merges and queues", async () => {
    const fs = memFs({
      "/spec/hello.txt": "hello letta",
      "/spec/skills/demo/SKILL.md": "# SKILL demo",
      "/spec/guidance/role.md": "Be brief.",
    });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.deliverStartup([
      file("hello.txt", "/spec/hello.txt", "send_text"),
      file("SKILL.md", "/spec/skills/demo/SKILL.md", "skill_install"),
      file("role.md", "/spec/guidance/role.md", "guidance_merge"),
    ], binding);
    expect(result).toEqual({ delivered: 3, failed: [] });
    expect(sendText).toHaveBeenCalledWith(SESSION, "hello letta");
    expect(fs.files[nodePath.join(CWD, ".agents", "skills", "demo", "SKILL.md")]).toBe("# SKILL demo");
    expect(fs.files[nodePath.join(CWD, "AGENTS.md")]).toContain("Be brief.");
    expect(JSON.parse(fs.files[PENDING_PATH]!).blocks).toEqual([{ id: "role.md", content: "Be brief." }]);
  });

  it("rig-role guidance is not merged into the shared AGENTS.md (per-seat send_text path)", async () => {
    const fs = memFs({ "/spec/rig-role": "role" });
    const result = await adapterWith(fs, mockTmux()).deliverStartup([file("rig-role", "/spec/rig-role", "guidance_merge")], binding);
    expect(result.delivered).toBe(0);
    expect(fs.files[nodePath.join(CWD, "AGENTS.md")]).toBeUndefined();
  });

  const entry = (over: Partial<ProjectionEntry>): ProjectionEntry => ({
    category: "skill", effectiveId: "x", sourceSpec: "spec", sourcePath: "/spec", resourcePath: "x",
    absolutePath: "/spec/x", classification: "safe_projection", ...over,
  });
  const plan = (entries: ProjectionEntry[]) => ({ runtime: "letta", cwd: CWD, entries, startup: { files: [], actions: [] }, conflicts: [] }) as unknown as ProjectionPlan;

  it("project writes the agent binding into the seat state dir and skips plugins, subagents and other runtime resources", async () => {
    const raw = JSON.stringify({ agent_id: AGENT });
    const fs = memFs({ "/spec/letta-agent.json": raw, "/spec/g.md": "Guide." });
    const result = await adapterWith(fs, mockTmux()).project(plan([
      entry({ category: "runtime_resource", effectiveId: "letta-agent", absolutePath: "/spec/letta-agent.json", resourceType: LETTA_AGENT_BINDING_RESOURCE_TYPE }),
      entry({ category: "guidance", effectiveId: "g.md", absolutePath: "/spec/g.md", mergeStrategy: "managed_block" }),
      entry({ category: "plugin", effectiveId: "p" }),
      entry({ category: "subagent", effectiveId: "s" }),
      entry({ category: "runtime_resource", effectiveId: "c", resourceType: "codex_config_fragment" }),
    ]), binding);
    expect(result.failed).toEqual([]);
    expect(result.projected).toEqual(["letta-agent", "g.md"]);
    expect(result.skipped).toEqual(["p", "s", "c"]);
    expect(fs.files[BINDING_PATH]).toBe(raw);
    expect(fs.files[nodePath.join(CWD, "AGENTS.md")]).toContain("Guide.");
  });

  it("project fails loudly on a malformed agent binding", async () => {
    const fs = memFs({ "/spec/letta-agent.json": JSON.stringify({ agent_id: "nope" }) });
    const result = await adapterWith(fs, mockTmux()).project(plan([
      entry({ category: "runtime_resource", effectiveId: "letta-agent", absolutePath: "/spec/letta-agent.json", resourceType: LETTA_AGENT_BINDING_RESOURCE_TYPE }),
    ]), binding);
    expect(result.failed).toHaveLength(1);
    expect(fs.files[BINDING_PATH]).toBeUndefined();
  });

  it("listInstalled reports cwd skills and the seat's agent binding", async () => {
    const skillsDir = nodePath.join(CWD, ".agents", "skills");
    const fs = memFs({ [BINDING_PATH]: "{}" });
    fs.dirs.add(skillsDir);
    fs.listFiles = () => ["demo/SKILL.md"];
    const installed = await adapterWith(fs, mockTmux()).listInstalled(binding);
    expect(installed).toEqual([
      { effectiveId: "demo/SKILL.md", category: "skill", installedPath: nodePath.join(skillsDir, "demo/SKILL.md") },
      { effectiveId: "letta-agent-binding", category: "runtime_resource", installedPath: BINDING_PATH },
    ]);
  });
});

// ── continuity: harness-native only ──────────────────────────────────────────

describe("letta continuity is harness-native", () => {
  const spec: AgentSpec = {
    version: "1.0.0", name: "letta-agent", imports: [],
    startup: { files: [], actions: [] },
    resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
    profiles: { default: { uses: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
  };
  const ctx = (member: Partial<RigSpecPodMember>): ResolutionContext => {
    const m = { id: "talk", agentRef: "local:agents/letta", profile: "default", runtime: "letta", cwd: ".", ...member } as RigSpecPodMember;
    return {
      baseSpec: { spec, sourcePath: "/agents/letta", hash: "h" }, importedSpecs: [], collisions: [], profileName: "default",
      member: m, pod: { id: "dev", label: "Dev", members: [m], edges: [] }, rig: { version: "0.2", name: "r", pods: [], edges: [] },
    } as unknown as ResolutionContext;
  };

  it("refuses managed-compaction and the handover strategies with a clear error", () => {
    for (const strategy of ["managed-compaction", "handover", "apprentice-handover", "pod_continuity"]) {
      const result = resolveNodeConfig(ctx({ compactionStrategy: strategy } as never));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/runtime "letta" keeps continuity harness-native/);
    }
  });

  it("accepts default-compaction and its harness_native alias; other runtimes are unaffected", () => {
    expect(resolveNodeConfig(ctx({})).ok).toBe(true);
    expect(resolveNodeConfig(ctx({ compactionStrategy: "harness_native" } as never)).ok).toBe(true);
    expect(resolveNodeConfig(ctx({ runtime: "claude-code", compactionStrategy: "managed-compaction" } as never)).ok).toBe(true);
  });
});
