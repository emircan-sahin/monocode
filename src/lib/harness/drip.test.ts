import { describe, expect, it } from "vitest";
import type { Session } from "../session";
import {
  DRIP_FRAME_MS,
  dripHarnessEvents,
  isStreamPace,
  STREAM_PACE_DEFAULT,
  type QueuedHarnessEvent,
  type StreamPace,
} from "./drip";
import type { HarnessEvent } from "./types";

const delta = (text: string): HarnessEvent => ({ type: "message.delta", text });

function session(text?: string): Session {
  const blocks =
    text === undefined
      ? []
      : [{ id: "a", role: "assistant", text, streaming: true }];
  return { id: "s", blocks } as unknown as Session;
}

/** Text of the block being written. */
function tail(current: Session): string {
  return current.blocks[current.blocks.length - 1]?.text ?? "";
}

function drain(
  items: QueuedHarnessEvent[],
  pace: StreamPace = "balanced",
  elapsedMs = DRIP_FRAME_MS,
  start = session(),
): { steps: number; text: string; session: Session } {
  let current = start;
  let pending = items;
  let steps = 0;
  while (pending.length) {
    const step = dripHarnessEvents(current, pending, pace, elapsedMs);
    current = step.session;
    pending = step.pending;
    steps += 1;
    if (steps > 4000) throw new Error("drip never drained");
  }
  return { steps, text: tail(current), session: current };
}

describe("dripHarnessEvents", () => {
  it("reveals a big delta over several steps without losing text", () => {
    const body = "x".repeat(120);
    const first = dripHarnessEvents(session(), [delta(body)], "balanced");
    expect(tail(first.session)).toBe("x".repeat(16));
    expect(first.pending).toEqual([
      { type: "drip.tail", role: "assistant", text: "x".repeat(104) },
    ]);
    const drained = drain([delta(body)]);
    expect(drained.text).toBe(body);
    expect(drained.steps).toBeGreaterThan(10);
    expect(drained.steps).toBeLessThan(30);
  });

  it("scales the budget so a large backlog still clears in a fixed span", () => {
    const body = "z".repeat(2400);
    const first = dripHarnessEvents(session(), [delta(body)], "balanced");
    expect(tail(first.session)).toBe("z".repeat(320));
    expect(drain([delta(body)]).text).toBe(body);
  });

  it("passes short text through in one step", () => {
    const step = dripHarnessEvents(session(), [delta("hi")], "balanced");
    expect(tail(step.session)).toBe("hi");
    expect(step.pending).toEqual([]);
  });

  it("holds later events behind text that has not been revealed", () => {
    const tool: HarnessEvent = {
      type: "tool.started",
      callId: "1",
      title: "Read",
    };
    const step = dripHarnessEvents(
      session(),
      [delta("y".repeat(64)), tool],
      "balanced",
    );
    expect(tail(step.session)).toBe("y".repeat(9));
    expect(step.session.blocks).toHaveLength(1);
    expect(step.pending).toEqual([
      { type: "drip.tail", role: "assistant", text: "y".repeat(55) },
      tool,
    ]);
  });

  it("applies non-text events immediately when no text is queued", () => {
    const events: HarnessEvent[] = [
      { type: "session.started" },
      { type: "message.completed" },
    ];
    const step = dripHarnessEvents(session("done"), events);
    expect(step.pending).toEqual([]);
    expect(step.session.blocks[0].streaming).toBe(false);
  });

  it("keeps reasoning and message text in order across steps", () => {
    const events: HarnessEvent[] = [
      { type: "reasoning.delta", text: "a".repeat(48) },
      delta("b".repeat(48)),
    ];
    const drained = drain(events);
    expect(drained.session.blocks.map((block) => block.text)).toEqual([
      "a".repeat(48),
      "b".repeat(48),
    ]);
  });

  it("merges a delta whole before cutting it, so the join never sees a fragment", () => {
    // Sliced first, "--" against a block reading "--" would be dropped as a
    // repeated snapshot and "Hel" against "Hello" pasted on as a new token.
    expect(drain([delta("----")], "smooth", 1).text).toBe("----");
    expect(
      drain([delta("Hello world")], "smooth", 1, session("Hello")).text,
    ).toBe("Hello world");
    expect(drain([delta("Hello"), delta("Hello")], "smooth", 1).text).toBe(
      "Hello",
    );
  });

  it("opens a new block for a tail whose block is gone", () => {
    const steered = {
      ...session("the fun"),
      blocks: [
        { id: "a", role: "assistant", text: "the fun", streaming: true },
        { id: "u", role: "user", text: "wait" },
      ],
    } as unknown as Session;
    const step = dripHarnessEvents(
      steered,
      [{ type: "drip.tail", role: "assistant", text: "ction" }],
      "off",
    );
    expect(step.session.blocks.map((block) => block.text)).toEqual([
      "the fun",
      "wait",
      "ction",
    ]);
  });
});

