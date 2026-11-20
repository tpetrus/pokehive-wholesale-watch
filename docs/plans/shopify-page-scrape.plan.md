# Read wholesale list directly from Shopify page
> Double-diamond plan `shopify-page-scrape` revision 1 | status **final** | lane full | risk R3 | base 834c86b0eeec | updated 2026-11-19T19:25:36.395Z
_Generated from plan.json by dd_plan.py. Edit plan.json, not this file._
## Request

> We no longer need to log in for this watcher.  Also, the site has been converted to a shopify site, so we no longer need to analyze text in images, and there is no pagination on the page so we can pull all of the data directly from code. here is the new link: https://www.thepokehive.com/pages/wholesale

## Problem

The PokeHive wholesale list moved from a Squarespace member page that showed the list as spreadsheet screenshots (read by Claude vision) to a Shopify page at https://www.thepokehive.com/pages/wholesale that renders the list as page markup with no pagination, visible only after login. The watcher still logs into the old domain, hunts Squarespace CDN images and pays for vision extraction, so it is broken and needlessly complex.

**Users:** Trevor, the watcher's owner, who gets Pushover alerts about new, removed and repriced wholesale items

**Evidence:**
- User: site converted to Shopify, no image analysis needed, no pagination, new URL https://www.thepokehive.com/pages/wholesale
- Public fetch of the new URL shows only landing text (Sign up or log in, membership from 15 USD per month); user confirmed the list appears only when logged in
- src/index.ts discoverImages logs in at LOGIN_URL via an iframe form, then filters images.squarespace-cdn.com images; extractCatalog sends them to the Claude API
- wrangler.jsonc LOGIN_URL and SOURCE_URL still point at thepokehivewholesale.com

## Goals

- Log into the new Shopify site and read every wholesale row directly from the logged-in page markup in one load
- Track products per section, mirroring whatever section headings the new page has
- Remove the image discovery, Claude vision extraction and the Anthropic API key
- Keep existing behaviour: working-hours gate, once-a-day skip after a notified change, Pushover alerts and separate error channel, retry on failed delivery

## Non-goals

- Hard-coding the old Main List and Pre-Orders sections
- Using the public Shopify products.json retail catalogue (it is the retail shop, not the wholesale list)
- Changing the alert channel, schedule or working-hours window
- Alerting on stock or availability changes unless they are already part of a row's price data

## Success metrics

- Zero Anthropic API calls per run
- A scheduled run finishes with one login plus one page load
- No false add/remove alerts on the first run after switchover

## Constraints

- Cloudflare Worker on the free tier; Browser Rendering minutes are capped, so browser time per run stays short
- Credentials stay in Worker secrets, never in code, plan files or logs
- Login is still required for the list to render

## Acceptance criteria

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC1 | valid member credentials in Worker secrets | a check runs | the watcher reaches www.thepokehive.com/pages/wholesale as a logged-in member with the list visible, without a human entering a code on that run. A failed or expired session sends at most one error alert per failure step per day. The alert names the failed step and says how to renew access, and the stored snapshot and session stay unchanged. |
| AC2 | the logged-in wholesale page | it is parsed | every product row is captured with section, name, contents and price per unit (plus price per case when present), grouped under the page's own section headings, from a single page load with no image download and no Anthropic API call |
| AC3 | a stored snapshot from the old image-based format | the first run after deploy completes | the old snapshot is replaced by a fresh baseline and exactly one watch restarted message lists the product count for each section, with no add or remove alerts |
| AC4 | a baseline in the new format | a product is added, removed or repriced in any section | one Pushover alert lists those changes grouped by section heading, with a price change on either price per unit or price per case reported; unchanged runs send nothing |
| AC5 | the page loads but parses to zero rows or zero sections, or to a suspect partial result (a previously seen section is missing, any section loses more than half its rows, or the total drops by more than 30 percent) | a check runs | an error alert is sent and the snapshot is not overwritten, so no false mass removal is reported |
| AC6 | the deployed Worker and README | they are inspected | no image or vision code, no ANTHROPIC_API_KEY and no thepokehivewholesale.com or Squarespace references remain; README lists the remaining secrets and the new URLs |

## Decisions

