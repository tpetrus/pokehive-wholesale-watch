# Contracts: Shopify wholesale list (plan `shopify-page-scrape` r1)

Status: **frozen 2026-11-19**, pending the S1 24-hour cookie replay. If that check
fails, these contracts are void and the plan is re-planned (plan risk K1).
Supersedes the plan's draft C1-C4 where noted. Owner: orchestrator. Workers must
not change these; raise an escalation instead.

## S1 findings (spike, `spike/session-spike.ts`, 2026-11-19)

- The whole list is one JSON endpoint: `GET https://www.thepokehive.com/apps/wholesale/list`
  (Shopify app proxy). No HTML parsing, no browser, no pagination.
- With the copied browser `Cookie` header: `showPrices: true`, real prices.
  Without it: same 6 categories and 193 items, `showPrices: false`, every `price: 0`.
  `ok` is `true` in both cases, so `ok` is **not** a login marker.
- Positive logged-in marker: `showPrices === true`.
- No `Set-Cookie` for `_shopify_essential` came back on either URL, so there is no
  observed rolling refresh. (Re-check on the 24 h run.)
- Prices are integer **cents**. `unit` is one of Pack, Case, Display, Box (treat as
  free text). `id` (e.g. `p12732197863742`) is unique across all 193 items. Names are
  not unique within a category: the same name can appear as Case and as Display.
- Optional item fields: `note`, `min`, `shipPer`, `left`, `badges`, `soldOut`, `image`.
  Category `note` is optional.

## C1 Env bindings (config) - revised

Keep: `SNAPSHOTS` (KV), `PUSHOVER_USER_KEY`, `PUSHOVER_APP_TOKEN`,
`PUSHOVER_ERROR_APP_KEY`, `DEFAULT_TIMEZONE`.
`SOURCE_URL` var = `https://www.thepokehive.com/apps/wholesale/list`.
Add secret `POKEHIVE_SESSION_COOKIE`: the full `Cookie` request-header value copied
from the browser for a `www.thepokehive.com` request.
Remove: `ANTHROPIC_API_KEY`, `POKEHIVE_EMAIL`, `POKEHIVE_PASSWORD`, `LOGIN_URL`,
the `browser` binding (`BROWSER`) and the `@cloudflare/puppeteer` dependency.

The cookie is sent only to the `SOURCE_URL` host, with `redirect: "manual"`, and only
when that URL is `https:` with hostname exactly `www.thepokehive.com`. Its value is never
logged, never included in an alert, and never written to KV. Error text from `fetch` or
header construction is never forwarded (alerts, logs, HTTP responses use a fixed message
plus the error's `name` only), since runtime errors can quote header values.
(Amended 2026-11-20, review finding F4.)

## C2 StoredState schema 2 (data) - revised

KV key `state`:

```ts
interface WholesaleItem {
  id: string;
  name: string;
  unit: string;        // "Pack" | "Case" | "Display" | "Box" | other
  price: number;       // integer cents, > 0
  perUnit?: string;    // e.g. "$60.00", parsed from note "· $60.00 per unit" when present
  note?: string;
}
interface StoredState {
  schema: 2;
  fetchedAt: string;                 // ISO
  lastChangeDate?: string;           // YYYY-MM-DD in DEFAULT_TIMEZONE
  sections: Record<string, Record<string, WholesaleItem>>; // heading -> id -> item, headings in page order
}
```

KV key `lastErrorAlert`: `{ date: string; steps: FailureStep[] }` (date = YYYY-MM-DD in
DEFAULT_TIMEZONE; steps = every step already alerted on that date). Kept separate so a
failure never writes `state`. Deleted on success. A stored value of any other shape
(including the earlier `{ step, date }`) is treated as empty.
(Amended 2026-11-20, review finding F1: a single `{ step, date }` let alternating steps
re-alert the same step on one date, violating AC1.)

Read rules for `state`: `null` means first run (baseline). A legacy object (has `mainList` or
`preOrders`, no `schema`) means migration baseline. `schema === 2` is used as is.
Any other shape, or a KV read error, is a `state` failure: alert and stop, never baseline.

The plan's KV `session` key is **dropped** (no rolling refresh observed). Revisit only
if the 24 h run shows `_shopify_essential` being re-issued.

## C3 parseWholesale (function) - revised

```ts
class ParseError extends Error {}
class SessionError extends Error {}  // logged-out response
function parseWholesale(doc: unknown): Catalog  // Catalog = StoredState["sections"]
```

Synchronous and pure; input is the already-`JSON.parse`d response body. Throws
`SessionError` when `showPrices !== true`. Throws `ParseError` when `ok !== true`,
`list.categories` is missing or empty, any category has no items, or any item lacks a
string `id`/`name`/`unit` or has a `price` that is not a finite number > 0. Section
keys are category `name`s in response order; item keys are `id`.

## C4 Failure steps (alert) - unchanged from plan, step names fixed

`FailureStep = "session" | "page-load" | "parse" | "suspect" | "state" | "delivery"`.

- `session`: `SessionError`, or a 3xx response. The alert includes renewal steps
  (recopy the Cookie header, `wrangler secret put POKEHIVE_SESSION_COOKIE`).
- `page-load`: non-2xx, network error, or a body that is not JSON.
- `parse`: `ParseError`.
- `suspect`: partial-parse guard tripped versus the previous schema-2 snapshot: a
  previously seen section missing, any section losing more than 50% of its items, or the
  total dropping by more than 30%. The alert lists the counts. `/run?accept=1` saves the
  current result as the new baseline (plan K6).
- `state`: unreadable snapshot.
- `delivery`: Pushover rejected the change alert.

Each step alerts at most once per Eastern date, tracked in KV key `lastErrorAlert`
(a different step on the same date does alert; a step is added to `steps` only after its
alert was delivered; a new date resets `steps`). `state` is never written on any failure.
A later successful run deletes `lastErrorAlert`.

## Diff and alert format (AC4, D8 as clarified 2026-11-19)

Changes are computed per section by `id`: added, removed, and changed when `price` or
`unit` differs. Note, badge, `left` and `min` changes do not alert. A product whose `id`
moves between sections is reported as removed from one and added to the other. One
Pushover message (split by the existing 1024-char chunking), grouped by section heading:

```
💰 PRICE CHANGES (1)
English Pokémon
• 30th Celebration Booster Bundle
   $1,500.00 → $1,550.00 / Case  (↑ $50.00) · $62.00 per unit
```

Baseline (first run or legacy migration): exactly one "watch restarted" message with the
item count per section and no added/removed alerts (AC3).
