import {
  type Catalog,
  type FailureStep,
  type StoredState,
  ParseError,
  SessionError,
  countChanges,
  diffCatalogs,
  formatCounts,
  formatDiff,
  parseWholesale,
  suspectReason,
  totalItems,
} from "./wholesale";

export interface Env {
  SNAPSHOTS: KVNamespace;
  /** Full Cookie request-header value copied from a www.thepokehive.com request. */
  POKEHIVE_SESSION_COOKIE: string;
  PUSHOVER_USER_KEY: string;
  PUSHOVER_APP_TOKEN: string;
  /** Separate Pushover app for failure alerts; falls back to PUSHOVER_APP_TOKEN. */
  PUSHOVER_ERROR_APP_KEY?: string;
  SOURCE_URL: string;
  DEFAULT_TIMEZONE: string;
}

function formatTimestamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(iso));
}

// Pushover caps a message at 1024 characters, so long change lists are split
// into several messages on line boundaries.
const PUSHOVER_MAX_MESSAGE_CHARS = 1024;
const PUSHOVER_MAX_MESSAGES = 8;

function chunkByLines(body: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawLine of body.split("\n")) {
    // A single line longer than the cap is hard-split.
    for (let i = 0; i === 0 || i < rawLine.length; i += max) {
      const line = rawLine.slice(i, i + max);
      if (current && current.length + 1 + line.length > max) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function pushoverSend(
  env: Env,
  title: string,
  message: string,
  isError: boolean,
): Promise<boolean> {
  const params = new URLSearchParams({
    token: (isError ? env.PUSHOVER_ERROR_APP_KEY?.trim() : "") || env.PUSHOVER_APP_TOKEN?.trim() || "",
    user: env.PUSHOVER_USER_KEY?.trim() ?? "",
    title: title.slice(0, 250),
    message,
  });
  // Errors go out under their own Pushover app, at high priority (bypasses quiet
  // hours) with a distinct sound.
  if (isError) {
    params.set("priority", "1");
    params.set("sound", "siren");
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        body: params,
      });
      if (res.ok) return true;
      console.log(
        `pushover failed (attempt ${attempt}): ${res.status} ${await res.text().catch(() => "")}`,
      );
      if (res.status < 500) return false; // 4xx (bad token/user, rate limit) won't fix itself on retry
    } catch (e) {
      console.log(`pushover error (attempt ${attempt}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return false;
}

/** Returns true only if every part of the message was accepted by Pushover. */
async function notify(
  env: Env,
  title: string,
  body: string,
  isError = false,
): Promise<boolean> {
  const chunks = chunkByLines(body, PUSHOVER_MAX_MESSAGE_CHARS);
  const sent = chunks.slice(0, PUSHOVER_MAX_MESSAGES);
  if (chunks.length > sent.length) {
    const marker = "\n… (truncated)";
    const last = sent[sent.length - 1];
    sent[sent.length - 1] = last.slice(0, PUSHOVER_MAX_MESSAGE_CHARS - marker.length) + marker;
  }
  for (let i = 0; i < sent.length; i++) {
    const partTitle = sent.length > 1 ? `${title} (${i + 1}/${sent.length})` : title;
    if (!(await pushoverSend(env, partTitle, sent[i], isError))) return false;
  }
  return true;
}

/** Failures are sent high-priority so they stand out from list updates. */
async function notifyError(env: Env, title: string, body: string): Promise<void> {
  await notify(env, title, `WARNING\n${body}`, true).catch((e) =>
    console.log(`error notify failed: ${(e as Error).message}`),
  );
}

// ---------------------------------------------------------------------------
// Working-hours gate: 10am-8pm Eastern, Monday-Friday. The cron fires hourly
// every day (Cloudflare crons can't express a timezone or weekdays alongside
// DST), so this check is what actually keeps the Worker from fetching
// outside the intended window.
// ---------------------------------------------------------------------------

const WORKING_HOURS_START = 10;
const WORKING_HOURS_END = 20;

function isWithinWorkingHours(date: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
    timeZone,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return isWeekday && hour >= WORKING_HOURS_START && hour < WORKING_HOURS_END;
}

/** YYYY-MM-DD calendar date for `date` as observed in `timeZone`. */
function dateStringInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// ---------------------------------------------------------------------------
// Fetching the list. The session cookie is attached only to SOURCE_URL's own
// host, never follows a redirect, and is never logged, alerted or stored.
// ---------------------------------------------------------------------------

class PageLoadError extends Error {}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchList(env: Env): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(env.SOURCE_URL);
  } catch {
    throw new PageLoadError("SOURCE_URL is not a valid URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.thepokehive.com") {
    throw new PageLoadError("SOURCE_URL is not the expected PokeHive host");
  }

  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
  };
  const cookie = env.POKEHIVE_SESSION_COOKIE?.trim();
  // The protocol and hostname of `url` were verified against the allow-list above,
  // and the request below goes to exactly that URL.
  if (cookie) headers.Cookie = cookie;

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: "GET", headers, redirect: "manual" });
  } catch (e) {
    // Never forward e.message: runtime errors can quote header values (the cookie).
    throw new PageLoadError(`Network error (${e instanceof Error ? e.name : "unknown"})`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new SessionError(`Redirected (HTTP ${res.status}); the session cookie is likely expired`);
  }
  if (!res.ok) throw new PageLoadError(`HTTP ${res.status}`);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new PageLoadError("Response body was not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// State access (contract C2)
// ---------------------------------------------------------------------------

type StateRead =
  | { kind: "baseline" }
  | { kind: "migration" }
  | { kind: "ok"; state: StoredState }
  | { kind: "error"; message: string };

function isSchema2(v: unknown): v is StoredState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.schema !== 2 || typeof s.fetchedAt !== "string") return false;
  if (s.lastChangeDate !== undefined && typeof s.lastChangeDate !== "string") return false;
  if (typeof s.sections !== "object" || s.sections === null || Array.isArray(s.sections)) {
    return false;
  }
  for (const items of Object.values(s.sections as Record<string, unknown>)) {
    if (typeof items !== "object" || items === null || Array.isArray(items)) return false;
    for (const it of Object.values(items as Record<string, unknown>)) {
      if (typeof it !== "object" || it === null) return false;
      const i = it as Record<string, unknown>;
      if (
        typeof i.id !== "string" ||
        typeof i.name !== "string" ||
        typeof i.unit !== "string" ||
        typeof i.price !== "number"
      ) {
        return false;
      }
    }
  }
  return true;
}

async function readState(env: Env): Promise<StateRead> {
  let raw: unknown;
  try {
    raw = await env.SNAPSHOTS.get("state", "json");
  } catch (e) {
    return { kind: "error", message: `KV read failed: ${(e as Error).message}` };
  }
  if (raw === null) return { kind: "baseline" };
  if (isSchema2(raw)) return { kind: "ok", state: raw };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.schema === undefined && ("mainList" in o || "preOrders" in o)) {
      return { kind: "migration" };
    }
  }
  return { kind: "error", message: "Stored state has an unrecognized shape" };
}

// ---------------------------------------------------------------------------
// Failure alerts: once per step per Eastern date, tracked in KV `lastErrorAlert`
// (never in `state`).
// ---------------------------------------------------------------------------

const SESSION_RENEWAL_STEPS =
  "To renew:\n" +
  "1. Sign in with Shop at www.thepokehive.com in the dedicated browser profile.\n" +
  "2. In DevTools > Network, open a www.thepokehive.com request and copy the full Cookie request header.\n" +
  "3. Run: wrangler secret put POKEHIVE_SESSION_COOKIE and paste it.";

const STEP_TITLES: Record<FailureStep, string> = {
  session: "session expired",
  "page-load": "page load failed",
  parse: "parse failed",
  suspect: "list looks incomplete",
  state: "stored state unreadable",
  delivery: "notification failed",
};

async function failStep(env: Env, step: FailureStep, detail: string): Promise<string> {
  const today = dateStringInTimeZone(new Date(), env.DEFAULT_TIMEZONE);
  const summary = `${STEP_TITLES[step]}: ${detail}`;
  console.log(`failure [${step}] ${detail}`);

  let steps: FailureStep[] = [];
  try {
    const last = await env.SNAPSHOTS.get<unknown>("lastErrorAlert", "json");
    if (
      typeof last === "object" &&
      last !== null &&
      !Array.isArray(last) &&
      (last as Record<string, unknown>).date === today &&
      Array.isArray((last as Record<string, unknown>).steps) &&
      ((last as Record<string, unknown>).steps as unknown[]).every((x) => typeof x === "string")
    ) {
      steps = (last as { steps: FailureStep[] }).steps;
    }
  } catch {
    // Unreadable dedupe record: better to alert than to stay silent.
  }
  if (steps.includes(step)) {
    return `${summary} (already alerted today)`;
  }

  let body = detail;
  if (step === "session") body += `\n\n${SESSION_RENEWAL_STEPS}`;
  if (step === "suspect") {
    body += "\n\nIf this change is real, hit /run?accept=1 to save the current list as the new baseline.";
  }
  const delivered = await notify(env, `PokeHive watch: ${STEP_TITLES[step]}`, `WARNING\n${body}`, true)
    .catch(() => false);
  if (delivered) {
    try {
      await env.SNAPSHOTS.put("lastErrorAlert", JSON.stringify({ date: today, steps: [...steps, step] }));
    } catch (e) {
      console.log(`lastErrorAlert write failed: ${(e as Error).message}`);
    }
  }
  return summary;
}

async function clearErrorAlert(env: Env): Promise<void> {
  try {
    await env.SNAPSHOTS.delete("lastErrorAlert");
  } catch (e) {
    console.log(`lastErrorAlert delete failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

async function runCheck(
  env: Env,
  timeZone: string = env.DEFAULT_TIMEZONE,
  accept = false,
): Promise<string> {
  const read = await readState(env);
  if (read.kind === "error") return failStep(env, "state", read.message);

  let current: Catalog;
  try {
    current = parseWholesale(await fetchList(env));
  } catch (e) {
    if (e instanceof SessionError) return failStep(env, "session", e.message);
    if (e instanceof ParseError) return failStep(env, "parse", e.message);
    return failStep(env, "page-load", (e as Error).message);
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const today = dateStringInTimeZone(nowDate, env.DEFAULT_TIMEZONE);
  const previous = read.kind === "ok" ? read.state : null;

  const saveBaseline = async (): Promise<string> => {
    const state: StoredState = {
      schema: 2,
      fetchedAt: now,
      lastChangeDate: previous?.lastChangeDate,
      sections: current,
    };
    await env.SNAPSHOTS.put("state", JSON.stringify(state));
    const delivered = await notify(
      env,
      "PokeHive watch restarted",
      `Tracking ${totalItems(current)} items:\n${formatCounts(current)}`,
    );
    if (!delivered) console.log("baseline notification was not delivered");
    await clearErrorAlert(env);
    return `Baseline stored: ${totalItems(current)} items.`;
  };

  if (!previous) return saveBaseline();

  const suspect = suspectReason(previous.sections, current);
  if (suspect) {
    if (accept) return saveBaseline();
    return failStep(env, "suspect", suspect);
  }

  const diffs = diffCatalogs(previous.sections, current);
  const changeCount = countChanges(diffs);
  const newState: StoredState = {
    schema: 2,
    fetchedAt: now,
    lastChangeDate: previous.lastChangeDate,
    sections: current,
  };

  if (changeCount === 0) {
    await env.SNAPSHOTS.put("state", JSON.stringify(newState));
    await clearErrorAlert(env);
    return `No changes. ${totalItems(current)} items checked at ${formatTimestamp(now, timeZone)}.`;
  }

  const delivered = await notify(
    env,
    `PokeHive Wholesale: ${changeCount} change${changeCount === 1 ? "" : "s"}`,
    formatDiff(diffs),
  );
  if (!delivered) {
    // Keep the old snapshot so the next run re-detects and re-sends these changes.
    return failStep(
      env,
      "delivery",
      `${changeCount} changes found but the Pushover notification was NOT delivered; snapshot not advanced, will retry next run.`,
    );
  }
  // A change was successfully notified; no need to keep polling today.
  newState.lastChangeDate = today;
  await env.SNAPSHOTS.put("state", JSON.stringify(newState));
  await clearErrorAlert(env);
  return `${changeCount} changes found and notified at ${formatTimestamp(now, timeZone)}.`;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    if (!isWithinWorkingHours(now, env.DEFAULT_TIMEZONE)) return;
    ctx.waitUntil(
      (async () => {
        const today = dateStringInTimeZone(now, env.DEFAULT_TIMEZONE);
        const read = await readState(env);
        if (read.kind === "ok" && read.state.lastChangeDate === today) {
          console.log(`Skipping check: a change was already found and notified today (${today}).`);
          return;
        }
        await runCheck(env).catch(async (e) => {
          const msg = `Unhandled error in scheduled check: ${(e as Error).message}`;
          console.log(msg);
          await notifyError(env, "PokeHive watch: check crashed", msg);
        });
      })(),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const timeZone = (request.cf?.timezone as string | undefined) ?? env.DEFAULT_TIMEZONE;

    if (url.pathname === "/test-error-alert") {
      const delivered = await notify(
        env,
        "PokeHive watch: test error alert",
        "WARNING\nThis is a test of the failure-alert channel.",
        true,
      );
      return new Response(delivered ? "Test error alert sent." : "Test error alert FAILED.", {
        status: delivered ? 200 : 502,
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/run") {
      const summary = await runCheck(env, timeZone, url.searchParams.get("accept") === "1");
      return new Response(summary, { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/") {
      const read = await readState(env);
      let body: string;
      if (read.kind === "ok") {
        body =
          `Last checked: ${formatTimestamp(read.state.fetchedAt, timeZone)}\n` +
          `Items: ${totalItems(read.state.sections)}\n` +
          formatCounts(read.state.sections);
      } else if (read.kind === "error") {
        body = `Stored state is unreadable: ${read.message}`;
      } else if (read.kind === "migration") {
        body = "Legacy snapshot found; hit /run to take a new baseline.";
      } else {
        body = "No snapshot yet; hit /run to take the first one.";
      }
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
