import puppeteer from "@cloudflare/puppeteer";

export interface Env {
  SNAPSHOTS: KVNamespace;
  BROWSER: Fetcher;
  POKEHIVE_EMAIL: string;
  POKEHIVE_PASSWORD: string;
  ANTHROPIC_API_KEY: string;
  PUSHOVER_USER_KEY: string;
  PUSHOVER_APP_TOKEN: string;
  /** Separate Pushover app for failure alerts; falls back to PUSHOVER_APP_TOKEN. */
  PUSHOVER_ERROR_APP_KEY?: string;
  LOGIN_URL: string;
  SOURCE_URL: string;
  DEFAULT_TIMEZONE: string;
}

interface ProductInfo {
  name: string;
  contents: string;
  pricePerUnit: number;
  pricePerCase: number | null;
}

type Catalog = Record<string, ProductInfo>;

interface SectionState {
  /** CDN image filename(s) this catalog was last extracted from. */
  imageIds: string[];
  products: Catalog;
}

interface StoredState {
  fetchedAt: string;
  mainList: SectionState;
  preOrders: SectionState;
}

const EMPTY_SECTION: SectionState = { imageIds: [], products: {} };

function money(n: number): string {
  return `$${n.toFixed(2)}`;
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
// DST), so this check is what actually keeps the browser from launching
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

// ---------------------------------------------------------------------------
// Browser automation: log in as a real user (the site's member auth is
// undocumented client-side JS, not a stable API) and discover the current
// list-image URLs. The images themselves turn out to be publicly fetchable
// once you know the URL, so the browser's job ends here — downloading and
// vision extraction happen over plain fetch, keeping Browser Rendering
// usage (and its free-tier minutes-per-day cap) to just login + navigate.
// ---------------------------------------------------------------------------

interface DiscoveredImages {
  mainList: [string, string]; // two CDN image URLs, DOM order
  preOrders: string; // third image URL (also contains an out-of-scope section)
}

async function autoScroll(page: import("@cloudflare/puppeteer").Page): Promise<void> {
  await page.evaluate(async () => {
    const step = 800;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let scrolled = 0;
    while (scrolled < document.body.scrollHeight) {
      window.scrollBy(0, step);
      scrolled += step;
      await delay(150);
    }
  });
}

async function findFrameBySelector(
  page: import("@cloudflare/puppeteer").Page,
  selector: string,
  timeoutMs: number,
): Promise<import("@cloudflare/puppeteer").Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.$(selector).catch(() => null)) return frame;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function discoverImages(env: Env): Promise<DiscoveredImages> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();

    await page.goto(env.LOGIN_URL, { waitUntil: "networkidle0" });

    // The login form is rendered inside a same-origin iframe (/account/frame),
    // not the top-level document — page.waitForSelector only searches the
    // main frame, so the form's inputs have to be found on the iframe itself.
    const loginFrame = await findFrameBySelector(page, "#login-email", 15000);
    if (!loginFrame) {
      const title = await page.title().catch(() => "?");
      throw new Error(
        `Could not find the login form (#login-email) in any frame (url=${page.url()}, title="${title}")`,
      );
    }

    await loginFrame.type("#login-email", env.POKEHIVE_EMAIL);
    await loginFrame.type("#login-password", env.POKEHIVE_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }),
      // The submit click can race the resulting top-level navigation, which
      // tears down/replaces this iframe before the click command's own
      // confirmation comes back — Puppeteer then reports "Navigating frame
      // was detached" even though login succeeded. That's benign here since
      // page.waitForNavigation (and the login-page check below) are what
      // actually gate success; only a genuinely different click failure
      // should abort the run.
      loginFrame.click("button[type=submit]").catch((e) => {
        if (!/detached/i.test((e as Error).message)) throw e;
      }),
    ]);

    if (page.url().includes("/account/login")) {
      throw new Error("Still on login page after submit — login likely failed.");
    }

    await page.goto(env.SOURCE_URL, { waitUntil: "networkidle0" });
    await autoScroll(page);

    const imageUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img"));
      return imgs
        .filter(
          (img) =>
            img.naturalWidth > 100 &&
            img.src.includes("images.squarespace-cdn.com") &&
            // Header/footer logos are also CDN images; the list images are
            // uploaded screenshots.
            !/logo/i.test(decodeURIComponent(img.src.split("?")[0])),
        )
        .map((img) => img.src);
    });

    if (imageUrls.length < 3) {
      throw new Error(
        `Expected at least 3 tracked images on the member page, found ${imageUrls.length}.`,
      );
    }

    return { mainList: [imageUrls[0], imageUrls[1]], preOrders: imageUrls[2] };
  } finally {
    await browser.close();
  }
}