| ID | Question | Answer | Decided by | Rationale |
| --- | --- | --- | --- | --- |
| D1 | Is login still needed? | Yes. The wholesale list renders only for logged-in members, so the login step stays and is retargeted to the Shopify site. | user | User checked after the public fetch showed no list |
| D2 | Which sections to track? | Mirror the new page's own section headings; drop the Main List and Pre-Orders split. | user | User: there are new sections, align with them |
| D3 | How to handle the switchover? | Fresh baseline: ignore the old image-era snapshot on first run and send one watch restarted message with per-section counts. | user | Old names came from OCR and will not match |
| D4 | What to remove? | Remove image discovery, vision extraction, the ANTHROPIC_API_KEY secret and its docs. Login credentials or session material stay only as needed by the chosen login approach. | user | User chose remove all, then kept login; the two answers reconcile to this |
| D5 | May the planner inspect the logged-in page? | No live inspection during planning; selectors are pinned in the first implementation slice against the real logged-in page. | user | User skipped browser inspection for now |
| D6 | Is the framing right? | Yes, confirmed at the full-lane checkpoint. | user | Checkpoint round 3 |
| D7 | How does login work on the new site? | Sign in with Shop (Shopify SSO), a passwordless flow with an emailed or app code or a passkey, so a stored email and password alone cannot log in unattended. | user | User: Shop SSO |
| D8 | Which price changes alert? | Changes in either price per unit or price per case. | user | User chose unit and case price |
| D9 | How is the parser tested, given the repo has no test framework? | Add vitest as a dev dependency with a sanitised HTML fixture of the logged-in page, plus a typecheck script (tsc --noEmit). | planner assumption (confirm) | The parser is the main failure point; a fixture test catches markup changes cheaply |
| D10 | How is the session obtained? | The owner signs in with Shop once in a desktop browser and copies the session cookies into a Worker secret. The Worker never handles codes or passkeys. | planner assumption (confirm) | Shop SSO cannot be automated unattended without intercepting email or passkeys |

## Options considered

Weights: fit 30%, risk 25%, effort 20%, ux 15%, reversibility 10%. Scores 1-5, higher is better.

| ID | Lens | Summary | fit | risk | effort | ux | reversibility | Covers all ACs | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | minimal | Keep the single-file Worker; replace the login with a manually seeded Shopify session cookie (KV) injected before one page load, replace image/vision code with one page.evaluate DOM parse into dynamic sections, and reuse the existing diff, notify and gate code. | 4 | 3 | 4 | 3 | 4 | yes | 3.6 |
| O2 | robust | Replace the scripted login with a persisted Shopify member session (cookies captured once by a local helper, refreshed on each run, kept in KV/secret), then parse the page with a pure, validated, schema-versioned section parser that never overwrites the snapshot on any doubt. | 3 | 3 | 2 | 4 | 3 | yes | 2.95 |
| O3 | contrarian | Drop the browser and the login step from the Worker: the owner logs in once by hand, pastes the Shopify session cookies into a Worker secret, and each run does a plain fetch() of the wholesale page and parses the HTML. | 4 | 3 | 4 | 2 | 4 | no | 3.45 |
| **O4** (chosen) | hybrid | Hybrid of O3, O2 and O1: session cookie in a Worker secret with a rolling refresh in KV, a plain cookie fetch first, and the browser kept only as a fallback if a spike shows the list is rendered by JavaScript. A pure, versioned section parser and a fresh baseline complete it. | 4 | 4 | 4 | 4 | 4 | yes | 4 |

## Decision

**O4**: Hybrid of O3, O2 and O1: session cookie in a Worker secret with a rolling refresh in KV, a plain cookie fetch first, and the browser kept only as a fallback if a spike shows the list is rendered by JavaScript. A pure, versioned section parser and a fresh baseline complete it.

Sign in with Shop is passwordless, so every option converged on a stored session. O4 is the top scorer. It takes O3's cheap cookie fetch, O2's pure parser and rolling session refresh, and O1's browser path as a fallback. The S1 spike settles fetch versus browser before anything else is built. O2's local capture helper is dropped as extra effort, since copying a cookie from DevTools is documented instead.

