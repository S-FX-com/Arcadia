// Operational controls for Hermes (§4 Phase 1a): kill switch, rate ceiling,
// publish window, draft-first. The ceiling is enforced in D1 — counting what
// actually shipped — not by trusting schedule frequency.

export interface ControlsEnv {
  CONTROL: KVNamespace;
  DB: D1Database;
  /** IANA timezone for the publish window, e.g. "America/New_York". */
  PUBLISH_TZ?: string;
  /** "HH:MM-HH:MM" local business hours, e.g. "09:00-17:00". */
  PUBLISH_WINDOW?: string;
}

const KILL_SWITCH_KEY = "control:kill_switch";

export interface KillSwitchState {
  engaged: boolean;
  by?: string;
  at?: string;
  reason?: string;
}

export async function killSwitch(env: ControlsEnv): Promise<KillSwitchState> {
  const raw = await env.CONTROL.get(KILL_SWITCH_KEY);
  if (!raw) return { engaged: false };
  try {
    return JSON.parse(raw) as KillSwitchState;
  } catch {
    return { engaged: true, reason: "unparseable kill switch state — failing safe" };
  }
}

export async function setKillSwitch(
  env: ControlsEnv,
  engaged: boolean,
  by: string,
  reason?: string
): Promise<KillSwitchState> {
  const state: KillSwitchState = {
    engaged,
    by,
    at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  await env.CONTROL.put(KILL_SWITCH_KEY, JSON.stringify(state));
  return state;
}

// ---------------------------------------------------------------------------
// Rate ceiling — enforced against published_log rows, per day and per week.
// ---------------------------------------------------------------------------

export interface RateCheck {
  exceeded: boolean;
  publishedToday: number;
  perDay: number;
  publishedThisWeek: number;
  perWeek: number;
}

async function configInt(db: D1Database, key: string, fallback: number): Promise<number> {
  const row = await db.prepare(`SELECT value FROM config WHERE key = ?1`).bind(key).first<{ value: string }>();
  const n = row ? Number.parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export async function checkRateCeiling(env: ControlsEnv): Promise<RateCheck> {
  const perDay = await configInt(env.DB, "hermes_rate_ceiling_per_day", 1);
  const perWeek = await configInt(env.DB, "hermes_rate_ceiling_per_week", 3);
  const day = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM published_log WHERE published_at >= datetime('now','-1 day')`)
    .first<{ n: number }>();
  const week = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM published_log WHERE published_at >= datetime('now','-7 days')`)
    .first<{ n: number }>();
  const publishedToday = day?.n ?? 0;
  const publishedThisWeek = week?.n ?? 0;
  return {
    exceeded: publishedToday >= perDay || publishedThisWeek >= perWeek,
    publishedToday,
    perDay,
    publishedThisWeek,
    perWeek,
  };
}

/**
 * Auto-publish stays off until 60 clean days have elapsed AND a human has
 * flipped hermes_auto_publish to 'on' (§4 controls, §8 governance). Arcadia
 * never flips it herself.
 */
export async function autoPublishAllowed(db: D1Database): Promise<boolean> {
  const flag = await db
    .prepare(`SELECT value FROM config WHERE key = 'hermes_auto_publish'`)
    .first<{ value: string }>();
  if (flag?.value !== "on") return false;
  const started = await db
    .prepare(`SELECT value FROM config WHERE key = 'hermes_draft_first_started_at'`)
    .first<{ value: string }>();
  if (!started) return false;
  const elapsedDays = (Date.now() - Date.parse(started.value)) / 86_400_000;
  return elapsedDays >= 60;
}

// ---------------------------------------------------------------------------
// Publish window — business hours in the configured timezone.
// ---------------------------------------------------------------------------

interface LocalClock {
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

function localClock(now: Date, tz: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = Number.parseInt(get("hour"), 10) % 24;
  return {
    weekday: weekdays.indexOf(get("weekday")),
    minutes: hour * 60 + Number.parseInt(get("minute"), 10),
  };
}

function parseWindow(window: string): { start: number; end: number } {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return { start: 9 * 60, end: 17 * 60 };
  return {
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
  };
}

/** True during business hours (Mon–Fri, within the configured window). */
export function withinPublishWindow(env: ControlsEnv, now = new Date()): boolean {
  const tz = env.PUBLISH_TZ ?? "America/New_York";
  const { start, end } = parseWindow(env.PUBLISH_WINDOW ?? "09:00-17:00");
  const clock = localClock(now, tz);
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.minutes >= start && clock.minutes < end;
}

/**
 * Next moment the publish window opens, for step.sleepUntil. Walks forward in
 * 15-minute increments — coarse but DST-proof, and the workflow engine only
 * needs a wake time inside the window.
 */
export function nextPublishWindowStart(env: ControlsEnv, from = new Date()): Date {
  const probe = new Date(from.getTime());
  for (let i = 0; i < (8 * 24 * 60) / 15; i++) {
    probe.setTime(probe.getTime() + 15 * 60 * 1000);
    if (withinPublishWindow(env, probe)) return probe;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
