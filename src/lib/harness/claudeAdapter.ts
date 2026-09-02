import {
  bindClaudeSession,
  cancelClaudeTurn,
  forgetClaudeSession,
  respondClaudeApproval,
  respondClaudeQuestion,
  sendClaudeTurn,
  steerClaudeTurn,
  stopClaudeAgent,
  stopClaudeSession,
} from "./claude";
import { stoppableId } from "./agentRuns";
import { buildAgentRelayPrompt } from "../agentRelay";
import { refreshClaudeCatalog } from "./claudeCatalog";
import {
  generateClaudeBranchName,
  generateClaudeCommitMessage,
  generateClaudePrContent,
} from "./claudeGit";
import { generateClaudeSessionTitle } from "./claudeTitle";
import { warmupClaudeText } from "./claudeText";
import { registerHarness, type HarnessAdapter } from "./registry";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  live: true,
  sendTurn: sendClaudeTurn,
  steerTurn: steerClaudeTurn,
  cancelTurn: cancelClaudeTurn,
  stopAgent: async (sessionId, agent) => {
    const target = stoppableId(agent);
    if (!target) throw new Error("Claude never reported an id for it.");
    await stopClaudeAgent(sessionId, target);
  },
  agentRelayPrompt: buildAgentRelayPrompt,
  respondApproval: respondClaudeApproval,
  respondQuestion: respondClaudeQuestion,
  stopSession: stopClaudeSession,
  forgetSession: forgetClaudeSession,
  bindSession: bindClaudeSession,
  refreshCatalog: refreshClaudeCatalog,
  generateTitle: generateClaudeSessionTitle,
  generateCommitMessage: generateClaudeCommitMessage,
  generatePrContent: generateClaudePrContent,
  generateBranchName: generateClaudeBranchName,
  warmupText: warmupClaudeText,
};

let registered = false;

export function ensureClaudeRegistered(): void {
  if (registered) return;
  registerHarness(claudeAdapter);
  registered = true;
}
