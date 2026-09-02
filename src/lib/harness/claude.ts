import { nativeModelId } from "../models";
import type { RuntimeMode } from "../session";
import { loadClaudeHooks } from "../settings";
import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "./child";
import {
  askUserQuestionAllowInput,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  contextFromResult,
  contextUsedFromAssistant,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  buildInitializeRequest,
  buildStopTaskRequest,
  claudeSettingsKey,
  extractAskUserQuestionTitle,
  extractExitPlanModePlan,
  inputJsonDeltaFromEvent,
  isAgentTaskType,
  isClaudeUltracodeEffort,
  isSubagentMessage,
  isTerminalAgentTaskStatus,
  isTodoTool,
  normalizeClaudeCliEffort,
  parseBackgroundAgentTasks,
  parseControlCancelId,
  parseControlRequest,
  parseControlResponse,
  parseJsonLine,
  parseTaskNotification,
  parseTaskProgress,
  parseTaskStarted,
  parseTaskUpdated,
  parseToolProgress,
  planTextFromTodos,
  previewFromTool,
  resolveClaudeApiModelId,
  runtimeModeToPermission,
  sendMessageAddress,
  sessionIdFromMessage,
  subagentParentId,
  statusTextFromSystem,
  streamDeltaFromEvent,
  stringField,
  summarizeToolRequest,
  toClaudePermissionResult,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolStartFromEvent,
  toolTitle,
  tryParseJsonRecord,
  turnStatusFromResult,
  type ClaudeCliSettings,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
} from "./claudeProtocol";
import { isAgentToolName } from "./preview";
import { joinStreamText, snapshotRemainder } from "./streamText";
import {
  questionPromptTitle,
  questionsFromUnknown,
  type UserQuestionReply,
} from "../userQuestion";
import type { ApprovalDecision, HarnessEvent, SendTurnInput, SteerTurnInput } from "./types";

/**
 * A PermissionRequest hook can decide before the user touches the prompt; Claude
 * then cancels the control request out from under us. That is not a rejection,
 * so it gets its own outcome instead of being folded into "deny".
 */
type ApprovalOutcome = ApprovalDecision | "cancelled";

type PendingApproval = {
  requestId: string;
  input: Record<string, unknown>;
  resolve: (decision: ApprovalOutcome) => void;
};

type PendingQuestion = {
  requestId: string;
  resolve: (reply: UserQuestionReply | "cancelled") => void;
};

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  title: string;
};

type LiveAgentTask = {
  taskId: string;
  toolUseId?: string;
  description: string;
  backgrounded: boolean;
};

/**
 * A subagent as the agents panel sees it. Keyed by the Agent tool call that
 * spawned it, because that is the only id a forwarded subagent frame carries;
 * the task id arrives separately and only some of the time.
 */
type LiveAgentRun = {
  id: string;
  title: string;
  taskId?: string;
  parentId?: string;
  settled: boolean;
  /** Same snapshot-versus-token bookkeeping the main transcript does, per run. */
  emittedAssistant: string;
  emittedReasoning: string;
};

/** A tool call inside a subagent. Indexes repeat across concurrent runs. */
type SubagentTool = InFlightTool & { agentId: string };

type Live = {
  cwd: string;
  claudeSessionId: string;
  runtimeMode: RuntimeMode;
  settingsKey: string;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  questions: Map<number, PendingQuestion>;
  nextApprovalUiId: number;
  nextControlId: number;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
  agentTasks: Map<string, LiveAgentTask>;
  agents: Map<string, LiveAgentRun>;
  /** Harness task id → agent run id, for the lifecycle events that only name a task. */
  agentByTask: Map<string, string>;
  subTools: Map<string, SubagentTool>;
  /** Keyed `${parentToolUseId}#${index}`: block indexes are per message, not global. */
  subToolsByIndex: Map<string, SubagentTool>;
  /** Control requests we still want the CLI's verdict on, by request id. */
  pendingControls: Map<string, (response: ClaudeControlResponse) => void>;
  /** Task ids the CLI last reported as live in the background. */
  backgroundTaskIds: Set<string>;
  turnResultSeen: boolean;
  cancelled: boolean;
  muteUpdates: boolean;
  turns: Promise<void>;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  turnEndPending: boolean;
  activeTurn: boolean;
  initDone: (() => void) | null;
  initialized: boolean;
  emittedAssistant: string;
  emittedReasoning: string;
};

type Resume = {
  sessionId: string;
  cwd: string;
};

const INIT_TIMEOUT_MS = 8_000;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

let resolveClaudeBinaryImpl: () => Promise<{ path: string }> = resolveClaudeBinary;

/** Test seam. */
export function setClaudeBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveClaudeBinaryImpl = fn;
}

export async function sendClaudeTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns.catch(() => undefined).then(async () => {
    live.cancelled = false;
    live.muteUpdates = false;
    try {
      await runTurn(live, input);
    } catch (error) {
      if (live.cancelled) return;
      throw error;
    }
  });
  await live.turns;
}

export async function steerClaudeTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live?.activeTurn) throw new Error("No active turn to steer");

  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort: input.modelSettings?.effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  await writeJson(input.sessionId, message);
}

export function respondClaudeApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  pending.resolve(decision);
}

export function respondClaudeQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!pending) return;
  pending.resolve(reply);
}

