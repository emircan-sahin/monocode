import type { ContextUsage } from "./contextUsage";
import type { UserQuestionPrompt } from "./userQuestion";
import type { HandoffComposerCard } from "./handoff";
import type { InboxComposerCard } from "./githubTasks";
import type { NoteCardMeta, NoteComposerCard } from "./notes";
import {
  defaultSessionChoice,
  preferredModelId,
  preferredModelSettings,
  resolveModel,
} from "./models";

export type HarnessId =
  "claude" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "omp" | "fx";

export const HARNESSES: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "fx",
];

export type BlockRole =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "approval"
  | "plan"
  | "system"
  | "handoff";

export type HandoffStatus = "preparing" | "ready";

export type HandoffMeta = {
  from: HarnessId;
  to: HarnessId;
  status: HandoffStatus;
  /** Inject this brief into prompts to `to` until that harness accepts a turn. */
  pending?: boolean;
};

/** Compact transcript card for a second-opinion or split-pane handoff turn. */
export type SecondOpinionMeta = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
  /** Split-pane continue. Default is a second-opinion review. */
  kind?: "handoff";
};

export type ToolPreviewKind = "read" | "write" | "shell" | "search";

export type ToolPreviewLineKind = "add" | "del" | "context";

export type ToolPreviewLine = {
  number?: number;
  kind: ToolPreviewLineKind;
  text: string;
};

export type ToolPreview = {
  kind: ToolPreviewKind;
  title?: string;
  path?: string;
  fileName?: string;
  startLine?: number;
  additions?: number;
  deletions?: number;
  query?: string;
  lines?: ToolPreviewLine[];
  output?: string;
};

export type AttachmentKind = "image" | "audio" | "file";

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** Absolute path when the file lives on disk. */
  path?: string;
  /** Base64 payload for vision images (and pasted blobs) sent to the harness. */
  data?: string;
  /** Object URL for in-session thumbnails. Not persisted. */
  previewUrl?: string;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  attachments?: Attachment[];
  streaming?: boolean;
  /** Epoch ms when this user turn started. */
  startedAt?: number;
  /** How long the agent worked on this user turn, in ms. */
  durationMs?: number;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: ToolPreview;
  };
  approval?: {
    requestId: number;
    decided?: "allow" | "deny" | "cancelled";
  };
  handoff?: HandoffMeta;
  secondOpinion?: SecondOpinionMeta;
  /** Note chip shown on this user turn. Body is not stored; the harness already received it. */
  noteCard?: NoteCardMeta;
};

export type AgentRunStatus = "running" | "completed" | "failed" | "stopped";

/**
 * One spawned subagent, with the transcript it wrote. Claude only forwards a
 * subagent's text when the session declares `forwardSubagentText`, so `blocks`
 * is empty on harnesses that keep their subagents opaque; the header fields
 * still fill in from task lifecycle events.
 */
export type AgentRun = {
  id: string;
  /** Harness task id, when the harness names one. Needed to stop it. */
  taskId?: string;
  /** The Agent tool call that spawned it — ties the run to its transcript row. */
  callId?: string;
  title: string;
  /** Agent type as the harness named it ("Explore", "general-purpose", …). */
  agentType?: string;
  /** The brief this subagent was handed, when the harness reports one. */
  prompt?: string;
  status: AgentRunStatus;
  /** A stop is in flight; cleared when the harness answers either way. */
  stopping?: boolean;
  /** 1 for a top-level spawn, N+1 for one spawned inside a depth-N agent. */
  depth?: number;
  startedAt: number;
  endedAt?: number;
  /** What the subagent is doing right now, as the harness last described it. */
  activity?: string;
  /** The run that spawned this one, for nested subagents. */
  parentId?: string;
  summary?: string;
  tokens?: number;
  toolUses?: number;
  /** Address for SendMessage, when the harness reported one. */
  address?: string;
  blocks: Block[];
};

export type RuntimeMode =
  "supervised" | "auto-accept-edits" | "auto" | "full-access";

