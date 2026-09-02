import type { AgentRun, Block, Session } from "../session";
import { mergeToolPreview } from "./preview";
import { joinStreamText } from "./streamText";
import type { HarnessEvent } from "./types";

export type AgentHarnessEvent = Extract<
  HarnessEvent,
  { type: "agent.started" | "agent.updated" | "agent.output" | "agent.tool" }
>;

/**
 * A runaway subagent can write for minutes before anyone opens its panel, and
 * its transcript is never persisted, so the cap is about the app's memory, not
 * about what a reader can scroll. Oldest blocks fall off the front.
 */
const MAX_AGENT_BLOCKS = 400;

/**
 * A long session can spawn hundreds of subagents, each holding a transcript.
 * Finished runs age out first so a live one is never dropped out from under
 * the panel someone is reading.
 */
const MAX_AGENT_RUNS = 50;

export function isAgentEvent(event: HarnessEvent): event is AgentHarnessEvent {
  return (
    event.type === "agent.started" ||
    event.type === "agent.updated" ||
    event.type === "agent.output" ||
    event.type === "agent.tool"
  );
}

export function applyAgentEvent(
  session: Session,
  event: AgentHarnessEvent,
): Session {
  const agents = session.agents ?? [];
  const index = agents.findIndex((agent) => agent.id === event.agentId);

  if (index < 0) {
    if (event.type !== "agent.started") return session;
    return {
      ...session,
      agents: capRuns([...agents, startedRun(event)]),
    };
  }

  const next = patchRun(agents[index], event);
  if (next === agents[index]) return session;
  const list = agents.slice();
  list[index] = next;
  return { ...session, agents: list };
}

function capRuns(runs: AgentRun[]): AgentRun[] {
  if (runs.length <= MAX_AGENT_RUNS) return runs;
  let over = runs.length - MAX_AGENT_RUNS;
  const kept = runs.filter((agent) => {
    if (over > 0 && agent.status !== "running") {
      over -= 1;
      return false;
    }
    return true;
  });
  // Every run is still live: drop the oldest anyway rather than grow forever.
  return over > 0 ? kept.slice(over) : kept;
}

function startedRun(
  event: Extract<AgentHarnessEvent, { type: "agent.started" }>,
): AgentRun {
  return {
    id: event.agentId,
    title: event.title,
    status: "running",
    startedAt: Date.now(),
    blocks: [],
    ...(event.callId ? { callId: event.callId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.agentType ? { agentType: event.agentType } : {}),
    ...(event.depth ? { depth: event.depth } : {}),
    ...(event.prompt ? { prompt: event.prompt } : {}),
    ...(event.parentId ? { parentId: event.parentId } : {}),
  };
}

function patchRun(run: AgentRun, event: AgentHarnessEvent): AgentRun {
  switch (event.type) {
    case "agent.started":
      // A resumed or re-announced task; keep the transcript it already wrote.
      return {
        ...run,
        title: event.title || run.title,
        status: "running",
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.agentType ? { agentType: event.agentType } : {}),
        ...(event.depth ? { depth: event.depth } : {}),
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.parentId ? { parentId: event.parentId } : {}),
      };
    case "agent.updated":
      return updateRun(run, event);
    case "agent.output":
      return {
        ...run,
        blocks: appendOutput(run.blocks, event.kind, event.text),
      };
    case "agent.tool":
      return { ...run, blocks: upsertAgentTool(run.blocks, event) };
  }
}

function updateRun(
  run: AgentRun,
  event: Extract<AgentHarnessEvent, { type: "agent.updated" }>,
): AgentRun {
  const status = event.status ?? run.status;
  const settled = status !== "running";
  const next: AgentRun = {
    ...run,
    status,
    title: event.title || run.title,
    ...(event.activity ? { activity: event.activity } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.tokens != null ? { tokens: event.tokens } : {}),
    ...(event.toolUses != null ? { toolUses: event.toolUses } : {}),
    ...(event.address ? { address: event.address } : {}),
    ...(settled && run.endedAt == null ? { endedAt: Date.now() } : {}),
  };
  const stopping = settled ? false : (event.stopping ?? run.stopping ?? false);
  if (stopping) next.stopping = true;
  else delete next.stopping;
  if (settled) next.blocks = sealBlocks(next.blocks);
  return sameRun(run, next) ? run : next;
}

function sameRun(a: AgentRun, b: AgentRun): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.activity === b.activity &&
    a.summary === b.summary &&
    a.tokens === b.tokens &&
    a.toolUses === b.toolUses &&
    a.address === b.address &&
    a.stopping === b.stopping &&
    a.endedAt === b.endedAt &&
    a.blocks === b.blocks
  );
}

function trim(blocks: Block[]): Block[] {
  return blocks.length > MAX_AGENT_BLOCKS
    ? blocks.slice(blocks.length - MAX_AGENT_BLOCKS)
    : blocks;
}

function sealBlocks(blocks: Block[]): Block[] {
  if (!blocks.some((block) => block.streaming)) return blocks;
  return blocks.map((block) =>
    block.streaming ? { ...block, streaming: false } : block,
  );
}

function appendOutput(
  blocks: Block[],
  role: "assistant" | "reasoning",
  text: string,
): Block[] {
  if (!text) return blocks;
  const last = blocks[blocks.length - 1];
  if (last?.role === role) {
    const joined = joinStreamText(last.text, text);
    if (joined === last.text) return blocks;
    const next = blocks.slice();
    next[next.length - 1] = { ...last, text: joined, streaming: true };
    return next;
  }
  return trim([
    ...sealBlocks(blocks),
    { id: crypto.randomUUID(), role, text, streaming: true },
  ]);
}

function upsertAgentTool(
  blocks: Block[],
  event: Extract<AgentHarnessEvent, { type: "agent.tool" }>,
): Block[] {
  const streaming = event.status !== "completed" && event.status !== "failed";
  const index = blocks.findIndex(
    (block) => block.tool?.callId === event.callId,
  );
  if (index < 0) {
    return trim([
      ...sealBlocks(blocks),
      {
        id: crypto.randomUUID(),
        role: "tool",
        text: event.title,
        streaming,
        tool: {
          callId: event.callId,
          title: event.title,
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.status ? { status: event.status } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.preview ? { preview: event.preview } : {}),
        },
      },
    ]);
  }
  const prev = blocks[index];
  const preview = mergeToolPreview(event.preview, prev.tool?.preview);
  const next = blocks.slice();
  next[index] = {
    ...prev,
    text: event.title || prev.text,
    streaming,
    tool: {
      ...prev.tool,
      callId: event.callId,
      title: event.title || prev.tool?.title,
      kind: event.kind ?? prev.tool?.kind,
      status: event.status ?? prev.tool?.status,
      detail: event.detail ?? prev.tool?.detail,
      ...(preview ? { preview } : {}),
    },
  };
  return next;
}

/**
 * What a harness can address a running subagent by. Claude's `stop_task`
 * takes the task id, and the SendMessage address is the same id (measured),
 * so a run seen only through forwarded frames still has a handle.
 */
export function stoppableId(agent: AgentRun): string | undefined {
  return agent.taskId ?? agent.address;
}