export async function cancelClaudeTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, pending] of live.questions) pending.resolve({ kind: "skipped" });
  live.questions.clear();
  // Declaring `perTaskStopAffordance` means an interrupt now spares background
  // agents. Stop has always meant "stop everything", so end them explicitly
  // rather than quietly leaving a subagent burning tokens after Stop.
  const stops = stopLiveAgents(sessionId, live);
  await writeJson(
    sessionId,
    buildControlRequest(nextControlId(live), { subtype: "interrupt" }),
  ).catch(() => undefined);
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
  await stops;
}

/**
 * Asks the CLI to stop every live subagent, leaves first. The requests go out
 * together and are only awaited after the interrupt is written, so a slow
 * answer cannot hold the interrupt back — but each verdict is still read:
 * settling a run on our own say-so is how a refused stop once showed as done.
 */
async function stopLiveAgents(sessionId: string, live: Live): Promise<void> {
  const roots = [...live.agents.values()].filter((run) => !run.parentId);
  const ordered = roots.flatMap((run) => [...descendants(live, run.id), run]);
  const pending = ordered
    .filter((run) => !run.settled && run.taskId)
    .map((run) => stopOne(sessionId, live, run));
  await Promise.all(pending);
}

/** One stop_task, with the run flagged as stopping until the CLI answers. */
async function stopOne(
  sessionId: string,
  live: Live,
  run: LiveAgentRun,
): Promise<ClaudeControlResponse> {
  markStopping(live, run.id, true);
  const result = await sendControl(
    sessionId,
    live,
    buildStopTaskRequest(run.taskId!),
  );
  if (result.ok) settleAgent(live, run.id, "stopped");
  else markStopping(live, run.id, false);
  return result;
}

function markStopping(live: Live, id: string, stopping: boolean): void {
  const run = live.agents.get(id);
  if (!run || run.settled) return;
  live.onEvent({ type: "agent.updated", agentId: id, stopping });
}

/**
 * Stops one subagent without touching the turn around it. The session declares
 * `perTaskStopAffordance` at initialize, which is what keeps a plain Stop from
 * killing background agents — so this is now the only way to end one early.
 */
export async function stopClaudeAgent(
  sessionId: string,
  taskId: string,
): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    throw new Error("This session's Claude process is no longer running.");
  }
  // The CLI does not stop a subagent's own subagents with it — measured: two
  // nested agents kept reporting progress after their parent was killed. So
  // stop the tree from the leaves up, or Stop leaves orphans burning tokens.
  const root = [...live.agents.values()].find((run) => run.taskId === taskId);
  for (const child of descendants(live, root?.id)) {
    if (child.settled || !child.taskId) continue;
    const result = await stopOne(sessionId, live, child);
    if (!result.ok) {
      throw new Error(
        `${child.title}: ${result.error ?? "Claude refused to stop it."}`,
      );
    }
  }
  const result = root
    ? await stopOne(sessionId, live, root)
    : await sendControl(sessionId, live, buildStopTaskRequest(taskId));
  if (!result.ok) throw new Error(result.error ?? "Claude refused to stop it.");
}

/** Runs spawned under `id`, deepest first, so a parent is stopped last. */
function descendants(live: Live, id: string | undefined): LiveAgentRun[] {
  if (!id) return [];
  const out: LiveAgentRun[] = [];
  for (const run of live.agents.values()) {
    if (run.parentId !== id) continue;
    out.push(...descendants(live, run.id), run);
  }
  return out;
}

const CONTROL_TIMEOUT_MS = 10_000;

/**
 * A control request whose verdict we actually read. Fire-and-forget was how a
 * refused `stop_task` turned into a button that looked broken: the CLI answered
 * with an error and nothing was listening.
 */
async function sendControl(
  sessionId: string,
  live: Live,
  request: Record<string, unknown>,
): Promise<ClaudeControlResponse> {
  const requestId = nextControlId(live);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<ClaudeControlResponse>((resolve) => {
    live.pendingControls.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    timer = setTimeout(() => {
      if (!live.pendingControls.delete(requestId)) return;
      resolve({
        requestId,
        ok: false,
        payload: null,
        error: "Claude did not answer in time.",
      });
    }, CONTROL_TIMEOUT_MS);
  });
  try {
    await writeJson(sessionId, buildControlRequest(requestId, request));
  } catch {
    clearTimeout(timer);
    live.pendingControls.delete(requestId);
    return {
      requestId,
      ok: false,
      payload: null,
      error: "Could not reach the Claude process.",
    };
  }
  return settled;
}

export async function stopClaudeSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
    for (const [, pending] of live.questions) pending.resolve({ kind: "skipped" });
    live.questions.clear();
    live.activeTurn = false;
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.initDone?.();
    live.initDone = null;
  }
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetClaudeSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopClaudeSession(sessionId);
}