export const RUNTIME_MODES: RuntimeMode[] = [
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "supervised";

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HINT: Record<RuntimeMode, string> = {
  supervised: "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "An AI reviewer approves routine actions; risky ones still ask.",
  "full-access": "Allow commands and edits without prompts.",
};

export type Session = {
  id: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  title: string;
  /** Project / working directory for this session. */
  cwd: string;
  blocks: Block[];
  /** True while a harness turn is in flight. */
  busy?: boolean;
  /** Provider-side conversation id (Cursor ACP session id). */
  providerSessionId?: string;
  /** Context-window level reported by the harness. Absent until it reports. */
  context?: ContextUsage;
  /**
   * Composer switched providers, but the previous child is still live.
   * Handoff runs on the next send, not on picker change.
   */
  pendingSwitch?: PendingHarnessSwitch;
  /**
   * Last composer-pinned branch. Unused after session worktrees were removed;
   * kept so older session records still load.
   */
  branch?: string;
  /** Extra git worktree from the old session-branch feature. Unused. */
  worktreeCwd?: string;
  /** One-shot composer text when opening a session from Inbox. */
  composerSeed?: string;
  /** Inbox issue/PR chip shown above the composer. In-memory, one-shot. */
  inboxCard?: InboxComposerCard;
  /** Note chip shown above the composer. In-memory, one-shot. */
  noteCard?: NoteComposerCard;
  /** Handoff chip shown above the composer. In-memory, one-shot. */
  handoffCard?: HandoffComposerCard;
  /**
   * Live clarifying questions from AskUserQuestion / ask_question / etc.
   * In-memory; request ids do not survive restarts.
   */
  pendingQuestion?: UserQuestionPrompt;
  /**
   * Subagents this session spawned, oldest first. In-memory: a subagent's
   * transcript is only forwarded while its process is live, so it cannot be
   * rebuilt after a restart the way the main transcript can.
   */
  agents?: AgentRun[];
};

export type PendingHarnessSwitch = {
  from: HarnessId;
  fromModel: string;
  fromSettings: Record<string, string>;
  fromProviderSessionId?: string;
};

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  fx: "fx",
};

export const HARNESS_TITLE: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
};

/** fx and Grok Build ACP reject image and audio blocks. */
export function harnessSupportsAttachments(id: HarnessId): boolean {
  return id !== "fx" && id !== "grok";
}

export function newSession(
  harness: HarnessId = "claude",
  cwd = "~",
  model?: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  modelSettings?: Record<string, string>,
): Session {
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  return {
    id: crypto.randomUUID(),
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(resolved, modelSettings),
    runtimeMode,
    title: HARNESS_LABEL[harness],
    cwd,
    blocks: [],
  };
}

/** New conversation using the Providers defaults. */
export function newDefaultSession(
  cwd = "~",
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
): Session {
  const choice = defaultSessionChoice();
  return newSession(choice.harness, cwd, choice.model, runtimeMode);
}

/** First line of a prompt, truncated for the tab strip. */
export function titleFromPrompt(
  prompt: string,
  harness: HarnessId,
  attachments: Attachment[] = [],
): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const fromFiles =
    !line && attachments.length > 0
      ? attachments
          .map((file) => file.name)
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
      : "";
  const seed = line || fromFiles;
  if (!seed) return HARNESS_LABEL[harness];
  const max = 72;
  const short = seed.length > max ? `${seed.slice(0, max - 1)}…` : seed;
  return formatSessionTitle(harness, short);
}

export function formatSessionTitle(harness: HarnessId, title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return HARNESS_LABEL[harness];
  return `${HARNESS_LABEL[harness]} · ${trimmed}`;
}

/** True when the stored title is still a placeholder the LLM may replace. */
export function canReplaceSessionTitle(
  current: string,
  harness: HarnessId,
  seed: string,
): boolean {
  return (
    current === seed ||
    current === HARNESS_LABEL[harness] ||
    current === HARNESS_TITLE[harness]
  );
}

export function hasPendingApproval(blocks: Block[]): boolean {
  return blocks.some((block) => block.approval && !block.approval.decided);
}

export function sessionNeedsInput(session: Session): boolean {
  return hasPendingApproval(session.blocks) || session.pendingQuestion != null;
}

/** Title without the harness prefix stored for the tab strip. */
export function sessionDisplayTitle(title: string, harness: HarnessId): string {
  const prefix = `${HARNESS_LABEL[harness]} · `;
  if (title.startsWith(prefix)) return title.slice(prefix.length);
  if (title === HARNESS_LABEL[harness] || title === HARNESS_TITLE[harness]) {
    return "New session";
  }
  return title;
}

/** Working copy the agent and session git UIs should use. */
export function sessionWorkCwd(session: {
  cwd: string;
  worktreeCwd?: string;
}): string {
  return session.worktreeCwd || session.cwd;
}
