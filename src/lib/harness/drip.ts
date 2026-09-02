import type { Block, Session } from "../session";
import { applyHarnessEvent } from "./apply";
import type { HarnessEvent } from "./types";

/**
 * Paced reveal for streamed body text. Measured on Claude's CLI in the mode
 * we spawn it: text arrives as ~80-character deltas 2.4 times a second, so
 * applying each whole drops a paragraph in one jump. Each step applies a
 * character budget's worth and holds the rest.
 */

/**
 * `off` is no pacing: every delta lands whole, the moment the CLI sends it —
 * what the transcript did before, and the default, so smoothing is opt-in.
 */
export type StreamPace = "off" | "balanced" | "smooth";

/**
 * Wall-clock on purpose: a per-frame budget assumes 60Hz, and the frames drop
 * under exactly this load, which stretched the reveal past the reply. There is
 * no slow mode because bounding the lag pins the rate to the model's — a
 * "slow" profile measured 175 chars/s against smooth's 188, invisible.
 */
export const STREAM_PACE_PROFILES: Record<
  Exclude<StreamPace, "off">,
  { drainMs: number; minCharsPerSecond: number }
> = {
  balanced: { drainMs: 125, minCharsPerSecond: 180 },
  smooth: { drainMs: 250, minCharsPerSecond: 60 },
};

/** One frame at 60Hz — the assumed step when no elapsed time is supplied. */
export const DRIP_FRAME_MS = 1000 / 60;

// Under the shortest drainMs, so catching up after a stall lands a fraction
// of the backlog per step instead of the whole thing in one paint.
const MAX_STEP_MS = 100;

export const STREAM_PACE_DEFAULT: StreamPace = "off";

export function isStreamPace(value: unknown): value is StreamPace {
  return value === "off" || value === "balanced" || value === "smooth";
}

/**
 * The part of a delta a step could not afford. Already merged into the block
 * by `applyHarnessEvent`, so it appends as-is rather than going through the
 * snapshot-versus-token join again, which misreads fragments.
 */
type DripTail = {
  type: "drip.tail";
  role: "assistant" | "reasoning";
  text: string;
};

export type QueuedHarnessEvent = HarnessEvent | DripTail;

function textOf(item: QueuedHarnessEvent): string | null {
  return item.type === "message.delta" ||
    item.type === "reasoning.delta" ||
    item.type === "drip.tail"
    ? item.text
    : null;
}

function lastBlock(session: Session): Block | undefined {
  return session.blocks[session.blocks.length - 1];
}

function withLastBlockText(session: Session, text: string): Session {
  const blocks = session.blocks.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], text };
  return { ...session, blocks };
}

function applyQueued(session: Session, item: QueuedHarnessEvent): Session {
  if (item.type !== "drip.tail") return applyHarnessEvent(session, item);
  const last = lastBlock(session);
  if (last?.role === item.role) {
    return withLastBlockText(session, last.text + item.text);
  }
  // The block it was cut from is gone (a steer landed between steps); let the
  // reducer open a new one the way it would for any delta.
  const type = item.role === "assistant" ? "message.delta" : "reasoning.delta";
  return applyHarnessEvent(session, { type, text: item.text });
}

function drainBudget(
  items: QueuedHarnessEvent[],
  pace: Exclude<StreamPace, "off">,
  elapsedMs: number,
): number {
  const { drainMs, minCharsPerSecond } = STREAM_PACE_PROFILES[pace];
  const step = Math.min(Math.max(elapsedMs, 1), MAX_STEP_MS);
  let pending = 0;
  for (const item of items) pending += textOf(item)?.length ?? 0;
  // Rounding up a product of floats would turn an exact 16 into 17.
  const ceil = (value: number) => Math.ceil(value - 1e-9);
  return Math.max(
    ceil((minCharsPerSecond * step) / 1000),
    ceil((pending * step) / drainMs),
  );
}

/**
 * Apply a session's queue up to this step's budget; whatever is left keeps its
 * order behind the cut, so a tool call never overtakes the text before it.
 */
export function dripHarnessEvents(
  session: Session,
  items: QueuedHarnessEvent[],
  pace: StreamPace = STREAM_PACE_DEFAULT,
  elapsedMs: number = DRIP_FRAME_MS,
): { session: Session; pending: QueuedHarnessEvent[] } {
  if (pace === "off") {
    return { session: items.reduce(applyQueued, session), pending: [] };
  }
  let budget = drainBudget(items, pace, elapsedMs);
  let current = session;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (textOf(item) === null) {
      current = applyQueued(current, item);
      continue;
    }
    if (budget <= 0) return { session: current, pending: items.slice(index) };

    const before = lastBlock(current);
    const next = applyQueued(current, item);
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
        {
          type: "drip.tail",
          role: after.role === "reasoning" ? "reasoning" : "assistant",
          text: after.text.slice(cut),
        },
        ...items.slice(index + 1),
      ],
    };
  }

  return { session: current, pending: [] };
}