export function bindClaudeSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd });
}

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const settingsKey = settingsKeyFor(input);
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.settingsKey === settingsKey
  ) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopClaudeSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveClaudeBinaryImpl();
  const liveRef: { current: Live | null } = { current: null };
  const claudeSessionId = canResume && resume ? resume.sessionId : crypto.randomUUID();
  const launch = launchOptions(input, canResume ? resume?.sessionId : undefined, claudeSessionId);

  const live: Live = {
    cwd: input.cwd,
    claudeSessionId,
    runtimeMode: input.runtimeMode,
    settingsKey,
    onEvent: input.onEvent,
    approvals: new Map(),
    questions: new Map(),
    nextApprovalUiId: 1,
    nextControlId: 1,
    toolsByIndex: new Map(),
    toolsById: new Map(),
    agentTasks: new Map(),
    agents: new Map(),
    agentByTask: new Map(),
    subTools: new Map(),
    subToolsByIndex: new Map(),
    pendingControls: new Map(),
    backgroundTaskIds: new Set(),
    turnResultSeen: false,
    cancelled: false,
    muteUpdates: false,
    turns: Promise.resolve(),
    turnDone: null,
    turnFailed: null,
    turnEndPending: false,
    activeTurn: false,
    initDone: null,
    initialized: false,
    emittedAssistant: "",
    emittedReasoning: "",
  };
  liveRef.current = live;

  watchChild(
    input.sessionId,
    (line) => {
      const current = liveRef.current;
      if (!current) return;
      handleLine(input.sessionId, current, line);
    },
    (code) => {
      liveByThread.delete(input.sessionId);
      const exiting = liveRef.current;
      // Nothing outlives the CLI process, so a run still marked running here
      // would spin in the agents panel forever.
      if (exiting) {
        for (const id of exiting.agents.keys()) settleAgent(exiting, id, "stopped");
      }
      input.onEvent({ type: "session.ended", code });
      const current = liveRef.current;
      current?.turnFailed?.(new Error("Claude Code exited"));
      current?.initDone?.();
      if (current) {
        current.turnDone = null;
        current.turnFailed = null;
        current.initDone = null;
      }
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    buildClaudeSpawnArgs(launch),
    input.cwd,
  );

  liveByThread.set(input.sessionId, live);
  resumeByThread.set(input.sessionId, {
    sessionId: claudeSessionId,
    cwd: input.cwd,
  });

  try {
    await writeJson(
      input.sessionId,
      buildControlRequest(nextControlId(live), buildInitializeRequest()),
    );
    await waitForInit(live, INIT_TIMEOUT_MS);
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: live.claudeSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    await stopClaudeSession(input.sessionId);
    throw error;
  }
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  const effort = input.modelSettings?.effort;
  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  live.emittedAssistant = "";
  live.emittedReasoning = "";
  live.toolsByIndex.clear();
  live.toolsById.clear();
  live.agentTasks.clear();
  live.turnResultSeen = false;

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;
  settlePendingTurn(live);

  try {
    await writeJson(input.sessionId, message);
    settlePendingTurn(live);
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec) return;

  const type = stringField(rec, "type");
  if (type === "keep_alive") return;

  const cancelId = parseControlCancelId(rec);
  if (cancelId) {
    for (const [uiId, pending] of live.approvals) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.approvals.delete(uiId);
      }
    }
    for (const [uiId, pending] of live.questions) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.questions.delete(uiId);
      }
    }
    return;
  }

  const control = parseControlRequest(rec);
  if (control) {
    void handleControlRequest(sessionId, live, control);
    return;
  }

  const sessionIdFromLine = sessionIdFromMessage(rec);
  if (sessionIdFromLine && sessionIdFromLine !== live.claudeSessionId) {
    live.claudeSessionId = sessionIdFromLine;
    resumeByThread.set(sessionId, {
      sessionId: sessionIdFromLine,
      cwd: live.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: sessionIdFromLine,
    });
  }

  if (
    type === "system" &&
    (stringField(rec, "subtype") === "init" || stringField(rec, "subtype") === "initialized")
  ) {
    markInitialized(live);
  }

  if (type === "control_response") {
    markInitialized(live);
    const response = parseControlResponse(rec);
    const waiting = response && live.pendingControls.get(response.requestId);
    if (response && waiting) {
      live.pendingControls.delete(response.requestId);
      waiting(response);
    }
    return;
  }

  if (handleAgentLifecycle(live, rec)) return;
  // A cancelled turn mutes its own trailing output, nothing more. Muting the
  // whole stream here once ate every control_response after Stop, so each
  // later stop_task "timed out" while its answer sat unread — and subagents
  // that outlived the turn kept writing into the void.
  if (live.muteUpdates && !isSubagentMessage(rec)) return;
  if (type === "tool_progress") {
    handleToolProgress(live, rec);
    return;
  }
  if (type === "stream_event") {
    handleStreamEvent(live, rec);
    return;
  }
  if (type === "assistant") {
    handleAssistant(live, rec);
    return;
  }
  if (type === "user") {
    handleUser(live, rec);
    return;
  }
  if (type === "result") {
    handleResult(live, rec);
    return;
  }
  if (type === "system") {
    const text = statusTextFromSystem(rec);
    if (text) live.onEvent({ type: "status", text });
  }
}

