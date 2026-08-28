import { asRecord } from "./harness/codexProtocol";

export type RateLimitProvider = "claude" | "codex";

export type RateLimitStatus =
  "idle" | "fetching" | "ok" | "error" | "unavailable";

export type RateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number;
  /** Window duration in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number;
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null;
};

export type ProviderRateLimits = {
  provider: RateLimitProvider;
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  updatedAt: number;
  error: string | null;
  status: RateLimitStatus;
  /** Floor before the next attempt when the provider told us to back off. */
  backoffMs?: number;
};

export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;

/**
 * Timer granularity, not the request rate: every fetch still has to clear the
 * per-provider floor below. The old 15-minute timer beat against the 5-minute
 * floor, so a snapshot could sit unrefreshed for a quarter hour.
 */
export const RATE_LIMIT_POLL_MS = 60 * 1000;
/**
 * Claude's usage endpoint 429s hard at 30-60s polling and does not send
 * Retry-After, so 5 minutes is the community-safe floor. Do not lower it.
 */
export const RATE_LIMIT_MIN_REFETCH_MS = 5 * 60 * 1000;
/** A Codex read spawns `codex app-server`, so it gets the same slow cadence. */
export const CODEX_MIN_REFETCH_MS = 5 * 60 * 1000;
/**
 * Turn ends may cut ahead of the steady floor, but every fetch resets the
 * clock, so this doubles as the ceiling on request rate: 30 an hour in a
 * session of back-to-back turns, half what the endpoint throttles at.
 */
export const TURN_MIN_REFETCH_MS = 2 * 60 * 1000;
/** A provider that reported "not connected" is retried this rarely, not never. */
export const RATE_LIMIT_UNAVAILABLE_RETRY_MS = 15 * 60 * 1000;
/** Once throttled the endpoint stays throttled, so stop feeding it. */
export const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

export function minRefetchMs(provider: RateLimitProvider): number {
  return provider === "codex" ? CODEX_MIN_REFETCH_MS : RATE_LIMIT_MIN_REFETCH_MS;
}

export function isRateLimitSnapshotStale(
  limits: ProviderRateLimits | null | undefined,
  now: number,
  minAgeMs?: number,
): boolean {
  if (!limits || limits.status === "idle") return true;
  // Signing in after launch has to recover on its own, but a probe that costs a
  // process spawn should not retry on the normal cadence.
  if (limits.status === "unavailable") {
    return now - limits.updatedAt >= RATE_LIMIT_UNAVAILABLE_RETRY_MS;
  }
  if (limits.updatedAt <= 0) return true;
  // A backoff outranks the caller's floor: a turn ending is not a reason to
  // poke an endpoint that just throttled us.
  const floor =
    limits.backoffMs ?? minAgeMs ?? minRefetchMs(limits.provider);
  return now - limits.updatedAt >= floor;
}

export function shouldFetchProvider(
  limits: ProviderRateLimits,
  input: {
    force?: boolean;
    visible: boolean;
    now?: number;
    minAgeMs?: number;
  },
): boolean {
  if (input.force) return true;
  if (!input.visible) return false;
  return isRateLimitSnapshotStale(limits, input.now ?? Date.now(), input.minAgeMs);
}

export function shouldFetchRateLimits(input: {
  force?: boolean;
  visible: boolean;
  claude: ProviderRateLimits;
  codex: ProviderRateLimits;
  now?: number;
  minAgeMs?: number;
}): boolean {
  return (
    shouldFetchProvider(input.claude, input) ||
    shouldFetchProvider(input.codex, input)
  );
}

const USAGE_STALE = "monocode-usage-stale";

/** Which footer chip a harness spends quota from, if any. */
export function usageProviderFor(harness: string): RateLimitProvider | null {
  return harness === "claude" || harness === "codex" ? harness : null;
}

/** Nudge the usage footer after a turn so the percentage tracks what just ran. */
export function notifyUsageStale(provider: RateLimitProvider | null): void {
  if (!provider) return;
  window.dispatchEvent(new CustomEvent(USAGE_STALE, { detail: provider }));
}

