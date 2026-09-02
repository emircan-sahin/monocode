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
 * before the cut is applied now, the rest waits for the next frame. The budget
 * is whatever drains the current backlog in DRAIN_FRAMES, so the reveal always
 * catches up within a fixed span and never falls behind the model's own pace.
 */
const DRAIN_FRAMES = 8;
const MIN_DRAIN_CHARS = 3;

function deltaText(event: HarnessEvent): string | null {
  if (event.type === "message.delta" || event.type === "reasoning.delta") {
    return event.text;
  }
  return null;
}

function withText(event: HarnessEvent, text: string): HarnessEvent {
  return { ...event, text } as HarnessEvent;
}

function drainBudget(events: HarnessEvent[]): number {
  let pending = 0;
  for (const event of events) pending += deltaText(event)?.length ?? 0;
  return Math.max(MIN_DRAIN_CHARS, Math.ceil(pending / DRAIN_FRAMES));
}

/**
 * Split one session's queued events into what to apply this frame and what to
 * hold. Order is preserved on both sides: a tool call or a turn end queued
 * behind text stays behind it, so nothing overtakes the text it followed.
 */
export function dripHarnessEvents(events: HarnessEvent[]): {
  applied: HarnessEvent[];
  pending: HarnessEvent[];
} {
  let budget = drainBudget(events);
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