function handleStreamEvent(live: Live, rec: Record<string, unknown>): void {
  const parentId = subagentParentId(rec);
  const delta = streamDeltaFromEvent(rec);
  if (delta) {
    if (parentId) {
      const run = agentForParent(live, parentId);
      if (!run) return;
      if (delta.kind === "assistant") {
        run.emittedAssistant = joinStreamText(run.emittedAssistant, delta.text);
      } else {
        run.emittedReasoning = joinStreamText(run.emittedReasoning, delta.text);
      }
      live.onEvent({
        type: "agent.output",
        agentId: run.id,
        kind: delta.kind,
        text: delta.text,
      });
      return;
    }
    if (delta.kind === "assistant") {
      live.emittedAssistant = joinStreamText(live.emittedAssistant, delta.text);
      live.onEvent({ type: "message.delta", text: delta.text });
    } else {
      live.emittedReasoning = joinStreamText(live.emittedReasoning, delta.text);
      live.onEvent({ type: "reasoning.delta", text: delta.text });
    }
    return;
  }

  const started = toolStartFromEvent(rec);
  if (started) {
    if (parentId) {
      startSubagentTool(live, parentId, started);
      noteSubagentTool(live, rec, started.name, started.input);
      return;
    }
    const tool: InFlightTool = {
      id: started.id,
      name: started.name,
      input: started.input,
      partialJson: "",
      title: toolTitle(started.name, started.input),
    };
    if (started.index >= 0) live.toolsByIndex.set(started.index, tool);
    live.toolsById.set(started.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      preview: previewFromTool(tool.name, tool.input),
    });
    emitPlanIfNeeded(live, tool.name, tool.input);
    return;
  }

  const jsonDelta = inputJsonDeltaFromEvent(rec);
  if (jsonDelta) {
    if (parentId) {
      updateSubagentToolInput(live, parentId, jsonDelta);
      return;
    }
    const tool = live.toolsByIndex.get(jsonDelta.index);
    if (!tool) return;
    tool.partialJson += jsonDelta.partial;
    const parsed = tryParseJsonRecord(tool.partialJson);
    if (!parsed) return;
    tool.input = parsed;
    tool.title = toolTitle(tool.name, parsed);
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: "pending",
      detail: summarizeToolRequest(tool.name, parsed),
      preview: previewFromTool(tool.name, parsed),
    });
    emitPlanIfNeeded(live, tool.name, parsed);
    return;
  }
}

function handleAssistant(live: Live, rec: Record<string, unknown>): void {
  const parentId = subagentParentId(rec);
  if (parentId) {
    handleSubagentAssistant(live, parentId, rec);
    for (const use of assistantToolUses(rec)) {
      noteSubagentTool(live, rec, use.name, use.input);
    }
    return;
  }

  const used = contextUsedFromAssistant(rec);
  if (used !== undefined) live.onEvent({ type: "context", used });

  const snapshot = assistantTextBlocks(rec).join("");
  const extra = snapshotRemainder(live.emittedAssistant, snapshot);
  if (extra) {
    live.emittedAssistant = joinStreamText(live.emittedAssistant, extra);
    live.onEvent({ type: "message.delta", text: extra });
  }

  for (const use of assistantToolUses(rec)) {
    if (live.toolsById.has(use.id)) continue;
    const tool: InFlightTool = {
      id: use.id,
      name: use.name,
      input: use.input,
      partialJson: "",
      title: toolTitle(use.name, use.input),
    };
    live.toolsById.set(use.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      preview: previewFromTool(tool.name, tool.input),
    });
    if (use.name === "ExitPlanMode") {
      const plan = extractExitPlanModePlan(use.input);
      if (plan) live.onEvent({ type: "plan", text: plan });
    }
    emitPlanIfNeeded(live, tool.name, tool.input);
  }
}

function handleUser(live: Live, rec: Record<string, unknown>): void {
  if (subagentParentId(rec) !== undefined) {
    handleSubagentToolResults(live, rec);
    return;
  }
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = live.toolsById.get(result.toolUseId);
    if (!tool) continue;
    if (isAgentToolName(tool.name)) {
      noteAgentAddress(live, tool.id, result.text);
      if (isBackgroundedAgentTool(live, tool.id)) continue;
    }
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: result.isError ? "failed" : "completed",
      detail: result.text || undefined,
      preview: previewFromTool(tool.name, tool.input, result.text),
    });
  }
}

function handleResult(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
  const context = contextFromResult(rec);
  if (context) live.onEvent({ type: "context", ...context });

  const result = turnStatusFromResult(rec);
  if (result.status === "failed" && result.error && !live.cancelled) {
    live.onEvent({ type: "session.error", message: result.error });
  }
  live.turnResultSeen = true;
  maybeFinishTurn(live);
}

