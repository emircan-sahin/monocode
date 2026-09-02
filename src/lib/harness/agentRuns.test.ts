import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "./apply";
import { newSession, type Session } from "../session";

function base(): Session {
  return newSession("claude");
}

function run(session: Session, ...events: Parameters<typeof applyHarnessEvent>[1][]) {
  return events.reduce(applyHarnessEvent, session);
}

describe("agent runs", () => {
  it("keeps a subagent's text out of the main transcript", () => {
    const session = run(
      base(),
      { type: "agent.started", agentId: "a1", title: "Explore" },
      { type: "agent.output", agentId: "a1", kind: "assistant", text: "hello" },
    );
    expect(session.blocks).toHaveLength(0);
    expect(session.agents?.[0].blocks[0].text).toBe("hello");
  });

  it("joins streamed deltas into one block", () => {
    const session = run(
      base(),
      { type: "agent.started", agentId: "a1", title: "Explore" },
      { type: "agent.output", agentId: "a1", kind: "assistant", text: "one " },
      { type: "agent.output", agentId: "a1", kind: "assistant", text: "two" },
    );
    expect(session.agents?.[0].blocks).toHaveLength(1);
    expect(session.agents?.[0].blocks[0].text).toBe("one two");
  });

  it("upserts a tool call by id instead of stacking rows", () => {
    const session = run(
      base(),
      { type: "agent.started", agentId: "a1", title: "Explore" },
      {
        type: "agent.tool",
        agentId: "a1",
        callId: "t1",
        title: "Grep token",
        status: "pending",
      },
      {
        type: "agent.tool",
        agentId: "a1",
        callId: "t1",
        title: "Grep token",
        status: "completed",
        detail: "3 matches",
      },
    );
    const blocks = session.agents?.[0].blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.status).toBe("completed");
    expect(blocks[0].streaming).toBe(false);
  });

  it("settles a finished run and seals whatever it was streaming", () => {
    const session = run(
      base(),
      { type: "agent.started", agentId: "a1", title: "Explore" },
      { type: "agent.output", agentId: "a1", kind: "assistant", text: "hi" },
      {
        type: "agent.updated",
        agentId: "a1",
        status: "completed",
        summary: "Found it",
        tokens: 900,
      },
    );
    const agent = session.agents?.[0];
    expect(agent?.status).toBe("completed");
    expect(agent?.summary).toBe("Found it");
    expect(agent?.tokens).toBe(900);
    expect(agent?.endedAt).toBeGreaterThan(0);
    expect(agent?.blocks.every((block) => !block.streaming)).toBe(true);
  });

  it("ages out finished runs before live ones", () => {
    let session = base();
    for (let i = 0; i < 60; i++) {
      session = run(session, {
        type: "agent.started",
        agentId: `a${i}`,
        title: `Run ${i}`,
      });
      // Every run but the first two settles, so the cap has settled runs to
      // drop and never has to touch the two that are still going.
      if (i > 1) {
        session = run(session, {
          type: "agent.updated",
          agentId: `a${i}`,
          status: "completed",
        });
      }
    }
    expect(session.agents).toHaveLength(50);
    expect(session.agents?.map((agent) => agent.id)).toContain("a0");
    expect(session.agents?.map((agent) => agent.id)).toContain("a1");
    expect(session.agents?.map((agent) => agent.id)).toContain("a59");
  });

  it("ignores updates for a run it never saw start", () => {
    const session = applyHarnessEvent(base(), {
      type: "agent.updated",
      agentId: "ghost",
      status: "completed",
    });
    expect(session.agents).toBeUndefined();
  });

  it("re-announcing a run patches its header without losing the transcript", () => {
    const session = run(
      base(),
      { type: "agent.started", agentId: "a1", title: "Subagent" },
      { type: "agent.output", agentId: "a1", kind: "assistant", text: "hi" },
      {
        type: "agent.started",
        agentId: "a1",
        title: "Explore the auth module",
        taskId: "t1",
        agentType: "explore",
        depth: 1,
      },
    );
    const agent = session.agents?.[0];
    expect(session.agents).toHaveLength(1);
    expect(agent?.title).toBe("Explore the auth module");
    expect(agent?.taskId).toBe("t1");
    expect(agent?.agentType).toBe("explore");
    expect(agent?.blocks).toHaveLength(1);
  });

  it("flags a run as stopping until the harness settles it", () => {
    let session = applyHarnessEvent(base(), {
      type: "agent.started",
      agentId: "a1",
      title: "Explore",
    });
    session = applyHarnessEvent(session, {
      type: "agent.updated",
      agentId: "a1",
      stopping: true,
    });
    expect(session.agents?.[0]).toMatchObject({ status: "running", stopping: true });
    session = applyHarnessEvent(session, {
      type: "agent.updated",
      agentId: "a1",
      status: "stopped",
    });
    expect(session.agents?.[0].status).toBe("stopped");
    expect(session.agents?.[0].stopping).toBeUndefined();
  });
});
