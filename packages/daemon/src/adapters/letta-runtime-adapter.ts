// R&D Exp 03 — the Letta runtime adapter (RPC-first, runner-in-a-pane).
//
// Modelled on the Pi adapter. launchHarness types the OpenRig-owned
// letta-runner into the seat's tmux pane; the runner hosts headless Letta Code
// (`letta -p --input-format stream-json --output-format stream-json`) and
// writes a launch-scoped runner-state.json sidecar. Readiness and the resume
// token come from that sidecar and the runner's own pane markers, never from
// Letta UI text (BR-1).
//
// Seat binding (which Letta agent a seat speaks as) is declared in the agent
// spec as a runtime resource, the same seam Codex uses for its config
// fragments:
//
//   resources:
//     runtime_resources:
//       - id: letta-agent
//         path: letta-agent.json
//         runtime: letta
//         type: letta_agent_binding
//   profiles:
//     default:
//       uses: { runtime_resources: [letta-agent] }
//
// letta-agent.json is a JSON object with exactly one of:
//   { "agent_id": "agent-…" }      bind (default): the existing agent opens a
//                                  NEW conversation, so the seat never takes
//                                  over the agent's other rooms.
//   { "create_agent": true }       create: a disposable new agent. Explicit
//                                  opt-in only; the member's `model` applies.
// and optionally "permission_mode" (standard | acceptEdits | unrestricted |
// strict), used only when no permission policy is attached to the seat.
// project() copies the binding into the seat state dir; launchHarness reads it
// from there. Resume never needs it: the token carries the conversation.
//
// Resume token: resumeType "letta_conversation", token
// "<agent_id>/<conversation_id>". Resume relaunches with `--conversation C`
// alone (Letta exits 1 when --agent is also given) and the runner verifies the
// agent from system/init.
//
// Fork is refused in v1: the headless transport has no conversation fork, and
// a Letta fork would share the parent agent's memory anyway.
//
// Continuity is harness-native (Letta compacts server-side and owns memory);
// profile-resolver refuses any other compaction strategy for this runtime.
//
// Projection: skills go to <cwd>/.agents/skills/<id>/; guidance merges into
// the AGENTS.md managed block AND is sent as the first turn of a fresh launch,
// because Letta does not load AGENTS.md itself. Plugins, subagents, hooks and
// MCP are not projected in v1 (reported as skipped, as Pi does).

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { yoloEnabled } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  lettaSeatPaths, parseLettaRunnerState, buildLettaRunnerCommand, buildPendingLettaRunnerState,
  parseLettaResumeToken, formatLettaResumeToken, isLettaAgentId,
  LETTA_RESUME_TYPE, LETTA_PERMISSION_MODES,
  type LettaRunnerState, type LettaLaunchMode, type LettaPermissionMode, type LettaAttentionCode,
} from "./letta-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** The agent-spec runtime_resources `type` that declares a Letta seat's agent. */
export const LETTA_AGENT_BINDING_RESOURCE_TYPE = "letta_agent_binding";

/** Runner attention codes that leave the seat unusable until an operator acts.
 *  Approval-pending and a generic runtime error do not: the runner already
 *  denied the approval, and the seat still takes input. */
const BLOCKING_ATTENTION: ReadonlySet<LettaAttentionCode> = new Set([
  "letta_auth_required",
  "letta_agent_missing",
  "letta_conversation_missing",
  "letta_identity_mismatch",
]);

export interface LettaAgentBinding {
  agentId?: string;
  createAgent?: true;
  permissionMode?: LettaPermissionMode;
}

/** Parse a letta_agent_binding resource. Exactly one of agent_id / create_agent. */
export function parseLettaAgentBinding(raw: string): { ok: true; binding: LettaAgentBinding } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "letta agent binding must be a JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "letta agent binding must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const hasAgent = obj["agent_id"] !== undefined;
  const create = obj["create_agent"] === true;
  if (obj["create_agent"] !== undefined && obj["create_agent"] !== true) {
    return { ok: false, error: "letta agent binding: create_agent must be the literal true when present" };
  }
  if (hasAgent === create) {
    return { ok: false, error: "letta agent binding: declare exactly one of agent_id (bind an existing agent) or create_agent: true (disposable new agent)" };
  }
  const binding: LettaAgentBinding = {};
  if (hasAgent) {
    if (typeof obj["agent_id"] !== "string" || !isLettaAgentId(obj["agent_id"])) {
      return { ok: false, error: "letta agent binding: agent_id must look like agent-<id>" };
    }
    binding.agentId = obj["agent_id"];
  } else {
    binding.createAgent = true;
  }
  if (obj["permission_mode"] !== undefined) {
    const mode = obj["permission_mode"];
    if (typeof mode !== "string" || !(LETTA_PERMISSION_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: `letta agent binding: permission_mode must be one of ${LETTA_PERMISSION_MODES.join(", ")}` };
    }
    binding.permissionMode = mode as LettaPermissionMode;
  }
  return { ok: true, binding };
}