async function handleControlRequest(
  sessionId: string,
  live: Live,
  control: ClaudeControlRequest,
): Promise<void> {
  if (control.subtype !== "can_use_tool" && control.subtype !== "permission") {
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, {}),
    ).catch(() => undefined);
    return;
  }

  const toolName = control.toolName ?? "tool";
  const input = control.input ?? {};

  if (live.cancelled || live.muteUpdates) {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("deny", input),
      ),
    ).catch(() => undefined);
    return;
  }

  if (toolName === "AskUserQuestion") {
    const questions = questionsFromUnknown(input);
    const uiId = live.nextApprovalUiId++;
    live.onEvent({
      type: "question.asked",
      requestId: uiId,
      title: questionPromptTitle(questions) || extractAskUserQuestionTitle(input),
      questions,
      callId: control.toolUseId,
    });
    const outcome = await waitQuestion(live, uiId, control.requestId);
    const decision =
      outcome === "cancelled"
        ? "cancelled"
        : outcome.kind === "answered"
          ? "answered"
          : "skipped";
    live.onEvent({ type: "question.resolved", requestId: uiId, decision });
    if (outcome === "cancelled") return;
    const response =
      outcome.kind === "answered"
        ? { behavior: "allow", updatedInput: askUserQuestionAllowInput(input, outcome) }
        : {
            behavior: "deny",
            message: "User cancelled tool execution.",
          };
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, response),
    ).catch(() => undefined);
    return;
  }

  if (toolName === "ExitPlanMode") {
    const plan = extractExitPlanModePlan(input);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      }),
    ).catch(() => undefined);
    return;
  }

  applyKnownToolInput(live, toolName, input, control.toolUseId);

  if (live.runtimeMode === "full-access") {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("allow", input),
      ),
    ).catch(() => undefined);
    return;
  }

  const uiId = live.nextApprovalUiId++;
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    callId: control.toolUseId,
    preview: previewFromTool(toolName, input),
  });
  const decision = await waitApproval(live, uiId, control.requestId, input);
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  if (decision === "cancelled") return;
  await writeJson(
    sessionId,
    buildControlResponse(
      control.requestId,
      toClaudePermissionResult(decision, input),
    ),
  ).catch(() => undefined);
}

function applyKnownToolInput(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
  callId?: string,
): void {
  if (!callId || Object.keys(input).length === 0) return;
  const existing = live.toolsById.get(callId);
  if (existing) {
    existing.input = input;
    existing.title = toolTitle(toolName, input);
  }
  live.onEvent({
    type: "tool.updated",
    callId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    status: "pending",
    preview: previewFromTool(toolName, input),
  });
}

function waitApproval(
  live: Live,
  uiId: number,
  requestId: string,
  input: Record<string, unknown>,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    live.approvals.set(uiId, { requestId, input, resolve });
  });
}

function waitQuestion(
  live: Live,
  uiId: number,
  requestId: string,
): Promise<UserQuestionReply | "cancelled"> {
  return new Promise((resolve) => {
    live.questions.set(uiId, { requestId, resolve });
  });
}

function emitPlanIfNeeded(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!isTodoTool(toolName)) return;
  const plan = planTextFromTodos(input);
  if (plan) live.onEvent({ type: "plan", text: plan });
}

function handleAgentLifecycle(
  live: Live,
  rec: Record<string, unknown>,
): boolean {
  const started = parseTaskStarted(rec);
  if (started) {
    if (started.ambient || !isAgentTaskType(started.taskType)) return true;
    live.agentTasks.set(started.taskId, {
      taskId: started.taskId,
      toolUseId: started.toolUseId,
      description: started.description,
      backgrounded: started.backgrounded,
    });
    const agentId = agentIdForTask(live, started.taskId, started.toolUseId);
    announceAgent(live, agentId, {
      title: started.description,
      taskId: started.taskId,
      ...(started.toolUseId ? { callId: started.toolUseId } : {}),
      ...(started.subagentType ? { agentType: started.subagentType } : {}),
      ...(started.spawnDepth ? { depth: started.spawnDepth } : {}),
      ...(started.prompt ? { prompt: started.prompt } : {}),
    });
    // A nested spawn is the subagent's tool call, not the main agent's; it
    // lives in the agents panel tree, not as a row in the main transcript.
    if ((started.spawnDepth ?? 1) <= 1) {
      upsertAgentTool(
        live,
        started.toolUseId ?? `agent:${started.taskId}`,
        started.description,
        "in_progress",
      );
    }
    return true;
  }

  const progress = parseTaskProgress(rec);
  if (progress) {
    const task = live.agentTasks.get(progress.taskId);
    // `description` is what the agent is doing right now ("Reading d3.md"),
    // so it is the detail line; the row keeps the name it was spawned with.
    const detail =
      progress.summary ||
      progress.description ||
      progress.lastToolName ||
      (progress.subagentType
        ? `${progress.subagentType.replace(/[_-]+/g, " ")} subagent`
        : undefined);
    const rowId =
      progress.toolUseId ?? task?.toolUseId ?? `agent:${progress.taskId}`;
    if (live.toolsById.has(rowId)) {
      upsertAgentTool(live, rowId, "", "in_progress", detail);
    }
    const agentId = knownAgentId(
      live,
      progress.taskId,
      progress.toolUseId ?? task?.toolUseId,
    );
    if (agentId) {
      // `description` here is the agent's current activity, not its name —
      // it changes with every tool ("Reading d3.md"); the name stays put.
      const activity = progress.description || progress.lastToolName;
      live.onEvent({
        type: "agent.updated",
        agentId,
        ...(activity ? { activity } : {}),
        ...(progress.summary ? { summary: progress.summary } : {}),
        ...(progress.usage?.totalTokens != null
          ? { tokens: progress.usage.totalTokens }
          : {}),
        ...(progress.usage?.toolUses != null
          ? { toolUses: progress.usage.toolUses }
          : {}),
      });
    }
    return true;
  }

  const updated = parseTaskUpdated(rec);
  if (updated) {
    const task = live.agentTasks.get(updated.taskId);
    if (task && updated.backgrounded !== undefined) {
      task.backgrounded = updated.backgrounded;
    }
    if (task && updated.description) task.description = updated.description;
    if (isTerminalAgentTaskStatus(updated.status)) {
      const settling = knownAgentId(live, updated.taskId, task?.toolUseId);
      if (settling) {
        settleAgent(
          live,
          settling,
          agentStatusFrom(updated.status),
          updated.error,
        );
      }
      completeAgentTask(
        live,
        updated.taskId,
        updated.status === "completed" ? "completed" : "failed",
        updated.error,
      );
    }
    return true;
  }

  const notice = parseTaskNotification(rec);
  if (notice) {
    if (!notice.ambient) {
      const task = live.agentTasks.get(notice.taskId);
      const agentId = knownAgentId(
        live,
        notice.taskId,
        notice.toolUseId ?? task?.toolUseId,
      );
      if (agentId && notice.usage) {
        live.onEvent({
          type: "agent.updated",
          agentId,
          ...(notice.usage.totalTokens != null
            ? { tokens: notice.usage.totalTokens }
            : {}),
          ...(notice.usage.toolUses != null
            ? { toolUses: notice.usage.toolUses }
            : {}),
        });
      }
      if (agentId) {
        settleAgent(
          live,
          agentId,
          agentStatusFrom(notice.status),
          notice.summary || undefined,
        );
      }
      completeAgentTask(
        live,
        notice.taskId,
        notice.status === "completed" ? "completed" : "failed",
        notice.summary || undefined,
      );
    }
    return true;
  }

  const liveTasks = parseBackgroundAgentTasks(rec);
  if (!liveTasks) return false;
  const next = new Set(liveTasks.map((task) => task.taskId));
  live.backgroundTaskIds = next;
  for (const id of [...live.agentTasks.keys()]) {
    if (next.has(id)) continue;
    const task = live.agentTasks.get(id);
    const gone = knownAgentId(live, id, task?.toolUseId);
    if (gone) settleAgent(live, gone, "completed");
    completeAgentTask(live, id, "completed");
  }
  for (const row of liveTasks) {
    if (live.agentTasks.has(row.taskId)) continue;
    live.agentTasks.set(row.taskId, {
      taskId: row.taskId,
      description: row.description,
      backgrounded: true,
    });
    // No row and no run yet: this frame beats `task_started` for the same
    // task, and anything keyed here would never meet what the tool call keys
    // — two rows for one agent, one of them stuck "running". The map entry
    // alone keeps the turn busy until the task reports back.
  }
  maybeFinishTurn(live);
  return true;
}