**Approach:**
- From O3: the owner signs in with Shop once in a normal browser and stores the Shopify customer session cookies with wrangler secret put POKEHIVE_SESSION_COOKIE. No code or passkey is automated.
- Spike first (slice S1): from a Worker, fetch SOURCE_URL with the cookie and check whether the raw HTML contains the list. If yes, use plain fetch plus HTMLRewriter and drop the BROWSER binding. If not, keep the browser and only call page.setCookie plus one goto (O1).
- From O2: after every successful load, save any refreshed Set-Cookie values to KV key session, so Shopify's rolling expiry keeps the session alive. The Worker prefers the KV session over the secret.
- Session check: a redirect to a login or account URL, or a missing list marker, sends notifyError with step session and renewal steps. The snapshot is untouched.
- From O2: a pure parseWholesale(html) in src/parse.ts returns sections keyed by page heading, with rows of name, contents, unitPrice and an optional casePrice. Zero rows, zero sections or non-numeric prices throw ParseError, which sends an error alert and skips the save.
- StoredState schema 2 keyed by section. An old or missing schema means a fresh baseline: save, clear lastChangeDate, and send one restarted message with per-section counts.
- diffCatalogs runs per section and compares both unit and case price. Delete the image, vision and Anthropic code and the Squarespace and old-domain references. Update wrangler vars, README and the status route.

## Design

Each scheduled run (after the working-hours and daily-skip gates) loads the stored Shopify session. It fetches /pages/wholesale with the cookie, or uses the browser with the cookie injected if S1 shows the list needs JavaScript. It checks that the session is still logged in, parses the HTML into sections keyed by page heading, then diffs against the schema 2 snapshot per section on unit and case price. Changes go out through the existing Pushover path. Refreshed cookies are saved to KV. Any session, load or parse failure sends an error alert and leaves the snapshot as it was.

### Components
| Name | Responsibility | Location |
| --- | --- | --- |
| session | Read session (KV session, fallback secret POKEHIVE_SESSION_COOKIE), authenticated page load, logged-in check, write back refreshed cookies | src/session.ts |
| parser | parseWholesale(html) to Catalog with validation, no I/O | src/parse.ts |
| runCheck | Baseline by schema, per-section diff, notify, save | src/index.ts |
| config and docs | SOURCE_URL var, removed vars and secrets, renewal how-to | wrangler.jsonc, README.md |

### Contracts (freeze before dependent work)