function imageFilename(url: string): string {
  return new URL(url).pathname.split("/").pop() ?? url;
}

// ---------------------------------------------------------------------------
// Vision extraction via the Claude API. Only called for images whose
// filename changed since the last run (see runCheck) — most runs reuse the
// previously stored catalog and skip this entirely.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT_MAIN = `This image is a screenshot of a spreadsheet listing wholesale Pokemon TCG products for sale.

Extract every product row into a JSON array. Skip the legend rows at the very top that explain what the highlight colors mean (they start with "This color means..."). Skip any blank rows.

Each array element must have exactly these fields:
- "name": the product name, exactly as written
- "contents": the contents/notes column text (e.g. "6 units per case"), or "" if empty
- "pricePerUnit": the "Price per unit" column as a number, or null if blank
- "pricePerCase": the "Price per case" column as a number, or null if blank

Respond with ONLY the JSON array, no other text, no markdown code fences.`;

const EXTRACTION_PROMPT_PRE_ORDERS = `This image is a screenshot of a spreadsheet. It may contain multiple sections stacked vertically, but you must extract ONLY the rows that fall under the "PRE ORDERS" heading (product names like set/box/case pre-order listings, typically near the top of the image).

Ignore and do NOT include rows under any other heading in the same image, such as "Chinese", "Gem", "Jumbo", or "151 Products" sections — those are out of scope.

Extract the in-scope rows into a JSON array. Skip blank rows. Each array element must have exactly these fields:
- "name": the product name, exactly as written
- "contents": the contents/notes column text, or "" if empty
- "pricePerUnit": the "Price per unit" column as a number, or null if blank
- "pricePerCase": the "Price per case" column as a number, or null if blank