export function subscribeUsageStale(
  listener: (provider: RateLimitProvider) => void,
): () => void {
  const handler = (event: Event) => {
    const provider = usageProviderFor((event as CustomEvent<string>).detail);
    if (provider) listener(provider);
  };
  window.addEventListener(USAGE_STALE, handler);
  return () => window.removeEventListener(USAGE_STALE, handler);
}

const WINDOW_DURATION_TOLERANCE_MINUTES = 1;

export function idleRateLimits(
  provider: RateLimitProvider,
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: "idle",
  };
}

export function fetchingRateLimits(
  provider: RateLimitProvider,
  previous?: ProviderRateLimits | null,
): ProviderRateLimits {
  if (previous && (previous.session || previous.weekly)) {
    return { ...previous, status: "fetching" };
  }
  return {
    provider,
    session: previous?.session ?? null,
    weekly: previous?.weekly ?? null,
    updatedAt: previous?.updatedAt ?? 0,
    error: null,
    status: "fetching",
  };
}

export function unavailableRateLimits(
  provider: RateLimitProvider,
  error: string,
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: "unavailable",
  };
}

export function errorRateLimits(
  provider: RateLimitProvider,
  error: string,
  previous?: ProviderRateLimits | null,
): ProviderRateLimits {
  if (previous && (previous.session || previous.weekly)) {
    return {
      ...previous,
      error,
      status: "error",
      updatedAt: Date.now(),
    };
  }
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: "error",
  };
}

/**
 * A 429 from the usage endpoint. It arrives without Retry-After and tends to
 * persist, so hold off far longer than a normal error. The chip drops to "—"
 * rather than keeping the last numbers: we do not know them any more, and the
 * tooltip has room to say why.
 */
export function throttledRateLimits(
  provider: RateLimitProvider,
): ProviderRateLimits {
  return {
    ...errorRateLimits(provider, "Usage lookup rate limited"),
    backoffMs: RATE_LIMIT_BACKOFF_MS,
  };
}

export function clampUsedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function formatUsagePercent(usedPercent: number): string {
  return `${Math.round(clampUsedPercent(usedPercent))}%`;
}

