import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  cancelClaudeTurn,
  sendClaudeTurn,
  stopClaudeAgent,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
import type { HarnessEvent } from "./types";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse())}`,
  );
};

function findRequest(subtype: string) {
  return parse().find((line) => {
    const request = line.request as Record<string, unknown> | undefined;
    return request?.subtype === subtype;
  });
}

async function waitForRequest(subtype: string) {
  await waitFor(() => findRequest(subtype) !== undefined, subtype);
  return findRequest(subtype)!.request as Record<string, unknown>;
}

function stopRequestId(): string {
  return findRequest("stop_task")!.request_id as string;
}

async function startTurn(sessionId: string) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "explore the codebase",
    attachments: [],
    onEvent: (event) => events.push(event),
  });

  await waitFor(
    () =>
      parse().some((m) => {
        const request = m.request as Record<string, unknown> | undefined;
        return request?.subtype === "initialize";
      }),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(
    () => parse().some((m) => m.type === "user"),
    "user prompt",
  );
  return { events, turn };
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("claude subagents", () => {
  it("stays busy after a parent result while a background subagent is running", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Explore the auth module",
              subagent_type: "explore",
            },
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_agent",
            content: "Backgrounded",
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "tool.started" &&
          event.kind === "agent" &&
          event.title === "Explore the auth module",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "Found the tokens",
    });
    await turn;
    expect(settled).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });

  it("does not end the turn on a subagent result", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_sub",
      parent_tool_use_id: "toolu_agent",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(settled).toBe(true);
  });

  it("does not dump subagent assistant text into the parent transcript", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "I will grep for tokens" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(
      events.some(
        (event) =>
          event.type === "message.delta" &&
          event.text.includes("I will grep for tokens"),
      ),
    ).toBe(false);
  });

  it("routes forwarded subagent text and tools to the run that wrote them", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      subagent_type: "explore",
      spawn_depth: 1,
      task_type: "local_agent",
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          { type: "thinking", thinking: "tokens probably live in auth" },
          { type: "text", text: "I will grep for tokens" },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_sub_grep",
            name: "Grep",
            input: { pattern: "token" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_grep",
            content: "3 matches",
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      last_tool_name: "Grep",
      usage: { total_tokens: 1234, tool_uses: 1, duration_ms: 900 },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "Found the tokens",
    });
    await turn;

    const started = events.find((event) => event.type === "agent.started");
    expect(started).toMatchObject({
      agentId: "toolu_agent",
      taskId: "t1",
      agentType: "explore",
      depth: 1,
    });
    expect(
      events.some(
        (event) =>
          event.type === "agent.output" &&
          event.agentId === "toolu_agent" &&
          event.kind === "assistant" &&
          event.text.includes("I will grep for tokens"),
      ),
    ).toBe(true);
    // Subagent thinking never arrives as a delta, so it has to come off the
    // message block or the panel shows a gap where the reasoning was.
    expect(
      events.some(
        (event) =>
          event.type === "agent.output" &&
          event.kind === "reasoning" &&
          event.text.includes("tokens probably live in auth"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "agent.tool" &&
          event.agentId === "toolu_agent" &&
          event.status === "completed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "agent.updated" && event.tokens === 1234,
      ),
    ).toBe(true);
  });

  it("asks the CLI to forward subagent text and to leave background agents to us", async () => {
    const { turn } = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    const init = parse().find((line) => {
      const request = line.request as Record<string, unknown> | undefined;
      return request?.subtype === "initialize";
    });
    expect(init?.request).toMatchObject({
      forwardSubagentText: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
    });
  });

  it("opens no run for a forwarded frame whose parent is not an Agent call", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_bash",
      message: { content: [{ type: "text", text: "inner text" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(events.some((event) => event.type === "agent.started")).toBe(false);
  });

  it("breaks between two forwarded messages instead of gluing them", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "Searching." }] },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "Found 3." }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    const outputs = events.flatMap((event) =>
      event.type === "agent.output" ? [event.text] : [],
    );
    expect(outputs).toEqual(["Searching.", "\n\nFound 3."]);
  });

  it("stops background subagents when the turn is cancelled", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore" },
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    const cancelling = cancelClaudeTurn("s1");
    await waitForRequest("interrupt");
    const requests = parse().flatMap((line) => {
      const request = line.request as Record<string, unknown> | undefined;
      return request?.subtype ? [request] : [];
    });
    const stopIndex = requests.findIndex((r) => r.subtype === "stop_task");
    const interruptIndex = requests.findIndex((r) => r.subtype === "interrupt");
    expect(requests[stopIndex]).toMatchObject({ task_id: "t1" });
    // The stop has to land first; an interrupt now spares background agents.
    expect(stopIndex).toBeLessThan(interruptIndex);
    // The turn is already over while the stop is still unanswered, so the
    // run reads as stopping, not stopped — Stop once claimed success blindly.
    await turn;
    const run = events.find((e) => e.type === "agent.started")!;
    expect(
      events.some(
        (e) => e.type === "agent.updated" && e.agentId === run.agentId && e.stopping,
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "agent.updated" && e.status === "stopped"),
    ).toBe(false);
    // Stop muted the stream; the verdict must still get through.
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: stopRequestId() },
    });
    await cancelling;
    expect(
      events.some(
        (e) =>
          e.type === "agent.updated" &&
          e.agentId === run.agentId &&
          e.status === "stopped",
      ),
    ).toBe(true);
  });

  it("still answers a stop asked after the turn was cancelled", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    const cancelling = cancelClaudeTurn("s1");
    await waitForRequest("interrupt");
    await turn;
    // The CLI refuses the cancel-time stop; the run goes back to plain running.
    emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: stopRequestId(),
        error: "stop_task: busy",
      },
    });
    await cancelling;
    expect(events.at(-1)).toMatchObject({
      type: "agent.updated",
      stopping: false,
    });
    // A second stop from the panel, after the turn ended, must be heard.
    const stopping = stopClaudeAgent("s1", "t1");
    await waitFor(
      () =>
        parse().filter((line) => {
          const request = line.request as Record<string, unknown> | undefined;
          return request?.subtype === "stop_task";
        }).length === 2,
      "second stop_task",
    );
    const second = parse()
      .filter((line) => {
        const request = line.request as Record<string, unknown> | undefined;
        return request?.subtype === "stop_task";
      })
      .at(-1)!.request_id as string;
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: second },
    });
    await stopping;
    expect(events.at(-1)).toMatchObject({
      type: "agent.updated",
      agentId: "toolu_agent",
      status: "stopped",
    });
    // And the CLI's own lifecycle for a run that outlived the turn is not lost.
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t2",
      tool_use_id: "toolu_agent2",
      description: "Late",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    expect(
      events.some((e) => e.type === "agent.started" && e.taskId === "t2"),
    ).toBe(true);
  });

  it("stops one subagent without interrupting the turn", async () => {
    const { turn } = await startTurn("s1");
    const stopping = stopClaudeAgent("s1", "t1");
    const stop = await waitForRequest("stop_task");
    expect(stop).toMatchObject({ subtype: "stop_task", task_id: "t1" });
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: stopRequestId() },
    });
    await stopping;
    expect(
      parse().some((line) => {
        const request = line.request as Record<string, unknown> | undefined;
        return request?.subtype === "interrupt";
      }),
    ).toBe(false);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("reports a refused stop instead of swallowing it", async () => {
    const { turn } = await startTurn("s1");
    const stopping = stopClaudeAgent("s1", "t1");
    await waitForRequest("stop_task");
    emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: stopRequestId(),
        error: "stop_task: task not found",
      },
    });
    await expect(stopping).rejects.toThrow("task not found");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("claude subagent identity", () => {
  const spawnAgentTool = (id: string, description: string, parent?: string) =>
    emit({
      type: "assistant",
      ...(parent ? { parent_tool_use_id: parent } : { session_id: "sess_1" }),
      message: {
        content: [{ type: "tool_use", id, name: "Agent", input: { description } }],
      },
    });

  it("keeps one run when background_tasks_changed beats task_started", async () => {
    const { events, turn } = await startTurn("s1");
    spawnAgentTool("toolu_agent", "Explore");
    // Measured order on the real CLI: the background list names the task a
    // frame before task_started does.
    emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1", task_type: "local_agent", description: "Explore" }],
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "",
    });
    await turn;
    const started = events.filter((event) => event.type === "agent.started");
    expect(new Set(started.map((event) => event.agentId)).size).toBe(1);
    expect(started[0]).toMatchObject({ agentId: "toolu_agent", taskId: "t1" });
    expect(
      events.some(
        (event) =>
          event.type === "agent.updated" &&
          event.agentId === "toolu_agent" &&
          event.status === "completed",
      ),
    ).toBe(true);
  });

  it("links a nested spawn to the run that made it and stops the tree leaves first", async () => {
    const { events, turn } = await startTurn("s1");
    spawnAgentTool("toolu_top", "Coordinate");
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t_top",
      tool_use_id: "toolu_top",
      description: "Coordinate",
      task_type: "local_agent",
    });
    spawnAgentTool("toolu_child", "Summarize", "toolu_top");
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t_child",
      tool_use_id: "toolu_child",
      description: "Summarize",
      task_type: "local_agent",
      spawn_depth: 2,
      is_backgrounded: true,
    });
    expect(
      events.find(
        (event) => event.type === "agent.started" && event.agentId === "toolu_child",
      ),
    ).toMatchObject({ parentId: "toolu_top" });

    const stopping = stopClaudeAgent("s1", "t_top");
    await waitForRequest("stop_task");
    const stops = () =>
      parse().flatMap((line) => {
        const request = line.request as Record<string, unknown> | undefined;
        return request?.subtype === "stop_task"
          ? [{ id: line.request_id as string, task: request.task_id as string }]
          : [];
      });
    expect(stops()[0].task).toBe("t_child");
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: stops()[0].id },
    });
    await waitFor(() => stops().length === 2, "parent stop");
    expect(stops()[1].task).toBe("t_top");
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: stops()[1].id },
    });
    await stopping;

    for (const task of ["t_child", "t_top"]) {
      emit({
        type: "system",
        subtype: "task_notification",
        task_id: task,
        status: "stopped",
        summary: "",
      });
    }
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("does not let progress rename a run, only describe what it is doing", async () => {
    const { events, turn } = await startTurn("s1");
    spawnAgentTool("toolu_agent", "Explore");
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      task_type: "local_agent",
    });
    emit({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Reading auth.ts",
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "",
    });
    await turn;
    const update = events.find(
      (event) => event.type === "agent.updated" && event.activity !== undefined,
    );
    expect(update).toMatchObject({ activity: "Reading auth.ts" });
    expect(update && "title" in update && update.title).toBeFalsy();
  });

  it("settles a run whose terminal event never came once the turn is over", async () => {
    const { events, turn } = await startTurn("s1");
    spawnAgentTool("toolu_agent", "Explore");
    // No task_started: the run exists only because its text was forwarded.
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(
      events.some(
        (event) =>
          event.type === "agent.updated" &&
          event.agentId === "toolu_agent" &&
          event.status === "completed",
      ),
    ).toBe(true);
  });
});

describe("claude subagent transcript rows", () => {
  it("keeps one row per agent: progress and the live list never add rows", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Map architecture" } },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1", task_type: "local_agent", description: "Running ls -la /repo" }],
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Map architecture",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Running find /repo -name *.ts",
      usage: { total_tokens: 5, tool_uses: 1, duration_ms: 1 },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "",
    });
    await turn;
    const rows = new Set(
      events.flatMap((event) =>
        event.type === "tool.started" && event.kind === "agent" ? [event.callId] : [],
      ),
    );
    expect([...rows]).toEqual(["toolu_agent"]);
    const titles = events.flatMap((event) =>
      (event.type === "tool.started" || event.type === "tool.updated") &&
      event.callId === "toolu_agent" &&
      event.title
        ? [event.title]
        : [],
    );
    expect(titles.every((title) => title === "Map architecture")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool.updated" &&
          event.callId === "toolu_agent" &&
          event.detail === "Running find /repo -name *.ts",
      ),
    ).toBe(true);
  });
});
