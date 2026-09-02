import type {
  AgentRunStatus,
  Attachment,
  RuntimeMode,
  ToolPreview,
} from "../session";
import type { UserQuestion } from "../userQuestion";

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.providerBound"; providerSessionId: string }
  | { type: "status"; text: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed" }
  | {
      type: "tool.started";
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      preview?: ToolPreview;
    }
  | {
      type: "tool.updated";
      callId: string;
      title?: string;
      kind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
    }
  | {
      type: "approval.requested";
      requestId: number;
      title: string;
      kind?: string;
      callId?: string;
      preview?: ToolPreview;
    }
  | {
      type: "approval.resolved";
      requestId: number;
      /** "cancelled" = a PermissionRequest hook decided before the user could. */
      decision: "allow" | "deny" | "cancelled";
    }
  | {
      type: "question.asked";
      requestId: number;
      title?: string;
      questions: UserQuestion[];
      callId?: string;
    }
  | {
      type: "question.resolved";
      requestId: number;
      decision: "answered" | "skipped" | "cancelled";
    }
  | { type: "plan"; text: string }
  /** Context-window level after the harness's latest request. */
  | { type: "context"; used?: number; window?: number }
  | {
      type: "agent.started";
      agentId: string;
      title: string;
      callId?: string;
      taskId?: string;
      agentType?: string;
      depth?: number;
      prompt?: string;
      parentId?: string;
    }
  | {
      type: "agent.updated";
      agentId: string;
      title?: string;
      status?: AgentRunStatus;
      activity?: string;
      summary?: string;
      tokens?: number;
      toolUses?: number;
      address?: string;
      /** A stop was requested and the harness has not answered yet. */
      stopping?: boolean;
    }
  /** A body or thinking delta the subagent wrote. */
  | {
      type: "agent.output";
      agentId: string;
      kind: "assistant" | "reasoning";
      text: string;
    }
  | {
      type: "agent.tool";
      agentId: string;
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
    };

export type ApprovalDecision = "allow" | "deny";

export type SendTurnInput = {
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  runtimeMode: RuntimeMode;
  text: string;
  attachments?: Attachment[];
  onEvent: (event: HarnessEvent) => void;
};

export type SteerTurnInput = {
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  text: string;
  attachments?: Attachment[];
};