Respond with ONLY the JSON array, no other text, no markdown code fences.`;

class ExtractionError extends Error {}

function parseJsonArray(text: string): unknown[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  return parsed;
}

async function extractCatalog(env: Env, imageUrl: string, prompt: string): Promise<Catalog> {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new ExtractionError(`Failed to download list image: ${imageRes.status}`);
  }
  const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
  let binary = "";
  for (let i = 0; i < imageBytes.length; i++) binary += String.fromCharCode(imageBytes[i]);
  const base64 = btoa(binary);

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!apiRes.ok) {
    throw new ExtractionError(`Claude API error: ${apiRes.status} ${await apiRes.text()}`);
  }

  const body = (await apiRes.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlock = body.content.find((b) => b.type === "text");
  if (!textBlock?.text) throw new ExtractionError("Claude response had no text block");

  let rows: unknown[];
  try {
    rows = parseJsonArray(textBlock.text);
  } catch (e) {
    throw new ExtractionError(`Failed to parse extraction JSON: ${(e as Error).message}`);
  }

  const catalog: Catalog = {};
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const pricePerUnit = typeof r.pricePerUnit === "number" ? r.pricePerUnit : NaN;
    if (!name || !Number.isFinite(pricePerUnit)) continue;
    catalog[name] = {
      name,
      contents: typeof r.contents === "string" ? r.contents : "",
      pricePerUnit,
      pricePerCase: typeof r.pricePerCase === "number" ? r.pricePerCase : null,
    };
  }
  if (Object.keys(catalog).length === 0) {
    throw new ExtractionError(`Extraction returned no products for ${imageFilename(imageUrl)}`);
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Diffing + notification formatting (mirrors wholesale-pokemon-watch: only
// additions, removals, and price changes are worth a notification).
// ---------------------------------------------------------------------------

interface Diff {
  added: Array<{ name: string; info: ProductInfo }>;
  removed: Array<{ name: string; info: ProductInfo }>;
  priceChanges: Array<{ name: string; from: number; to: number }>;
}

function diffCatalogs(previous: Catalog, current: Catalog): Diff {
  const diff: Diff = { added: [], removed: [], priceChanges: [] };

  for (const [name, info] of Object.entries(current)) {
    const prior = previous[name];
    if (!prior) {
      diff.added.push({ name, info });
      continue;
    }
    if (prior.pricePerUnit !== info.pricePerUnit) {
      diff.priceChanges.push({ name, from: prior.pricePerUnit, to: info.pricePerUnit });
    }
  }
  for (const [name, info] of Object.entries(previous)) {
    if (!current[name]) diff.removed.push({ name, info });
  }
  return diff;
}

function isDiffEmpty(diff: Diff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.priceChanges.length === 0;
}

function formatDiffSection(label: string, diff: Diff): string {
  const sections: string[] = [];

  if (diff.added.length > 0) {
    const lines = diff.added.map((a) => `• ${a.info.name} — ${money(a.info.pricePerUnit)}`);
    sections.push(`🆕 NEW (${diff.added.length})\n${lines.join("\n")}`);
  }
  if (diff.priceChanges.length > 0) {
    const lines = diff.priceChanges.map((c) => {
      const arrow = c.to > c.from ? "↑" : "↓";
      const delta = money(Math.abs(c.to - c.from));
      return `• ${c.name}\n   ${money(c.from)} → ${money(c.to)}  (${arrow} ${delta})`;
    });
    sections.push(`💰 PRICE CHANGES (${diff.priceChanges.length})\n${lines.join("\n")}`);
  }
  if (diff.removed.length > 0) {
    const lines = diff.removed.map((r) => `• ${r.info.name}`);
    sections.push(`❌ REMOVED (${diff.removed.length})\n${lines.join("\n")}`);
  }

  return `${label}\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