- **C1 Env bindings** (config): Keep SNAPSHOTS, PUSHOVER_USER_KEY, PUSHOVER_APP_TOKEN, PUSHOVER_ERROR_APP_KEY, SOURCE_URL (https://www.thepokehive.com/pages/wholesale), DEFAULT_TIMEZONE. Add the secret POKEHIVE_SESSION_COOKIE. Remove ANTHROPIC_API_KEY, POKEHIVE_EMAIL, POKEHIVE_PASSWORD and LOGIN_URL. Remove BROWSER and @cloudflare/puppeteer unless S1 shows the list is rendered by JavaScript.
- **C2 StoredState schema 2** (data): KV key state: { schema: 2, fetchedAt: ISO string, lastChangeDate?: YYYY-MM-DD, lastErrorAlert?: { step, date }, sections: Record<heading, Record<name, { name, contents, unitPrice: number, casePrice: number or null }>> }. Read rules: null means first run (baseline). A legacy object with mainList and preOrders and no schema means a migration baseline. A schema 2 object is used as is. Any other shape, or a KV read error, is a step-state error: alert and stop, never baseline. KV key session holds { cookie, secretHash }, where secretHash is a SHA-256 of the POKEHIVE_SESSION_COOKIE secret it was derived from.
- **C3 parseWholesale** (function): parseWholesale(html: string): Catalog, synchronous and pure. It uses a pure-JavaScript HTML parser that runs both in Workers and in Node vitest (library chosen in S1, for example node-html-parser), not HTMLRewriter. It returns sections keyed by heading in page order. It throws ParseError on zero sections, zero rows, or a row whose unit price is not a finite number. The browser fallback passes page.content() to the same function.
- **C4 Failure steps** (alert): Error alerts name one step: session (logged-out page or redirect; includes renewal steps), page-load (non-2xx or network), parse (ParseError), suspect (partial-parse guard tripped), state (unreadable snapshot), delivery (Pushover failed). Each step alerts at most once per Eastern date, tracked in lastErrorAlert. The snapshot and session are never written on any failure. A later successful run clears lastErrorAlert.

### Data

Migration happens by baseline. A legacy snapshot (mainList and preOrders) is detected explicitly, not read, and then replaced. lastChangeDate is cleared at baseline so checks are not skipped on deploy day. Session precedence: if the SHA-256 of the current secret differs from the secretHash stored in KV, the owner has renewed the secret. The secret then wins and replaces the KV session. Otherwise the KV session (the rolled-forward cookie) is used.

### UX

Alerts keep the current format, grouped by the page's section headings. Price lines show unit and case price changes. The restart message lists counts per section. The session-expired alert says exactly how to renew the cookie.

### Security and privacy

The session cookie is a bearer credential. It lives only in the Worker secret and the KV key session, and is never logged or put in alerts. Requests use redirect manual, so the Cookie header is never forwarded to another host. A 3xx response counts as a session failure, and the cookie is sent only to www.thepokehive.com. Refreshed cookies are written to KV only after the logged-in check and parse both pass, and only Set-Cookie values for the PokeHive host are merged. Keep the old secrets until the new watcher has run cleanly for a week, then remove the password and Anthropic secrets from Cloudflare.

### Observability

console.log a one-line summary per run (step, section counts, change count), never cookie values. The / status route shows the last check and per-section counts.

### Rollout and rollback

S1 runs only locally under wrangler dev and is never deployed. Then deploy and hit /run once to take the baseline and confirm the restart message. Watch wrangler tail for a day. Rollback means redeploying the previous new-format commit. The old Squarespace code cannot resume service because that site and login are gone, so rollback to it is not an option. Keep the old secrets for a week as a safety margin only.

## Test strategy

- **Unit:** vitest on parseWholesale with a sanitised fixture of the logged-in page: section count, row count, prices, case price null. Also an empty-page and garbled-price ParseError case. Unit tests for the per-section diff on unit and case price.
- **Integration:** wrangler dev: /run with a valid cookie gives the baseline; second /run reports no changes; an invalid cookie gives the session alert and leaves KV unchanged.
- **Manual:** After deploy: confirm the restart message counts match the page, and the /test-error-alert route still works. Edit one stored price in KV and confirm one price-change alert.
- **Non-functional:** Run time under 10 seconds with fetch (or within the Browser Rendering cap with the fallback); typecheck passes with tsc --noEmit

## Risks

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| K1 | Shopify ties the session to device or IP, or bot protection blocks Worker requests, so the copied cookie fails from Cloudflare | medium | high | S1 is a go or no-go gate with exit criteria, including a cookie replay from the Worker after 24 hours. If it fails, stop and re-plan (for example, ask PokeHive for a feed or an export link). |
| K2 | The session expires often, causing frequent manual renewals | medium | medium | Rolling Set-Cookie refresh to KV; a clear renewal alert; README how-to |
| K3 | The list is rendered by JavaScript and absent from the raw HTML | medium | medium | Browser fallback with cookie injection, decided in S1 |
| K4 | A markup change parses to empty or partial data and causes a false mass removal | medium | high | ParseError on empty or invalid rows, a partial-parse guard against the previous snapshot, no save on any failure, and a fixture test |
| K5 | The session cookie leaks through logs or alerts | low | high | Never log cookie values; review in code review; only send it to the PokeHive host |
| K6 | A legitimate large change (a whole section retired or a big restock rotation) trips the partial-parse guard and suppresses a real alert | low | medium | The guard alert lists the counts. The owner confirms the change and hits /run?accept=1 to save the new state as a baseline, which is added in S4. |

## Delivery slices

| ID | Slice | Depends on | ACs | Contracts | Risk | Size | Draft paths |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Session feasibility spike (go or no-go) and contracts: Locally under wrangler dev only, never deployed: the owner captures the Shop session cookie, and a spike route fetches SOURCE_URL with it (redirect manual). Exit criteria: (1) the list is present in the response, in the raw HTML or after browser render; (2) the same cookie still works from the Worker after at least 24 hours; (3) whether Set-Cookie rolls the session forward. Save a sanitised HTML fixture. Pin the positive logged-in marker (list container present and no login form) and the section and row selectors. Choose the HTML parser library and fix C1 to C4. If (1) or (2) fails, stop and re-plan. |  | AC1 | C1, C2, C3, C4 | R3 | S | test/fixtures/wholesale.html |
| S2 | Pure parser with fixture tests: parseWholesale returns sections and rows from the fixture with the chosen pure parser, and throws ParseError on empty or invalid input. Add a partial-parse guard function covering a missing section, more than 50 percent row loss in a section, and a total drop over 30 percent. Add vitest and typecheck scripts. | S1 | AC2, AC5 | C3 | R1 | M | src/parse.ts, test/parse.test.ts, package.json |
| S3 | Session load, expiry check and rolling refresh: Authenticated page load with redirect manual (fetch, or the browser fallback per S1). Positive logged-in check using the S1 marker. Session precedence by secretHash. Refreshed cookies saved to KV only after a passing check and parse. Session alert with renewal steps, deduped per step per day. | S1 | AC1 | C1, C4 | R3 | M | src/session.ts, src/index.ts |
| S4 | Schema 2 state, baseline and per-section diff: runCheck uses schema 2 with explicit read rules: null or legacy means a baseline with a restart message, an unknown shape or read error means a state alert. Per-section diff on unit and case price. Partial-parse guard before any save. No save on any failure. lastErrorAlert dedupe. Status route updated. | S2, S3 | AC3, AC4, AC5 | C2, C4 | R2 | M | src/index.ts |
| S5 | Remove image, vision and old-site code and update docs: Delete the image and vision code and ANTHROPIC_API_KEY, the old login and LOGIN_URL, and Puppeteer plus BROWSER if unused. Update wrangler vars and the README secrets, URLs and renewal how-to. | S4 | AC6 | C1 | R2 | S | src/index.ts, wrangler.jsonc, package.json, README.md |

## Open questions

| ID | Question | Owner | Blocking |
| --- | --- | --- | --- |
| Q1 | How long does a Shop session last, and does Set-Cookie refresh it? | implementer, answered in S1 | no |
| Q2 | Should the uncommitted changes in README.md and src/index.ts be committed or kept before implementation starts? | Trevor | no |

## Critic pre-mortem

Passes: 1. Verdict: sound with fixes

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F1 | high | The whole design rests on D10 (planner-assumption): a cookie copied from DevTools stays valid when replayed from Cloudflare egress, and Set-Cookie rolls it forward. Shopify customer-account and Shop sign-in sessions commonly use HttpOnly, device-bound tokens with short-lived access tokens, and Worker egress often scores badly with bot protection. The user decided D1 and D7 (login stays, Shop SSO), but never accepted a manual-renewal architecture. AC1 and Goal 1 read as unattended ('Log into the new Shopify site'), while D10 means a human renews the cookie on some unknown cadence (Q1, K2). The S1 spike is a good gate, but only a single fetch from a Worker proves little about lifetime. Q1 is marked non-blocking even though renewal cadence decides whether the feature is viable. | Plan changed: S1 is now an explicit go or no-go gate with exit criteria (list present, a cookie replay from the Worker works after 24 hours, Set-Cookie behaviour). On failure the plan stops and is re-planned. D10 stays an assumption for the user to confirm. |
| F2 | high | The parser contract C3 is incoherent. `parseWholesale(html: string): Catalog` is a pure synchronous function, but the S1 text and O3 lineage point to HTMLRewriter, which is a streaming Workers-only API that is async and cannot run in plain Node vitest (D9). The browser fallback (K3) would extract rows via page.evaluate instead, which is a different code path. No HTML parser dependency is chosen. The tested fixture parser and the production parser can diverge, so D9's main safety net (the fixture test) may not test what runs. Sections need document-order walking across headings and rows, which is awkward in HTMLRewriter. | Plan changed: C3 is synchronous and pure, uses a pure-JavaScript HTML parser that runs in Workers and Node, and does not use HTMLRewriter. The browser fallback passes page.content() to the same function. |
| F3 | high | Rolling-refresh session storage (C2, S3) has several unspecified integrity hazards. (a) The Worker prefers KV `session` over the secret, so when the owner renews the secret after an expiry alert, a stale KV value silently wins and the renewal appears not to work. (b) `session` is stored as a Cookie header string, which loses expiry, domain and path, so merging Set-Cookie into it is undefined and the earlier 'under 3 days' expiry warning from O2 cannot be built. (c) Shopify sets anonymous session cookies on every response, including logged-out ones. Writing back from any response that is not verified as logged in could overwrite good auth cookies with anonymous ones. (d) `/run` and the cron can run concurrently, and KV is eventually consistent, so last-writer-wins can drop the newer cookie. | Plan changed: the KV session stores the secretHash of its source secret, and a changed secret wins. Write-back happens only after the check and parse pass, merging only PokeHive-host Set-Cookie values. Nothing is written on failure. |
| F4 | high | K4 and AC5 guard only against zero rows or zero sections. A partial parse is more likely and is not guarded: a lazy-loaded or truncated list, a section whose markup changed, or a renamed heading yields a valid-looking catalog. The diff then reports mass removals or a burst of removed and added products, and the snapshot advances, so the wrong data becomes the baseline. Keying by heading means a heading rename shows as every product removed and re-added. C3 also omits the duplicate-name check that O2 had, and `Record<name,...>` silently collapses duplicate names within a section, so a repriced duplicate is lost. | Plan changed: AC5 and S2 or S4 add a partial-parse guard (missing section, more than 50 percent loss in a section, more than 30 percent total drop). Risk K6 adds an accept override for legitimate big changes. |
| F5 | medium | The bearer cookie is sent via fetch with a manually set Cookie header. The plan does not state `redirect: 'manual'` for the chosen option (only O3 does). When the session expires, Shopify redirects to a login or Shop SSO host, and Workers fetch may carry the custom Cookie header across a cross-origin redirect, so the member cookie could be sent to a third-party host. K5 says 'only sent to www.thepokehive.com' but no contract enforces it. Separately, `/run` (src/index.ts:625) is unauthenticated and triggers runCheck, which would also write refreshed cookies to KV and send alerts to anyone who finds the workers.dev URL. The plan keeps these routes unchanged. | Fixed: redirect manual is required, 3xx counts as a session failure, and the cookie is sent only to the PokeHive host. |
| F6 | medium | The logged-in check is under-specified. A Shopify-gated page often returns HTTP 200 with a 'sign up or log in' body instead of a redirect, which matches the evidence ('Sign up or log in' landing text). The plan says 'redirect, or missing list marker', but the marker is not defined in C4. If the check fails to separate logged-out from parse breakage, the user gets 'parse' alerts that say nothing about renewing the cookie, or the reverse, a 'session' alert for a real markup change. The ordering of the session check and the ParseError path is not stated. | Fixed: the positive logged-in marker (list container present and no login form) is pinned in S1 and used in S3. |
| F7 | medium | Error-alert behaviour for a persistent failure is unspecified. The cron runs hourly in working hours (wrangler.jsonc cron `0 * * * *`), and an expired session fails every run. AC1 says 'one error alert', but nothing dedupes, so the owner is paged every hour until they renew, or the alerts become noise and get muted. The once-a-day skip only applies after a notified change, not after errors. The proactive expiry warning that would prevent a gap in monitoring was dropped from O4 (O2 had it), so detection only happens after changes may already have been missed, which matters for a time-sensitive wholesale-deal watcher. | Fixed: lastErrorAlert dedupes to one alert per step per Eastern date, and a success clears it (C4, AC1). |
| F8 | medium | Slice order and verifiability have gaps. S3 and S4 both rewrite src/index.ts, and S1 puts a throwaway route in src/index.ts of the production Worker, which risks a deployed route that holds the cookie. The vitest and tsc infrastructure (D9) is added in S2 but covers behaviour in S3 and S4 (session handling and the per-section diff) that has no stated test files; test strategy lists 'unit tests for the per-section diff', but no slice's draft_paths includes them. S1 is marked R3, with spike code intended to be thrown away. The overall plan also needs the sanitised fixture committed, which will contain member-only wholesale pricing in git. | Fixed: the spike runs only locally and is never deployed, and its draft path no longer touches src/index.ts. S4 already depends on S3, so the index.ts edits are sequential. |
| F9 | medium | AC3 and the migration rely on `schema !== 2` meaning 'old snapshot', but C2 also says 'any other shape is treated as no baseline'. A transient KV read failure or a corrupted value would silently trigger a baseline and a 'watch restarted' message, discarding the diff for any real change in that window. The status route at src/index.ts:630-636 reads `stored.mainList.products` and would throw on a schema 2 state, so the S4 route update is critical, but there is no acceptance check for `/`. AC4 does not cover first-run edge cases: price changing from absent to present case price, null vs 0, currency formats and whitespace in names. | Fixed: C2 read rules separate first run, legacy migration, schema 2, and unknown shape or read error. The last case raises a state alert and never baselines. |
| F10 | low | Rollback is weaker than stated. 'Redeploy the previous commit' targets the old site code, whose login and domain (thepokehivewholesale.com) are gone, so it cannot actually resume service, and S5 removes the old secrets from Cloudflare, which ends any practical rollback. The success metric 'a scheduled run finishes with one login plus one page load' no longer matches the design. Also, accessibility is empty, which is fine for a Pushover-only app but should be stated as not applicable. Q2 (uncommitted README.md and src/index.ts edits) is non-blocking, yet S3 to S5 edit those same files, so work could be lost or conflict. | Fixed: rollout now says rollback is only to a previous new-format commit, and old secrets are kept a week only as a margin. |

## Hand-off

A verified-diamond draft DAG with 5 task(s) and 4 contract(s) to freeze first is embedded in plan.json under `handoff.verified_diamond` (plan hash `0e81bbd95b2901ba`).
