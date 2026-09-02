import type { Block, Session } from "../session";
import { applyHarnessEvent } from "./apply";
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
 * So a step's worth of queued events is cut at a character budget: the text
 * before the cut is applied now, the rest waits for the next step.
 */

/** `off` is no pacing: every delta lands whole, the moment the CLI sends it. */
export type StreamPace = "off" | "balanced" | "smooth";

/**
 * A paced mode is one formula — clear the backlog over `drainMs`, never slower
 * than `minCharsPerSecond`.
 *
 * Both are wall-clock, deliberately. Budgeting per frame assumes the frames
 * keep coming at 60Hz; when a heavy transcript pushes the app below that, a
 * per-frame budget silently reveals text at a fraction of the intended rate
 * and the reply finishes long after the agent does. Against elapsed time, a
 * dropped frame just makes the next slice bigger.
 *
 * `drainMs` is therefore also the cap on how far behind the reveal can fall,
 * in the units that matter. It is why there is no "slow" mode: bounding the
 * lag forces the reveal back to the model's own rate, so a slower pace only
 * reads as a constant offset — 175 characters a second against smooth's 188,
 * which nobody can see. Genuinely slower means trailing by half a minute.
 */
export const STREAM_PACE_PROFILES: Record<
  Exclude<StreamPace, "off">,
  { drainMs: number; minCharsPerSecond: number }
> = {
  balanced: { drainMs: 125, minCharsPerSecond: 180 },
  // Finest slices: the text grows a character or two at a time, every frame.
  smooth: { drainMs: 250, minCharsPerSecond: 60 },
};

/** One frame at 60Hz — the assumed step when no elapsed time is supplied. */
export const DRIP_FRAME_MS = 1000 / 60;

/**
 * Longest step a single call may bill for. After a stall the reveal should
 * catch up, but not by dumping the whole backlog in one paint — so this stays
 * well under the shortest `drainMs`, which bounds a catch-up to a fraction of
 * whatever is queued.
 */
const MAX_STEP_MS = 100;

export const STREAM_PACE_DEFAULT: StreamPace = "smooth";

export function isStreamPace(value: unknown): value is StreamPace {
  return value === "off" || value === "balanced" || value === "smooth";
}

type TextDelta = Extract<
  HarnessEvent,
  { type: "message.delta" | "reasoning.delta" }
>;

function isTextDelta(event: HarnessEvent): event is TextDelta {
  return event.type === "message.delta" || event.type === "reasoning.delta";
}

function drainBudget(
  events: HarnessEvent[],
  pace: Exclude<StreamPace, "off">,
  elapsedMs: number,
): number {
  const { drainMs, minCharsPerSecond } = STREAM_PACE_PROFILES[pace];
  const step = Math.min(Math.max(elapsedMs, 1), MAX_STEP_MS);
  let pending = 0;
  for (const event of events) {
    if (isTextDelta(event)) pending += event.text.length;
  }
  // Rounding up a product of floats would turn an exact 16 into 17.
  const ceil = (value: number) => Math.ceil(value - 1e-9);
  return Math.max(
    ceil((minCharsPerSecond * step) / 1000),
    ceil((pending * step) / drainMs),
  );
}

function lastBlock(session: Session): Block | undefined {
  return session.blocks[session.blocks.length - 1];
}

function withLastBlockText(session: Session, text: string): Session {
  const blocks = session.blocks.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], text };
  return { ...session, blocks };
}

/**
 * Apply one session's queued events up to this step's character budget and
 * return what is still waiting. Order is preserved: a tool call or a turn end
 * queued behind text stays behind it, so nothing overtakes the text it
 * followed.
 *
 * A delta is never sliced before it is merged. The whole delta goes through
 * `applyHarnessEvent`, whose snapshot-versus-token join needs the full text to
 * decide; only the merged result is cut, and the tail is re-queued `verbatim`.
 * Slicing first would hand the join fragments it misreads — a slice equal to
 * the block so far, say, is dropped as a repeated snapshot.
 */
export function dripHarnessEvents(
  session: Session,
  events: HarnessEvent[],
  pace: StreamPace = STREAM_PACE_DEFAULT,
  elapsedMs: number = DRIP_FRAME_MS,
): { session: Session; pending: HarnessEvent[] } {
  if (pace === "off") {
    return { session: events.reduce(applyHarnessEvent, session), pending: [] };
  }
  let budget = drainBudget(events, pace, elapsedMs);
  let current = session;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isTextDelta(event)) {
      current = applyHarnessEvent(current, event);
      continue;
    }
    if (budget <= 0) return { session: current, pending: events.slice(index) };

    const before = lastBlock(current);
    const next = applyHarnessEvent(current, event);
    const after = lastBlock(next);
    if (!after) {
      current = next;
      continue;
    }
    // The join only ever extends the block, so what it added is a suffix.
    const base = before && after.id === before.id ? before.text.length : 0;
    const added = after.text.length - base;
    if (added <= budget) {
      current = next;
      budget -= added;
      continue;
    }
    const cut = base + budget;
    return {
      session: withLastBlockText(next, after.text.slice(0, cut)),
      pending: [
        { ...event, text: after.text.slice(cut), verbatim: true },
        ...events.slice(index + 1),
      ],
    };
  }

  return { session: current, pending: [] };
}