describe("stream pace", () => {
  const paces: StreamPace[] = ["off", "balanced", "smooth"];

  it("defaults to the smooth pace", () => {
    const body = "x".repeat(64);
    const implicit = dripHarnessEvents(session(), [delta(body)]);
    const explicit = dripHarnessEvents(session(), [delta(body)], "smooth");
    expect(tail(implicit.session)).toBe(tail(explicit.session));
    expect(implicit.pending).toEqual(explicit.pending);
    expect(STREAM_PACE_DEFAULT).toBe("smooth");
  });

  it("applies a burst whole when pacing is off", () => {
    const burst = [delta("x".repeat(4000)), delta("y".repeat(4000))];
    const step = dripHarnessEvents(session(), burst, "off");
    expect(tail(step.session)).toHaveLength(8000);
    expect(step.pending).toEqual([]);
  });

  it("slices one burst more finely on smooth than on balanced", () => {
    const burst = [delta("x".repeat(80))];
    const chars = (pace: StreamPace) =>
      tail(dripHarnessEvents(session(), burst, pace).session).length;
    expect(chars("smooth")).toBeLessThan(chars("balanced"));
    expect(chars("off")).toBe(80);
  });

  it("drains every pace fully, smooth taking the most steps", () => {
    const body = "x".repeat(600);
    const steps = paces.map((pace) => {
      const drained = drain([delta(body)], pace);
      expect(drained.text).toBe(body);
      return drained.steps;
    });
    const [off, balanced, smooth] = steps;
    expect(off).toBe(1);
    expect(smooth).toBeGreaterThan(balanced);
  });

  it("reveals the same amount per unit time whatever the frame rate", () => {
    // Half the frames, twice the step: the reveal must not halve with them.
    const body = "x".repeat(600);
    const at60 = drain([delta(body)], "smooth");
    const at20 = drain([delta(body)], "smooth", 1000 / 20);
    expect(at20.text).toBe(body);
    expect(at20.steps).toBeLessThan(at60.steps / 2);
  });

  it("caps the catch-up after a stall instead of dumping the backlog", () => {
    const step = dripHarnessEvents(
      session(),
      [delta("x".repeat(5000))],
      "smooth",
      10_000,
    );
    expect(step.pending.length).toBeGreaterThan(0);
  });

  it("keeps a long answer from stranding on the paced modes", () => {
    for (const pace of ["balanced", "smooth"] as StreamPace[]) {
      const drained = drain([delta("x".repeat(12000))], pace);
      expect(drained.text).toHaveLength(12000);
      expect(drained.steps).toBeLessThan(200);
    }
  });

  it("recognises stored pace values and rejects anything else", () => {
    for (const pace of paces) expect(isStreamPace(pace)).toBe(true);
    // "slow" was offered briefly; a stored one falls back to the default.
    expect(isStreamPace("slow")).toBe(false);
    expect(isStreamPace(null)).toBe(false);
  });
});
