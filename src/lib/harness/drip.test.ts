import { describe, expect, it } from "vitest";
import { dripHarnessEvents } from "./drip";
import type { HarnessEvent } from "./types";

const delta = (text: string): HarnessEvent => ({ type: "message.delta", text });

function drain(events: HarnessEvent[]): { frames: number; text: string } {
  let pending = events;
  let text = "";
  let frames = 0;
  while (pending.length) {
    const step = dripHarnessEvents(pending);
    for (const event of step.applied) {
      if (event.type === "message.delta") text += event.text;
    }
    pending = step.pending;
    frames += 1;
    if (frames > 200) throw new Error("drip never drained");
  }
  return { frames, text };
}

describe("dripHarnessEvents", () => {
  it("reveals a big delta over several frames without losing text", () => {
    const body = "x".repeat(120);
    const first = dripHarnessEvents([delta(body)]);
    expect(first.applied).toEqual([delta("x".repeat(15))]);
    const drained = drain([delta(body)]);
    expect(drained.text).toBe(body);
    expect(drained.frames).toBeGreaterThan(10);
    expect(drained.frames).toBeLessThan(30);
  });

  it("scales the budget so a large backlog still clears in a fixed span", () => {
    const body = "z".repeat(2400);
    const first = dripHarnessEvents([delta(body)]);
    expect(first.applied).toEqual([delta("z".repeat(300))]);
    expect(drain([delta(body)]).text).toBe(body);
  });

  it("passes short text through in one frame", () => {
    const step = dripHarnessEvents([delta("hi")]);
    expect(step.applied).toEqual([delta("hi")]);
    expect(step.pending).toEqual([]);
  });

  it("holds later events behind text that has not been revealed", () => {
    const tool: HarnessEvent = {
      type: "tool.started",
      callId: "1",
      title: "Read",
    };
    const step = dripHarnessEvents([delta("y".repeat(64)), tool]);
    expect(step.applied).toEqual([delta("y".repeat(8))]);
    expect(step.pending).toEqual([delta("y".repeat(56)), tool]);
  });

  it("applies non-text events immediately when no text is queued", () => {
    const events: HarnessEvent[] = [
      { type: "session.started" },
      { type: "message.completed" },
    ];
    expect(dripHarnessEvents(events)).toEqual({ applied: events, pending: [] });
  });

  it("keeps reasoning and message text in order across frames", () => {
    const events: HarnessEvent[] = [
      { type: "reasoning.delta", text: "a".repeat(48) },
      delta("b".repeat(48)),
    ];
    let pending = events;
    const seen: string[] = [];
    while (pending.length) {
      const step = dripHarnessEvents(pending);
      for (const event of step.applied) {
        if (
          event.type === "reasoning.delta" ||
          event.type === "message.delta"
        ) {
          seen.push(event.text);
        }
      }
      pending = step.pending;
    }
    expect(seen.join("")).toBe("a".repeat(48) + "b".repeat(48));
  });
});
