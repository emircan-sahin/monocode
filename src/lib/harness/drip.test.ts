import { describe, expect, it } from "vitest";
import {
  dripHarnessEvents,
  isStreamPace,
  STREAM_PACE_DEFAULT,
  type StreamPace,
} from "./drip";
import type { HarnessEvent } from "./types";

const delta = (text: string): HarnessEvent => ({ type: "message.delta", text });

function drain(
  events: HarnessEvent[],
  pace: StreamPace = "balanced",
): { frames: number; text: string } {
  let pending = events;
  let text = "";
  let frames = 0;
  while (pending.length) {
    const step = dripHarnessEvents(pending, pace);
    for (const event of step.applied) {
      if (event.type === "message.delta") text += event.text;
    }
    pending = step.pending;
    frames += 1;
    if (frames > 4000) throw new Error("drip never drained");
  }
  return { frames, text };
}

describe("dripHarnessEvents", () => {
  it("reveals a big delta over several frames without losing text", () => {
    const body = "x".repeat(120);
    const first = dripHarnessEvents([delta(body)], "balanced");
    expect(first.applied).toEqual([delta("x".repeat(15))]);
    const drained = drain([delta(body)]);
    expect(drained.text).toBe(body);
    expect(drained.frames).toBeGreaterThan(10);
    expect(drained.frames).toBeLessThan(30);
  });

  it("scales the budget so a large backlog still clears in a fixed span", () => {
    const body = "z".repeat(2400);
    const first = dripHarnessEvents([delta(body)], "balanced");
    expect(first.applied).toEqual([delta("z".repeat(300))]);
    expect(drain([delta(body)]).text).toBe(body);
  });

  it("passes short text through in one frame", () => {
    const step = dripHarnessEvents([delta("hi")], "balanced");
    expect(step.applied).toEqual([delta("hi")]);
    expect(step.pending).toEqual([]);
  });

  it("holds later events behind text that has not been revealed", () => {
    const tool: HarnessEvent = {
      type: "tool.started",
      callId: "1",
      title: "Read",
    };
    const step = dripHarnessEvents([delta("y".repeat(64)), tool], "balanced");
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
      const step = dripHarnessEvents(pending, "balanced");
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

describe("stream pace", () => {
  const paces: StreamPace[] = ["slow", "balanced", "smooth"];

  it("defaults to the smooth pace", () => {
    const body = "x".repeat(64);
    expect(dripHarnessEvents([delta(body)])).toEqual(
      dripHarnessEvents([delta(body)], "smooth"),
    );
    expect(STREAM_PACE_DEFAULT).toBe("smooth");
  });

  it("reveals one burst most gradually on slow and most coarsely on balanced", () => {
    const burst = [delta("x".repeat(80))];
    const perFrame = paces.map(
      (pace) =>
        (dripHarnessEvents(burst, pace).applied[0] as { text: string }).text
          .length,
    );
    const [slow, balanced, smooth] = perFrame;
    expect(slow).toBeLessThan(smooth);
    expect(smooth).toBeLessThan(balanced);
  });

  it("drains every pace fully, slow taking the longest", () => {
    const body = "x".repeat(600);
    const frames = paces.map((pace) => {
      const drained = drain([delta(body)], pace);
      expect(drained.text).toBe(body);
      return drained.frames;
    });
    const [slow, balanced, smooth] = frames;
    expect(slow).toBeGreaterThan(smooth);
    expect(smooth).toBeGreaterThan(balanced);
  });

  it("bounds how far the slow pace falls behind a long answer", () => {
    // 12k characters would be 100 seconds at a fixed 120 chars/sec; the drain
    // horizon has to speed up instead of stranding the reader.
    const drained = drain([delta("x".repeat(12000))], "slow");
    expect(drained.frames).toBeLessThan(700);
  });

  it("recognises stored pace values and rejects anything else", () => {
    for (const pace of paces) expect(isStreamPace(pace)).toBe(true);
    expect(isStreamPace("fast")).toBe(false);
    expect(isStreamPace(null)).toBe(false);
  });
});
