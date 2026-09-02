import type { HarnessEvent } from "./types";

/**
 * Paced reveal for streamed body text.
 *
 * Measured on Claude's CLI in the mode we spawn it (`--output-format
 * stream-json --include-partial-messages`): text arrives as ~80-character
 * `text_delta` events about 2.4 times a second, not per token. Applying each
 * delta whole therefore drops a whole paragraph into the transcript at once,
 * which is what reads as a stuttering stream.
 *
 * So a frame's worth of queued events is cut at a character budget: the text
 * before the cut is applied now, the rest waits for the next frame.
 */

/** `off` is no pacing: every delta lands whole, the moment the CLI sends it. */
export type StreamPace = "off" | "balanced" | "smooth";

/**
 * A paced mode is one formula — `pending / drainFrames`, floored at `minChars`.
 *
 * `minChars` is the speed while the backlog is small; `drainFrames` caps how
 * far behind the reveal may fall once it grows. That cap is also why there is
 * no "slow" mode here: bounding the lag forces the reveal back to the model's
 * own rate, so a slower pace only ever reads as a constant offset — measured
 * at 175 characters a second against smooth's 188, which nobody can see.
 * Genuinely slower means trailing a long answer by half a minute.
 */
export const STREAM_PACE_PROFILES: Record<
  Exclude<StreamPace, "off">,
  { drainFrames: number; minChars: number }
> = {
  balanced: { drainFrames: 8, minChars: 3 },
  // Finest slices: the text grows a character or two at a time, every frame.
  smooth: { drainFrames: 16, minChars: 1 },
};

export const STREAM_PACE_DEFAULT: StreamPace = "smooth";

export function isStreamPace(value: unknown): value is StreamPace {
  return value === "off" || value === "balanced" || value === "smooth";
}

function deltaText(event: HarnessEvent): string | null {
  if (event.type === "message.delta" || event.type === "reasoning.delta") {
    return event.text;
  }
  return null;
}

function withText(event: HarnessEvent, text: string): HarnessEvent {
  return { ...event, text } as HarnessEvent;
}

function drainBudget(
  events: HarnessEvent[],
  pace: Exclude<StreamPace, "off">,
): number {
  const { drainFrames, minChars } = STREAM_PACE_PROFILES[pace];
  let pending = 0;
  for (const event of events) pending += deltaText(event)?.length ?? 0;
  return Math.max(minChars, Math.ceil(pending / drainFrames));
}

/**
 * Split one session's queued events into what to apply this frame and what to
 * hold. Order is preserved on both sides: a tool call or a turn end queued
 * behind text stays behind it, so nothing overtakes the text it followed.
 */
export function dripHarnessEvents(
  events: HarnessEvent[],
  pace: StreamPace = STREAM_PACE_DEFAULT,
): { applied: HarnessEvent[]; pending: HarnessEvent[] } {
  if (pace === "off") return { applied: events, pending: [] };
  let budget = drainBudget(events, pace);
  const applied: HarnessEvent[] = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const text = deltaText(event);
    if (text === null) {
      applied.push(event);
      continue;
    }
    if (text.length <= budget) {
      applied.push(event);
      budget -= text.length;
      continue;
    }
    if (budget > 0) applied.push(withText(event, text.slice(0, budget)));
    return {
      applied,
      pending: [
        withText(event, text.slice(budget)),
        ...events.slice(index + 1),
      ],
    };
  }

  return { applied, pending: [] };
}
