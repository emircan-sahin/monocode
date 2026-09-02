import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  CircleDashed,
  CircleX,
  Square,
  X,
} from "../chrome/icons";
import { TerminalSpinner } from "../chrome/TerminalSpinner";
import { stoppableId } from "../lib/harness/agentRuns";
import type { AgentRun, Block } from "../lib/session";
import { AgentMarkdown } from "./AgentMarkdown";
import { toolCallLabel } from "./transcriptActivity";

type Props = {
  agents: AgentRun[];
  cwd?: string;
  /** False once the session's process is gone: stop and reply stop working. */
  live: boolean;
  selectedId?: string;
  onSelect: (agentId: string) => void;
  onClose: () => void;
  onStop?: (agent: AgentRun) => void;
  onMessage?: (agent: AgentRun, text: string) => void;
};

export function AgentsPanel({
  agents,
  cwd,
  live,
  selectedId,
  onSelect,
  onClose,
  onStop,
  onMessage,
}: Props) {
  const selected =
    agents.find((agent) => agent.id === selectedId) ??
    agents.find((agent) => agent.status === "running") ??
    agents[agents.length - 1];
  const running = agents.filter((agent) => agent.status === "running").length;
  const finished = agents.length - running;
  const stoppable = agents.some(
    (agent) => agent.status === "running" && !agent.stopping,
  );
  const rows = useMemo(() => treeRows(agents), [agents]);
  // Elapsed time is derived from wall clock, so a run with no traffic would
  // otherwise sit at whatever second it last rendered on.
  useNowWhile(running > 0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="Subagents"
      className="absolute inset-y-0 right-0 z-40 flex w-[min(30rem,85%)] flex-col border-l border-content/10 bg-background-base/95 shadow-xl backdrop-blur-xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-content/10 px-3 py-2">
        <Bot className="size-4 shrink-0 text-content/50" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate font-sans text-xs text-content">
          Subagents
          <span className="text-content/45">
            {" · "}
            {running > 0 ? `${running} running` : "none running"}
            {finished > 0 ? ` · ${finished} finished` : ""}
          </span>
        </span>
        {running > 0 && onStop && live ? (
          <button
            type="button"
            disabled={!stoppable}
            title={
              stoppable
                ? "Stop every running subagent"
                : "Waiting for Claude to confirm the stops"
            }
            onClick={() => {
              // A stop cascades to nested runs, so only the top of each live
              // subtree needs asking; stopping a child twice reads as an error.
              for (const agent of agents) {
                if (
                  agent.status === "running" &&
                  !agent.stopping &&
                  !hasRunningAncestor(agents, agent)
                ) {
                  onStop(agent);
                }
              }
            }}
            className="flex shrink-0 items-center gap-1 rounded border border-content/15 px-1.5 py-0.5 font-sans text-[11px] text-content/60 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Square className="size-2.5" strokeWidth={2} />
            {stoppable ? "Stop all" : "Stopping…"}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close subagents"
          title="Close subagents"
          onClick={onClose}
          className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      </header>

      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-content/10">
        {rows.map(({ agent, level }) => (
          <AgentListRow
            key={agent.id}
            agent={agent}
            level={level}
            selected={agent.id === selected?.id}
            onSelect={() => onSelect(agent.id)}
          />
        ))}
      </div>

      {selected ? (
        <AgentDetail
          agent={selected}
          agents={agents}
          cwd={cwd}
          live={live}
          onStop={onStop}
          onMessage={onMessage}
        />
      ) : (
        <p className="p-4 font-sans text-xs text-content/45">
          No subagents yet.
        </p>
      )}
    </aside>
  );
}

/**
 * Spawn order, but with each run's children right under it. A nested agent
 * listed away from its parent is what made "3 running" read as a lie next to
 * six rows: the rows were real, the relationship was missing.
 */
function treeRows(agents: AgentRun[]): Array<{ agent: AgentRun; level: number }> {
  const ids = new Set(agents.map((agent) => agent.id));
  const out: Array<{ agent: AgentRun; level: number }> = [];
  const walk = (parentId: string | undefined, level: number) => {
    for (const agent of agents) {
      const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : undefined;
      if (parent !== parentId) continue;
      out.push({ agent, level });
      walk(agent.id, level + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

function hasRunningAncestor(agents: AgentRun[], agent: AgentRun): boolean {
  let parent = agents.find((row) => row.id === agent.parentId);
  while (parent) {
    if (parent.status === "running") return true;
    parent = agents.find((row) => row.id === parent?.parentId);
  }
  return false;
}

/** Running descendants of a run — what a Stop on it will take down too. */
function runningDescendants(agents: AgentRun[], id: string): number {
  let count = 0;
  for (const agent of agents) {
    if (agent.parentId !== id) continue;
    if (agent.status === "running") count += 1;
    count += runningDescendants(agents, agent.id);
  }
  return count;
}

const STATUS_LABEL: Record<AgentRun["status"], string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/** Re-renders once a second while anything is still running. */
function useNowWhile(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}

function AgentListRow({
  agent,
  level,
  selected,
  onSelect,
}: {
  agent: AgentRun;
  level: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const running = agent.status === "running";
  return (
    <button
      type="button"
      aria-current={selected}
      onClick={onSelect}
      style={{ paddingLeft: 12 + level * 14 }}
      className={`flex w-full min-w-0 items-center gap-2 py-1.5 pr-3 text-left font-sans text-xs ${
        selected
          ? "bg-content/10 text-content"
          : running
            ? "text-content/70 hover:bg-content/5"
            : "text-content/40 hover:bg-content/5"
      }`}
    >
      {level > 0 ? (
        <span aria-hidden className="shrink-0 text-content/25">
          ↳
        </span>
      ) : null}
      <AgentStatusIcon status={agent.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={agent.title}>
          {agent.title}
        </span>
        {running && agent.activity ? (
          <span className="truncate text-[11px] text-content/40">
            {agent.activity}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums text-content/40">
        {running ? agentMetrics(agent) : STATUS_LABEL[agent.status]}
      </span>
    </button>
  );
}

function AgentStatusIcon({ status }: { status: AgentRun["status"] }) {
  if (status === "running") {
    return (
      <CircleDashed
        className="size-3.5 shrink-0 zen-tool-spin text-content/50"
        strokeWidth={1.75}
      />
    );
  }
  if (status === "completed") {
    return <Check className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />;
  }
  return <CircleX className="size-3.5 shrink-0 text-red-400" strokeWidth={1.75} />;
}

function agentMetrics(agent: AgentRun): string {
  const parts: string[] = [];
  if (agent.tokens != null) parts.push(compactTokens(agent.tokens));
  const elapsed = (agent.endedAt ?? Date.now()) - agent.startedAt;
  if (elapsed > 1000) parts.push(`${Math.round(elapsed / 1000)}s`);
  return parts.join(" · ");
}

function compactTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function AgentDetail({
  agent,
  agents,
  cwd,
  live,
  onStop,
  onMessage,
}: {
  agent: AgentRun;
  agents: AgentRun[];
  cwd?: string;
  live: boolean;
  onStop?: (agent: AgentRun) => void;
  onMessage?: (agent: AgentRun, text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastBlock = agent.blocks[agent.blocks.length - 1];

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [agent.id, agent.blocks.length, lastBlock?.text]);

  const subtitle = useMemo(() => {
    const parts = [
      agent.agentType,
      agent.status === "running" ? agent.activity : STATUS_LABEL[agent.status],
    ].filter(Boolean);
    return parts.join(" · ");
  }, [agent.agentType, agent.activity, agent.status]);
  const nested = runningDescendants(agents, agent.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-xs text-content">{agent.title}</p>
          {subtitle ? (
            <p className="truncate font-sans text-[11px] text-content/45">
              {subtitle}
            </p>
          ) : null}
        </div>
        {agent.status === "running" && onStop && live ? (
          <button
            type="button"
            // Hiding this when Claude never named the run was the wrong call:
            // a missing button reads as "this one cannot be stopped" with no
            // reason given. Show it, disabled, and say why.
            disabled={!stoppableId(agent) || agent.stopping}
            title={
              agent.stopping
                ? "Waiting for Claude to confirm the stop"
                : stoppableId(agent)
                  ? "Stop this subagent"
                  : "Claude never reported an id for this subagent — use the session Stop to end the whole turn."
            }
            aria-label="Stop this subagent"
            onClick={() => onStop(agent)}
            className="flex shrink-0 items-center gap-1 rounded border border-content/15 px-1.5 py-0.5 font-sans text-[11px] text-content/60 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Square className="size-2.5" strokeWidth={2} />
            {agent.stopping
              ? "Stopping…"
              : nested > 0
                ? `Stop (+${nested} nested)`
                : "Stop"}
          </button>
        ) : null}
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
      >
        {agent.prompt ? (
          <p className="mb-2 whitespace-pre-wrap break-words rounded border border-content/10 bg-content/5 px-2 py-1.5 font-sans text-xs text-content/60">
            {agent.prompt}
          </p>
        ) : null}
        {agent.blocks.length === 0 ? (
          <EmptyAgentBody agent={agent} />
        ) : (
          agent.blocks.map((block) => (
            <AgentBlockRow key={block.id} block={block} cwd={cwd} />
          ))
        )}
        {agent.summary ? (
          <p className="mt-2 border-t border-content/10 pt-2 font-sans text-xs text-content/55">
            {agent.summary}
          </p>
        ) : null}
      </div>

      {onMessage ? (
        <AgentComposer
          agent={agent}
          disabled={!live || agent.status !== "running"}
          onSend={(text) => onMessage(agent, text)}
        />
      ) : null}
    </div>
  );
}

function EmptyAgentBody({ agent }: { agent: AgentRun }) {
  if (agent.status === "running") {
    return (
      <div className="flex items-center gap-2 py-3 font-sans text-xs text-content/45">
        <TerminalSpinner />
        Waiting for the subagent to write something.
      </div>
    );
  }
  return (
    <p className="py-3 font-sans text-xs text-content/45">
      This subagent finished without forwarding a transcript.
    </p>
  );
}

function AgentBlockRow({ block, cwd }: { block: Block; cwd?: string }) {
  if (block.role === "tool") {
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 font-sans text-xs text-content/55">
        <ToolStateDot status={block.tool?.status} />
        <span className="min-w-0 truncate">{toolCallLabel(block, cwd)}</span>
      </div>
    );
  }
  if (block.role === "reasoning") {
    return (
      <p className="whitespace-pre-wrap break-words py-1 font-sans text-xs italic text-content/40">
        {block.text}
      </p>
    );
  }
  return (
    <div className="min-w-0 py-1 text-sm text-content/85">
      <AgentMarkdown text={block.text} streaming={block.streaming} cwd={cwd} />
    </div>
  );
}

function ToolStateDot({ status }: { status?: string }) {
  const color =
    status === "failed"
      ? "bg-red-400"
      : status === "completed"
        ? "bg-content/30"
        : "bg-accent";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}

/**
 * Nothing in the CLI protocol delivers a message straight to a running
 * subagent, so this asks the main agent to relay it. The copy says so, because
 * a box that looks like a direct channel and is not would be a lie.
 */
function AgentComposer({
  agent,
  disabled,
  onSend,
}: {
  agent: AgentRun;
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="shrink-0 border-t border-content/10 p-2">
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={
            disabled
              ? "This subagent is no longer running."
              : `Relay a message to ${agent.title}`
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="max-h-24 min-h-7 flex-1 resize-none rounded border border-content/15 bg-transparent px-2 py-1 font-sans text-xs text-content outline-none placeholder:text-content/35 focus:border-content/30 disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="Relay message"
          title="Relay message through the main agent"
          disabled={disabled || !text.trim()}
          onClick={send}
          className="grid size-7 shrink-0 place-items-center rounded bg-content/10 text-content hover:bg-content/15 disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" strokeWidth={2} />
        </button>
      </div>
      {disabled ? null : (
        <p className="px-0.5 pt-1 font-sans text-[10px] text-content/35">
          Sent through the main agent — it forwards this with SendMessage.
        </p>
      )}
    </div>
  );
}
