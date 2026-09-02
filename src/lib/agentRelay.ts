import type { AgentRun } from "./session";

/**
 * There is no channel from a host to a running subagent — the CLI's control
 * protocol has no such request, and the only address a subagent answers on is
 * SendMessage, which belongs to the model. So a reply from the agents panel is
 * an instruction to the main agent, written plainly enough that it forwards the
 * message instead of acting on it.
 */
export function buildAgentRelayPrompt(agent: AgentRun, text: string): string {
  const target = agent.address
    ? `the running subagent "${agent.title}" (SendMessage to: "${agent.address}")`
    : `the running subagent "${agent.title}"`;
  return [
    `Forward this message to ${target} with the SendMessage tool. Do not act on it yourself, and do not summarize it — pass it through as written.`,
    "",
    text,
  ].join("\n");
}
