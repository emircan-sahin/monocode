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
  const paces: StreamPace[] = ["off", "balanced", "smooth"];

  it("defaults to the smooth pace", () => {
    const body = "x".repeat(64);
    expect(dripHarnessEvents([delta(body)])).toEqual(
      dripHarnessEvents([delta(body)], "smooth"),
    );
    expect(STREAM_PACE_DEFAULT).toBe("smooth");
  });

  it("applies a burst whole when pacing is off", () => {
    const burst = [delta("x".repeat(4000)), delta("y".repeat(4000))];
    expect(dripHarnessEvents(burst, "off")).toEqual({
      applied: burst,
      pending: [],
    });
  });

  it("slices one burst more finely on smooth than on balanced", () => {
    const burst = [delta("x".repeat(80))];
    const chars = (pace: StreamPace) =>
      (dripHarnessEvents(burst, pace).applied[0] as { text: string }).text
        .length;
    expect(chars("smooth")).toBeLessThan(chars("balanced"));
    expect(chars("off")).toBe(80);
  });

  it("drains every pace fully, smooth taking the most frames", () => {
    const body = "x".repeat(600);
    const frames = paces.map((pace) => {
      const drained = drain([delta(body)], pace);
      expect(drained.text).toBe(body);
      return drained.frames;
    });
    const [off, balanced, smooth] = frames;
    expect(off).toBe(1);
    expect(smooth).toBeGreaterThan(balanced);
  });

  it("keeps a long answer from stranding on the paced modes", () => {
    for (const pace of ["balanced", "smooth"] as StreamPace[]) {
      const drained = drain([delta("x".repeat(12000))], pace);
      expect(drained.text.length).toBe(12000);
      expect(drained.frames).toBeLessThan(200);
    }
  });

  it("recognises stored pace values and rejects anything else", () => {
    for (const pace of paces) expect(isStreamPace(pace)).toBe(true);
    // "slow" was offered briefly; a stored one falls back to the default.
    expect(isStreamPace("slow")).toBe(false);
    expect(isStreamPace(null)).toBe(false);
  });
});