export interface LettaAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface LettaRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: LettaAdapterFsOps;
  /** Root under which every Letta seat gets its state dir. Typically
   *  <OPENRIG_HOME>/state/letta. Holds runner state only, never a Letta
   *  backend: a bound agent's memory stays in its own backend. */
  stateRoot: string;
  /** Absolute path to the compiled letta-runner entry in the daemon dist. */
  runnerEntryPath: string;
  sleep?: (ms: number) => Promise<void>;
  newLaunchId?: () => string;
  /** Sidecar polls before launch gives up (250ms apart). Default 120 (~30s). */
  readyPollAttempts?: number;
}

interface PendingGuidance {
  blocks: Array<{ id: string; content: string }>;
}

export class LettaRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "letta" as const;
  private tmux: TmuxAdapter;
  private fs: LettaAdapterFsOps;
  private stateRoot: string;
  private runnerEntryPath: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;
  private readyPollAttempts: number;

  constructor(deps: LettaRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
    this.readyPollAttempts = deps.readyPollAttempts ?? 120;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    if (binding.tmuxSession && this.fs.exists(this.agentBindingPath(binding.tmuxSession))) {
      results.push({ effectiveId: "letta-agent-binding", category: "runtime_resource", installedPath: this.agentBindingPath(binding.tmuxSession) });
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      const isBinding = entry.category === "runtime_resource" && entry.resourceType === LETTA_AGENT_BINDING_RESOURCE_TYPE;
      const directorySkill = entry.category === "skill" && this.fs.exists(nodePath.join(entry.absolutePath, "SKILL.md"));
      if (entry.classification === "no_op" && !directorySkill && !isBinding) {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding, warnings)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        switch (hint) {
          case "guidance_merge": {
            if (!this.mergeGuidance(binding, file.path, content, warnings)) continue; // rig-role skip
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            // The runner reads pane stdin and sends one user turn per block.
            if (binding.tmuxSession) await this.sendTurn(binding.tmuxSession, content);
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the Letta harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      return {
        ok: false,
        error: "letta fork is not supported in v1: the headless stream-json transport has no conversation fork, and a Letta fork would share the parent agent's memory. Launch fresh (bind) or resume instead.",
      };
    }

    const sessionName = binding.tmuxSession;
    let mode: LettaLaunchMode;
    let declared: LettaAgentBinding | null = null;
    if (opts.resumeToken) {
      const validation = validateResumeToken(this.runtime, opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `letta resume: ${validation.error}` };
      const parsed = parseLettaResumeToken(validation.token)!;
      mode = { kind: "resume", conversationId: parsed.conversationId, expectAgentId: parsed.agentId };
      // The permission mode a resume uses still comes from the seat's binding
      // when one was projected; a resume does not require it.
      const read = this.readAgentBinding(sessionName);
      if (read.ok) declared = read.binding;
    } else {
      const read = this.readAgentBinding(sessionName);
      if (!read.ok) return { ok: false, error: `letta launch: ${read.error}` };
      declared = read.binding;
      mode = declared.agentId
        ? { kind: "bind", agentId: declared.agentId }
        : { kind: "create", allowCreateAgent: true };
    }

    const paths = lettaSeatPaths(this.stateRoot, sessionName);
    this.fs.mkdirp(paths.seatRoot);
    // Launch-attempt scoping: only sidecar states stamped with this launchId count.
    const launchId = this.newLaunchId();
    this.fs.writeFile(paths.runnerStatePath, JSON.stringify(buildPendingLettaRunnerState(launchId, new Date().toISOString())));

    const cmd = buildLettaRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      cwd: binding.cwd,
      launchId,
      permissionMode: this.permissionMode(binding, declared),
      mode,
      model: binding.model,
    });
    const textResult = await this.tmux.sendShellCommand(sessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    const state = await this.waitForRunnerReady(sessionName, launchId, mode);
    if (!state.ok) return state.failure;

    const { agentId, conversationId } = state.value;
    if (!agentId || !conversationId) {
      return { ok: false, error: "letta launch: the runner became ready but reported no agent or conversation" };
    }
    if (mode.kind === "resume" && (conversationId !== mode.conversationId || agentId !== mode.expectAgentId)) {
      return { ok: false, error: "letta resume: the runner is ready but does not report the requested agent and conversation" };
    }
    if (mode.kind === "bind" && agentId !== mode.agentId) {
      return { ok: false, error: "letta launch: the runner is ready on a different agent than the seat binding declares" };
    }
    const validation = validateResumeToken(this.runtime, formatLettaResumeToken(agentId, conversationId));
    if (!validation.ok) {
      return { ok: false, error: `letta launch: the runner reported a malformed identity (${validation.error})` };
    }

    if (mode.kind === "resume") {
      // The resumed conversation already had its guidance.
      this.writePendingGuidance(sessionName, { blocks: [] });
    } else {
      const sent = await this.sendPendingGuidance(sessionName);
      if (!sent.ok) return { ok: false, error: `letta launch: guidance first turn failed: ${sent.error}` };
    }

    return { ok: true, resumeToken: validation.token, resumeType: LETTA_RESUME_TYPE };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // A sidecar or scrollback marker can outlive the runner: a ready signal
    // counts only while the pane is not back at a shell.
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(binding.tmuxSession);
    if (state?.attention && BLOCKING_ATTENTION.has(state.attention)) {
      return { ready: false, reason: `letta-runner needs operator attention (${state.attention})`, code: state.attention };
    }
    if (state?.exited) {
      return { ready: false, reason: `letta-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "letta-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" };
      }
      return { ready: true };
    }
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    if (paneContent.includes("[letta-runner] ERROR")) {
      return { ready: false, reason: "letta-runner reported an error in the pane", code: "runner_error" };
    }
    if (paneContent.includes("[letta-runner] EXITED")) {
      return { ready: false, reason: "letta-runner exited", code: "runner_exited" };
    }
    if (paneContent.includes("[letta-runner] READY")) {
      if (atShell) return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      return { ready: true };
    }
    return { ready: false, reason: "letta-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private agentBindingPath(sessionName: string): string {
    return nodePath.join(lettaSeatPaths(this.stateRoot, sessionName).seatRoot, "agent-binding.json");
  }

  private pendingGuidancePath(sessionName: string): string {
    return nodePath.join(lettaSeatPaths(this.stateRoot, sessionName).seatRoot, "pending-guidance.json");
  }

  private readAgentBinding(sessionName: string): { ok: true; binding: LettaAgentBinding } | { ok: false; error: string } {
    const path = this.agentBindingPath(sessionName);
    if (!this.fs.exists(path)) {
      return {
        ok: false,
        error: `no Letta agent is bound to this seat; select a runtime_resources entry with runtime "letta" and type "${LETTA_AGENT_BINDING_RESOURCE_TYPE}" in the agent profile`,
      };
    }
    return parseLettaAgentBinding(this.fs.readFile(path));
  }

  private permissionMode(binding: NodeBinding, declared: LettaAgentBinding | null): LettaPermissionMode {
    // An attached permission policy is authoritative for the seat; without
    // one, OPENRIG_YOLO lifts it, else the binding's declared mode or the
    // conservative floor. Never ambient.
    if (binding.launchPosture) return binding.launchPosture === "full_bypass" ? "unrestricted" : "standard";
    if (yoloEnabled(process.env)) return "unrestricted";
    return declared?.permissionMode ?? "standard";
  }

  private readRunnerState(sessionName: string): LettaRunnerState | null {
    const { runnerStatePath } = lettaSeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parseLettaRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
    mode: LettaLaunchMode,
  ): Promise<{ ok: true; value: LettaRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    for (let attempt = 0; attempt < this.readyPollAttempts; attempt++) {
      const state = this.readRunnerState(sessionName);
      if (state?.launchId === launchId) {
        if (state.attention && BLOCKING_ATTENTION.has(state.attention)) {
          // A vanished conversation on resume is the stop-and-ask case, never
          // a silent fresh start: the caller decides (BR-6).
          if (mode.kind === "resume" && (state.attention === "letta_conversation_missing" || state.attention === "letta_agent_missing")) {
            return { ok: false, failure: { ok: false, error: `letta resume: the conversation can no longer be opened (${state.attention})`, recovery: "retry_fresh" } };
          }
          return { ok: false, failure: await this.attentionFailure(sessionName, `letta launch needs operator attention (${state.attention})`) };
        }
        if (state.exited) {
          return { ok: false, failure: await this.attentionFailure(sessionName, `letta launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`) };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < this.readyPollAttempts - 1) await this.sleep(250);
    }
    return {
      ok: false,
      failure: { ok: false, error: "letta launch: timed out waiting for the runner to report ready", recovery: "attention_required" },
    };
  }

  private async attentionFailure(sessionName: string, error: string): Promise<HarnessLaunchResult> {
    const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
    return { ok: false, error, recovery: "attention_required", evidence: paneContent.split("\n").slice(-12).join("\n") };
  }

  private async sendTurn(sessionName: string, content: string): Promise<void> {
    const textResult = await this.tmux.sendText(sessionName, content);
    if (!textResult.ok) throw new Error(textResult.message);
    await this.sleep(200);
    const submitResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!submitResult.ok) throw new Error(submitResult.message);
  }

  private readPendingGuidance(sessionName: string): PendingGuidance {
    const path = this.pendingGuidancePath(sessionName);
    if (!this.fs.exists(path)) return { blocks: [] };
    try {
      const parsed = JSON.parse(this.fs.readFile(path)) as PendingGuidance;
      return Array.isArray(parsed?.blocks) ? parsed : { blocks: [] };
    } catch {
      return { blocks: [] };
    }
  }

  private writePendingGuidance(sessionName: string, pending: PendingGuidance): void {
    this.fs.mkdirp(lettaSeatPaths(this.stateRoot, sessionName).seatRoot);
    this.fs.writeFile(this.pendingGuidancePath(sessionName), JSON.stringify(pending));
  }

  /** Letta does not load AGENTS.md, so a fresh conversation gets the seat's
   *  guidance as its first turn. Blocks are keyed by id, so re-projection
   *  never duplicates them. */
  private queueGuidance(sessionName: string, id: string, content: string): void {
    const pending = this.readPendingGuidance(sessionName);
    const replaced = id === "openrig-start.md" ? [id, "using-openrig.md"] : [id];
    const blocks = pending.blocks.filter((b) => !replaced.includes(b.id));
    blocks.push({ id, content });
    this.writePendingGuidance(sessionName, { blocks });
  }

  private async sendPendingGuidance(sessionName: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pending = this.readPendingGuidance(sessionName);
    if (pending.blocks.length === 0) return { ok: true };
    const text = [
      "OpenRig guidance for this seat (also written to AGENTS.md in your working directory):",
      ...pending.blocks.map((b) => `\n## ${b.id}\n\n${b.content.trim()}`),
    ].join("\n");
    try {
      await this.sendTurn(sessionName, text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    this.writePendingGuidance(sessionName, { blocks: [] });
    return { ok: true };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "runtime_resource") {
      if (entry.resourceType !== LETTA_AGENT_BINDING_RESOURCE_TYPE) return false;
      if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the Letta seat state dir");
      const raw = this.fs.readFile(entry.absolutePath);
      const parsed = parseLettaAgentBinding(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      this.fs.mkdirp(lettaSeatPaths(this.stateRoot, binding.tmuxSession).seatRoot);
      this.fs.writeFile(this.agentBindingPath(binding.tmuxSession), raw);
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(binding, entry.effectiveId, this.fs.readFile(entry.absolutePath), warnings);
    }

    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".agents", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      let isDir = false;
      if (this.fs.listFiles) {
        try {
          isDir = this.fs.listFiles(entry.absolutePath).length > 0;
        } catch {
          isDir = false; // file-shaped source
        }
      }
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
          this.preserveMode(nodePath.join(entry.absolutePath, file), dest);
        }
      } else {
        const dest = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
        this.fs.writeFile(dest, this.fs.readFile(entry.absolutePath));
        this.preserveMode(entry.absolutePath, dest);
      }
      return true;
    }

    // Plugins, subagents, hooks and MCP have no Letta projection in v1: an
    // honest skip, never a misdelivery.
    return false;
  }

  private preserveMode(source: string, target: string): void {
    if (this.fs.statMode && this.fs.chmod) this.fs.chmod(target, this.fs.statMode(source) & 0o777);
  }

  private mergeGuidance(binding: NodeBinding, blockId: string, content: string, warnings: string[]): boolean {
    const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
    // Per-seat rig-role content collides across pod-mates in a shared cwd;
    // it is delivered via send_text instead (ADR-0006), as for Pi and Codex.
    if (blockId === "rig-role") {
      console.log(`[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`);
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    if (binding.tmuxSession) this.queueGuidance(binding.tmuxSession, blockId, content);
    return true;
  }
}