function agentStatusFrom(
  status: string | undefined,
): "completed" | "failed" | "stopped" {
  const key = (status ?? "").toLowerCase();
  if (key === "completed") return "completed";
  if (key === "killed" || key === "stopped") return "stopped";
  return "failed";
}

function handleToolProgress(live: Live, rec: Record<string, unknown>): void {
  const progress = parseToolProgress(rec);
  if (!progress) return;
  const tool =
    live.toolsById.get(progress.toolUseId) ??
    (progress.parentToolUseId
      ? live.toolsById.get(progress.parentToolUseId)
      : undefined);
  if (!tool || !isAgentToolName(tool.name)) return;
  const detail = progress.subagentType
    ? `${progress.subagentType.replace(/[_-]+/g, " ")} subagent`
    : progress.toolName;
  live.onEvent({
    type: "tool.updated",
    callId: tool.id,
    title: tool.title,
    kind: "agent",
    status: "in_progress",
    ...(detail ? { detail } : {}),
  });
}

/**
 * The run a forwarded frame belongs to. A frame can beat `task_started` here,
 * and nested spawns never announce a tool call we hold, so an unseen parent
 * opens a run rather than dropping the subagent's work on the floor.
 *
 * A parent we *do* hold and that is not an Agent call is something else
 * entirely (a skill fork, an MCP task); those get no row in the agents panel.
 */
function agentForParent(live: Live, parentId: string): LiveAgentRun | null {
  const existing = live.agents.get(parentId);
  if (existing) return existing;
  const parent = live.toolsById.get(parentId);
  if (parent && !isAgentToolName(parent.name)) return null;
  return announceAgent(live, parentId, {
    title: parent?.title,
    callId: parentId,
  });
}

function announceAgent(
  live: Live,
  id: string,
  init: {
    title?: string;
    callId?: string;
    taskId?: string;
    agentType?: string;
    depth?: number;
    prompt?: string;
  },
): LiveAgentRun {
  const title = init.title || live.agents.get(id)?.title || "Subagent";
  const run = live.agents.get(id) ?? {
    id,
    title,
    settled: false,
    emittedAssistant: "",
    emittedReasoning: "",
  };
  run.title = title;
  run.settled = false;
  if (init.taskId) run.taskId = init.taskId;
  // A nested spawn's Agent call streamed through its parent first, so the
  // parent run is whoever owns that tool call.
  run.parentId ??= live.subTools.get(id)?.agentId;
  live.agents.set(id, run);
  live.onEvent({
    type: "agent.started",
    agentId: id,
    title,
    ...(init.callId ? { callId: init.callId } : {}),
    ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(init.agentType ? { agentType: init.agentType } : {}),
    ...(init.depth ? { depth: init.depth } : {}),
    ...(init.prompt ? { prompt: init.prompt } : {}),
    ...(run.parentId ? { parentId: run.parentId } : {}),
  });
  return run;
}

function settleAgent(
  live: Live,
  id: string,
  status: "completed" | "failed" | "stopped",
  summary?: string,
): void {
  const run = live.agents.get(id);
  if (!run || run.settled) return;
  run.settled = true;
  live.onEvent({
    type: "agent.updated",
    agentId: id,
    status,
    ...(summary ? { summary } : {}),
  });
}