async function runCheck(env: Env, timeZone: string = env.DEFAULT_TIMEZONE): Promise<string> {
  const stored = (await env.SNAPSHOTS.get<StoredState>("state", "json")) ?? {
    fetchedAt: "",
    mainList: EMPTY_SECTION,
    preOrders: EMPTY_SECTION,
  };
  const isBaseline = stored.fetchedAt === "";

  let images: DiscoveredImages;
  try {
    images = await discoverImages(env);
  } catch (e) {
    const msg = `Login/navigation failed: ${(e as Error).message}`;
    console.log(msg);
    await notify(env, "PokeHive watch: login failed", `WARNING\n${msg}`);
    return msg;
  }

  const mainListIds = images.mainList.map(imageFilename);
  const preOrdersId = imageFilename(images.preOrders);

  const mainListChanged =
    mainListIds[0] !== stored.mainList.imageIds[0] ||
    mainListIds[1] !== stored.mainList.imageIds[1];
  const preOrdersChanged = preOrdersId !== stored.preOrders.imageIds[0];

  const extractionErrors: string[] = [];
  let mainListSection = stored.mainList;
  let preOrdersSection = stored.preOrders;

  if (mainListChanged) {
    try {
      const [part1, part2] = await Promise.all([
        extractCatalog(env, images.mainList[0], EXTRACTION_PROMPT_MAIN),
        extractCatalog(env, images.mainList[1], EXTRACTION_PROMPT_MAIN),
      ]);
      mainListSection = { imageIds: mainListIds, products: { ...part1, ...part2 } };
    } catch (e) {
      extractionErrors.push(`Main List: ${(e as Error).message}`);
    }
  }

  if (preOrdersChanged) {
    try {
      const products = await extractCatalog(env, images.preOrders, EXTRACTION_PROMPT_PRE_ORDERS);
      preOrdersSection = { imageIds: [preOrdersId], products };
    } catch (e) {
      extractionErrors.push(`Pre-Orders: ${(e as Error).message}`);
    }
  }

  if (extractionErrors.length > 0) {
    const msg = extractionErrors.join("\n");
    console.log(msg);
    await notify(env, "PokeHive watch: extraction failed", `WARNING\n${msg}`);
  }

  const now = new Date().toISOString();
  const newState: StoredState = {
    fetchedAt: now,
    mainList: mainListSection,
    preOrders: preOrdersSection,
  };
  const saveState = () => env.SNAPSHOTS.put("state", JSON.stringify(newState));

  if (isBaseline) {
    await saveState();
    const count =
      Object.keys(mainListSection.products).length + Object.keys(preOrdersSection.products).length;
    await notify(
      env,
      "PokeHive watch started",
      `Tracking ${count} products (${Object.keys(mainListSection.products).length} main list, ${Object.keys(preOrdersSection.products).length} pre-orders) on ${env.SOURCE_URL}`,
    );
    return `Baseline stored: ${count} products.`;
  }

  const mainDiff = diffCatalogs(stored.mainList.products, mainListSection.products);
  const preOrdersDiff = diffCatalogs(stored.preOrders.products, preOrdersSection.products);

  const sections: string[] = [];
  if (!isDiffEmpty(mainDiff)) sections.push(formatDiffSection("Main List", mainDiff));
  if (!isDiffEmpty(preOrdersDiff)) sections.push(formatDiffSection("Pre-Orders", preOrdersDiff));

  if (sections.length === 0) {
    await saveState();
    const count = Object.keys(mainListSection.products).length;
    return `No changes. ${count} main-list products checked at ${formatTimestamp(now, timeZone)}.`;
  }

  const changeCount =
    mainDiff.added.length +
    mainDiff.removed.length +
    mainDiff.priceChanges.length +
    preOrdersDiff.added.length +
    preOrdersDiff.removed.length +
    preOrdersDiff.priceChanges.length;

  const delivered = await notify(
    env,
    `PokeHive Wholesale: ${changeCount} change${changeCount === 1 ? "" : "s"}`,
    sections.join("\n\n"),
  );
  if (!delivered) {
    // Keep the old snapshot so the next run re-detects and re-sends these changes.
    const msg = `${changeCount} changes found but the Pushover notification was NOT delivered; snapshot not advanced, will retry next run.`;
    console.log(msg);
    await notifyError(env, "PokeHive watch: notification failed", msg);
    return msg;
  }
  await saveState();

  return `${changeCount} changes found and notified at ${formatTimestamp(now, timeZone)}.`;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isWithinWorkingHours(new Date(), env.DEFAULT_TIMEZONE)) return;
    ctx.waitUntil(
      runCheck(env).catch(async (e) => {
        const msg = `Unhandled error in scheduled check: ${(e as Error).stack ?? e}`;
        console.log(msg);
        await notifyError(env, "PokeHive watch: check crashed", msg);
      }),
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
      const summary = await runCheck(env, timeZone);
      return new Response(summary, { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/") {
      const stored = await env.SNAPSHOTS.get<StoredState>("state", "json");
      const body = stored
        ? `Last checked: ${formatTimestamp(stored.fetchedAt, timeZone)}\n` +
          `Main list products: ${Object.keys(stored.mainList.products).length}\n` +
          `Pre-order products: ${Object.keys(stored.preOrders.products).length}`
        : "No snapshot yet — hit /run to take the first one.";
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