/**
 * Compact window-size label. 10080 minutes stays "wk" to match the
 * original status-bar copy.
 */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === WEEKLY_WINDOW_MINUTES) return "wk";
  if (windowMinutes === SESSION_WINDOW_MINUTES) return "5h";
  if (windowMinutes === 60) return "1h";
  if (windowMinutes < 60) return `${windowMinutes}m`;
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`;
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/**
 * Compact remaining duration, flooring to whole units: "47m", "3h 54m",
 * "6d 7h". Returns "now" once the window has already reset.
 */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMins = Math.floor(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatResetCountdown(ms: number): string {
  const duration = formatResetDuration(ms);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

/**
 * Status-bar chip label. Prefer remaining time when resetsAt is known;
 * fall back to the fixed window size otherwise.
 */
export function formatRateLimitWindowChipLabel(
  window: RateLimitWindow,
  now = Date.now(),
): string {
  if (window.resetsAt != null) {
    return formatResetDuration(window.resetsAt - now);
  }
  return formatWindowLabel(window.windowMinutes);
}

export function rateLimitWindowTooltip(
  window: RateLimitWindow,
  now = Date.now(),
): string {
  const used = `${formatUsagePercent(window.usedPercent)} used`;
  if (window.resetsAt == null) {
    return `${used} · ${formatWindowLabel(window.windowMinutes)} window`;
  }
  return `${used} · ${formatResetCountdown(window.resetsAt - now)}`;
}

export function parseResetTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return normalizeEpochMs(value);
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") {
    return normalizeEpochMs(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeEpochMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // 1e10 sits between seconds-epoch (<2286) and millisecond-epoch (>2001).
  return value > 10_000_000_000 ? value : value * 1000;
}

export function mapUsageWindow(
  raw: unknown,
  windowMinutes: number,
): RateLimitWindow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const usedPercent = usedPercentFrom(rec);
  if (usedPercent == null) return null;
  return {
    usedPercent: clampUsedPercent(usedPercent),
    windowMinutes,
    resetsAt:
      parseResetTimestamp(rec.resets_at) ??
      parseResetTimestamp(rec.resetsAt) ??
      null,
  };
}

function usedPercentFrom(rec: Record<string, unknown>): number | null {
  const value =
    numberField(rec, "used_percentage") ??
    numberField(rec, "usedPercent") ??
    numberField(rec, "utilization");
  if (value == null) return null;
  return value;
}

export function parseClaudeOAuthUsage(body: string): ProviderRateLimits {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorRateLimits("claude", "Claude usage response was not JSON");
  }
  const rec = asRecord(parsed);
  if (!rec) {
    return errorRateLimits("claude", "Claude usage response was empty");
  }
  return {
    provider: "claude",
    session: mapUsageWindow(rec.five_hour, SESSION_WINDOW_MINUTES),
    weekly: mapUsageWindow(rec.seven_day, WEEKLY_WINDOW_MINUTES),
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

type CodexWindowSnapshot = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: unknown;
};

export function parseCodexRateLimits(result: unknown): ProviderRateLimits {
  const rec = asRecord(result);
  const wrapper = asRecord(rec?.rateLimits) ?? rec;
  const classified = classifyCodexWindows({
    primary: snapshotFrom(asRecord(wrapper?.primary)),
    secondary: snapshotFrom(asRecord(wrapper?.secondary)),
  });
  return {
    provider: "codex",
    session: mapCodexSnapshot(classified.session, SESSION_WINDOW_MINUTES),
    weekly: mapCodexSnapshot(classified.weekly, WEEKLY_WINDOW_MINUTES),
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

function snapshotFrom(
  rec: Record<string, unknown> | null,
): CodexWindowSnapshot | null {
  if (!rec) return null;
  const usedPercent =
    numberField(rec, "usedPercent") ??
    numberField(rec, "used_percent") ??
    numberField(rec, "used_percentage");
  if (usedPercent == null) return null;
  return {
    usedPercent,
    windowDurationMins:
      numberField(rec, "windowDurationMins") ??
      numberField(rec, "window_duration_mins") ??
      null,
    resetsAt: rec.resetsAt ?? rec.resets_at,
  };
}

function classifyCodexWindows(input: {
  primary: CodexWindowSnapshot | null;
  secondary: CodexWindowSnapshot | null;
}): {
  session: CodexWindowSnapshot | null;
  weekly: CodexWindowSnapshot | null;
} {
  let session: CodexWindowSnapshot | null = null;
  let weekly: CodexWindowSnapshot | null = null;
  for (const window of [input.primary, input.secondary]) {
    if (!window) continue;
    const kind = classifyWindowDuration(window.windowDurationMins);
    if (kind === "session" && !session) session = window;
    else if (kind === "weekly" && !weekly) weekly = window;
  }
  if (
    !session &&
    input.primary &&
    classifyWindowDuration(input.primary.windowDurationMins) === null
  ) {
    session = input.primary;
  }
  if (
    !weekly &&
    input.secondary &&
    classifyWindowDuration(input.secondary.windowDurationMins) === null
  ) {
    weekly = input.secondary;
  }
  return { session, weekly };
}

function classifyWindowDuration(
  duration: number | null,
): "session" | "weekly" | null {
  if (duration == null || !Number.isFinite(duration)) return null;
  if (
    Math.abs(duration - SESSION_WINDOW_MINUTES) <=
    WINDOW_DURATION_TOLERANCE_MINUTES
  ) {
    return "session";
  }
  if (
    Math.abs(duration - WEEKLY_WINDOW_MINUTES) <=
    WINDOW_DURATION_TOLERANCE_MINUTES
  ) {
    return "weekly";
  }
  return null;
}

function mapCodexSnapshot(
  raw: CodexWindowSnapshot | null,
  windowMinutes: number,
): RateLimitWindow | null {
  if (!raw) return null;
  return {
    usedPercent: clampUsedPercent(raw.usedPercent),
    windowMinutes,
    resetsAt: parseResetTimestamp(raw.resetsAt),
  };
}

function numberField(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