/**
 * The run id for a task we have already registered. `task_progress` and the
 * settle events carry no task_type, so a background Bash task looks exactly
 * like a subagent here — minting an id from one of those is how a shell
 * command ended up wearing a subagent's token count.
 */
function knownAgentId(
  live: Live,
  taskId: string,
  toolUseId?: string,
): string | undefined {
  const known = live.agentByTask.get(taskId);
  if (known) return known;
  return toolUseId && live.agents.has(toolUseId) ? toolUseId : undefined;
}

/** The run id for a task, minted from the spawning tool call when there is one. */
function agentIdForTask(
  live: Live,
  taskId: string,
  toolUseId?: string,
): string {
  const known = live.agentByTask.get(taskId);
  if (known) return known;
  const id = toolUseId ?? `task:${taskId}`;
  live.agentByTask.set(taskId, id);
  return id;
}

function subToolKey(parentId: string, index: number): string {
  return `${parentId}#${index}`;
}

function startSubagentTool(
  live: Live,
  parentId: string,
  started: { index: number; id: string; name: string; input: Record<string, unknown> },
): void {
  const run = agentForParent(live, parentId);
  if (!run) return;
  const tool: SubagentTool = {
    agentId: run.id,
    id: started.id,
    name: started.name,
    input: started.input,
    partialJson: "",
    title: toolTitle(started.name, started.input),
  };
  live.subTools.set(started.id, tool);
  if (started.index >= 0) {
    live.subToolsByIndex.set(subToolKey(parentId, started.index), tool);
  }
  emitSubagentTool(live, tool, "pending");
}

function updateSubagentToolInput(
  live: Live,
  parentId: string,
  jsonDelta: { index: number; partial: string },
): void {
  const tool = live.subToolsByIndex.get(subToolKey(parentId, jsonDelta.index));
  if (!tool) return;
  tool.partialJson += jsonDelta.partial;
  const parsed = tryParseJsonRecord(tool.partialJson);
  if (!parsed) return;
  tool.input = parsed;
  tool.title = toolTitle(tool.name, parsed);
  emitSubagentTool(live, tool, "pending");
}

function handleSubagentAssistant(
  live: Live,
  parentId: string,
  rec: Record<string, unknown>,
): void {
  const run = agentForParent(live, parentId);
  if (!run) return;
  const thinkingSnapshot = assistantThinkingBlocks(rec).join("");
  const thinking = snapshotRemainder(run.emittedReasoning, thinkingSnapshot);
  if (thinking) {
    const text = separateMessages(run.emittedReasoning, thinkingSnapshot, thinking);
    run.emittedReasoning = joinStreamText(run.emittedReasoning, text);
    live.onEvent({
      type: "agent.output",
      agentId: run.id,
      kind: "reasoning",
      text,
    });
  }
  const snapshot = assistantTextBlocks(rec).join("");
  const extra = snapshotRemainder(run.emittedAssistant, snapshot);
  if (extra) {
    const text = separateMessages(run.emittedAssistant, snapshot, extra);
    run.emittedAssistant = joinStreamText(run.emittedAssistant, text);
    live.onEvent({
      type: "agent.output",
      agentId: run.id,
      kind: "assistant",
      text,
    });
  }
  for (const use of assistantToolUses(rec)) {
    if (live.subTools.has(use.id)) continue;
    const tool: SubagentTool = {
      agentId: run.id,
      id: use.id,
      name: use.name,
      input: use.input,
      partialJson: "",
      title: toolTitle(use.name, use.input),
    };
    live.subTools.set(use.id, tool);
    emitSubagentTool(live, tool, "pending");
  }
}

/**
 * The CLI forwards a subagent as whole messages rather than deltas, so two
 * replies in a row would otherwise be glued into one paragraph. A remainder
 * that is a suffix of what we hold is the same message continuing; one that is
 * the whole snapshot is a new message and earns a break.
 */
function separateMessages(
  already: string,
  snapshot: string,
  extra: string,
): string {
  if (!already || extra !== snapshot || already.endsWith("\n")) return extra;
  return `\n\n${extra}`;
}

function handleSubagentToolResults(
  live: Live,
  rec: Record<string, unknown>,
): void {
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = live.subTools.get(result.toolUseId);
    if (!tool) continue;
    emitSubagentTool(
      live,
      tool,
      result.isError ? "failed" : "completed",
      result.text,
    );
    // A result is terminal, so the entry has no further use; a long-lived
    // background agent would otherwise grow this map for the whole session.
    live.subTools.delete(result.toolUseId);
  }
}

function emitSubagentTool(
  live: Live,
  tool: SubagentTool,
  status: "pending" | "completed" | "failed",
  resultText?: string,
): void {
  live.onEvent({
    type: "agent.tool",
    agentId: tool.agentId,
    callId: tool.id,
    title: tool.title,
    kind: toolKindFromName(tool.name),
    status,
    ...(resultText ? { detail: resultText } : {}),
    preview: previewFromTool(tool.name, tool.input, resultText),
  });
}

