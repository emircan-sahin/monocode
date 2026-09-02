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

export type StreamPace = "slow" | "balanced" | "smooth";

/**
 * A pace is one formula — `pending / drainFrames`, floored at `minChars`.
 *
 * `minChars` is the unhurried speed, the one in effect while the backlog is
 * small. Text arrives at roughly 3 characters a frame, so `balanced` keeps
 * step with the model. `drainFrames` is the ceiling above that floor: it caps
 * how far behind the reveal can fall, which is what lets `slow` stay slow on
 * ordinary output without stranding the tail of a long answer.
 */
export const STREAM_PACE_PROFILES: Record<
  StreamPace,
  { drainFrames: number; minChars: number }
> = {
  // Deliberately behind the model, at about 120 characters a second — reading
  // pace. A turn seals only once the queue empties, so this trails the model
  // instead of snapping the remainder in at the end.
  slow: { drainFrames: 60, minChars: 2 },
  balanced: { drainFrames: 8, minChars: 3 },
  // Finest slices: the text grows a character or two at a time.
  smooth: { drainFrames: 16, minChars: 1 },
};

export const STREAM_PACE_DEFAULT: StreamPace = "smooth";

export function isStreamPace(value: unknown): value is StreamPace {
  return value === "slow" || value === "balanced" || value === "smooth";
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

function drainBudget(events: HarnessEvent[], pace: StreamPace): number {
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