/** The Agent tool's result is the only place the CLI names a reachable agent. */
function noteAgentAddress(live: Live, toolUseId: string, text: string): void {
  const address = sendMessageAddress(text);
  if (!address) return;
  const run = live.agents.get(toolUseId);
  if (!run) return;
  live.onEvent({ type: "agent.updated", agentId: run.id, address });
}

function noteSubagentTool(
  live: Live,
  rec: Record<string, unknown>,
  name: string,
  input: Record<string, unknown>,
): void {
  const parentId = stringField(rec, "parent_tool_use_id");
  if (!parentId) return;
  const parent = live.toolsById.get(parentId);
  if (!parent || !isAgentToolName(parent.name)) return;
  live.onEvent({
    type: "tool.updated",
    callId: parent.id,
    title: parent.title,
    kind: "agent",
    status: "in_progress",
    detail: toolTitle(name, input),
  });
}

function isBackgroundedAgentTool(live: Live, toolUseId: string): boolean {
  for (const task of live.agentTasks.values()) {
    if (task.toolUseId === toolUseId && task.backgrounded) return true;
  }
  return false;
}

function upsertAgentTool(
  live: Live,
  id: string,
  title: string,
  status: string,
  detail?: string,
): void {
  const existing = live.toolsById.get(id);
  if (!existing) {
    live.toolsById.set(id, {
      id,
      name: "Agent",
      input: {},
      partialJson: "",
      title,
    });
    live.onEvent({
      type: "tool.started",
      callId: id,
      title,
      kind: "agent",
      status,
    });
    if (status !== "in_progress" && status !== "pending" && status !== "running") {
      live.onEvent({
        type: "tool.updated",
        callId: id,
        title,
        kind: "agent",
        status,
        ...(detail ? { detail } : {}),
      });
    }
    return;
  }
  if (title) existing.title = title;
  live.onEvent({
    type: "tool.updated",
    callId: id,
    title: existing.title,
    kind: "agent",
    status,
    ...(detail ? { detail } : {}),
  });
}

function completeAgentTask(
  live: Live,
  taskId: string,
  status: string,
  detail?: string,
): void {
  const task = live.agentTasks.get(taskId);
  live.agentTasks.delete(taskId);
  const rowId = task?.toolUseId ?? `agent:${taskId}`;
  if (task && live.toolsById.has(rowId)) {
    upsertAgentTool(live, rowId, task.description, status, detail);
  }
  maybeFinishTurn(live);
}

function maybeFinishTurn(live: Live): void {
  if (!live.turnResultSeen) return;
  if (live.agentTasks.size > 0) return;
  if (!live.activeTurn && !live.turnDone) return;
  settleStaleAgents(live);
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

/**
 * The turn is over and nothing is pending, so any run still marked running
 * that the CLI does not list as a live background task cannot be alive — its
 * terminal event was lost or never sent. Left alone it would spin forever.
 */
function settleStaleAgents(live: Live): void {
  for (const run of live.agents.values()) {
    if (run.settled) continue;
    if (run.taskId && live.backgroundTaskIds.has(run.taskId)) continue;
    settleAgent(live, run.id, "completed");
  }
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  live.turnEndPending = false;
  live.activeTurn = false;
  for (const event of extraEvents) live.onEvent(event);
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) live.turnEndPending = true;
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

function markInitialized(live: Live): void {
  if (live.initialized) return;
  live.initialized = true;
  live.initDone?.();
  live.initDone = null;
}

function waitForInit(live: Live, timeoutMs: number): Promise<void> {
  if (live.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.initDone = null;
      resolve();
    }, timeoutMs);
    live.initDone = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function nextControlId(live: Live): string {
  live.nextControlId += 1;
  return `monocode_${live.nextControlId}`;
}

function writeJson(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return writeChild(sessionId, JSON.stringify(payload));
}

function settingsKeyFor(input: SendTurnInput): string {
  return claudeSettingsKey({
    model: nativeModelId(input.model),
    effort: input.modelSettings?.effort,
    fast: input.modelSettings?.fast,
    thinking: input.modelSettings?.thinking,
    context: input.modelSettings?.context,
    runtimeMode: input.runtimeMode,
    hooks: loadClaudeHooks(),
  });
}

function launchOptions(
  input: SendTurnInput,
  resume: string | undefined,
  sessionId: string,
): {
  model?: string;
  effort?: string;
  permissionMode?: ReturnType<typeof runtimeModeToPermission>;
  resume?: string;
  sessionId?: string;
  settings?: ClaudeCliSettings;
} {
  const native = nativeModelId(input.model);
  const effortRaw = input.modelSettings?.effort;
  const context = input.modelSettings?.context;
  const settings: ClaudeCliSettings = {};
  if (input.modelSettings?.thinking === "true") {
    settings.alwaysThinkingEnabled = true;
  }
  if (input.modelSettings?.fast === "true") {
    settings.fastMode = true;
  }
  if (isClaudeUltracodeEffort(effortRaw)) {
    settings.ultracode = true;
  }
  if (!loadClaudeHooks()) {
    settings.disableAllHooks = true;
  }
  return {
    model: resolveClaudeApiModelId(native, context),
    effort: normalizeClaudeCliEffort(effortRaw, native),
    permissionMode: runtimeModeToPermission(input.runtimeMode),
    resume,
    sessionId: resume ? undefined : sessionId,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
  };
}

/** Exported for tests. */
export function __claudeTestReset(): void {
  liveByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
}
