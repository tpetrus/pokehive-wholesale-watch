# pokehive-wholesale-watch

Cloudflare Worker that checks [The Pokehive](https://www.thepokehive.com)'s
members-only wholesale list every hour, 10am-8pm Eastern on weekdays, and
pushes a [Pushover](https://pushover.net) notification when a product is added,
removed, or has a price or unit change. Once a change is found and successfully
notified, the rest of that day's checks are skipped (hourly checks resume the
next day).

## How it works

The wholesale list is served as JSON by a Shopify app-proxy endpoint:

```
GET https://www.thepokehive.com/apps/wholesale/list
```

No HTML parsing and no browser are involved. The Worker sends one request with
your logged-in session cookie and reads the response:

- Logged in: `showPrices: true` and real prices (integer cents).
- Logged out: the same list, but `showPrices: false` and every price `0`. The
  Worker treats this as an expired session and never compares it against the
  stored snapshot.

The list has 6 sections (categories), such as "English Pokémon". Each item has a
unique `id`, a `name`, a `unit` (Pack, Case, Display, Box), a `price`, and an
optional note. Names are not unique within a section (the same name can appear
as both a Case and a Display), so items are tracked by `id`.

### Change detection

Changes are computed per section, by `id`:

- **Added**: an `id` that was not in the section before.
- **Removed**: an `id` that is no longer in the section.
- **Changed**: same `id`, but `price` or `unit` differs.

Note, badge, stock-left and minimum-quantity changes do not alert. A product
whose `id` moves between sections is reported as removed from one and added to
the other. The alert is one Pushover message (split on line boundaries into
parts if over 1024 characters), grouped by section heading, with NEW, PRICE
CHANGES and REMOVED blocks. Example:

```
💰 PRICE CHANGES (1)
English Pokémon
• 30th Celebration Booster Bundle
   $1,500.00 → $1,550.00 / Case  (↑ $50.00) · $62.00 per unit
```

The first run (and the first run after upgrading from the old image-based
snapshot) stores a baseline and sends exactly one "watch restarted" message with
the item count per section. It sends no added/removed alerts.

### Failure steps

Every failure is classified into one step and sent under the separate failure
Pushover app (`PUSHOVER_ERROR_APP_KEY`) at high priority with the siren sound.
Each step alerts at most once per Eastern date. A later successful run clears
that record. A failure never overwrites the stored snapshot.

| Step | Meaning |
| --- | --- |
| `session` | The response was the logged-out view, or the server redirected. Renew the cookie (below). The alert includes the renewal steps. |
| `page-load` | Non-2xx response, network error, or a body that is not JSON. HTTP 429, 5xx and network errors are retried up to 3 times (4 attempts, honoring `Retry-After`, about 35s of backoff by default) before alerting. |
| `parse` | The JSON did not have the expected shape. |
| `suspect` | The result looks partial versus the last snapshot: a previously seen section is missing, any section lost more than 50% of its items, or the total dropped by more than 30%. The alert lists the counts. If the change is real, hit `/run?accept=1` (with the run key). |
| `state` | The stored snapshot is unreadable (KV error or unrecognized shape). The Worker stops rather than re-baselining. |
| `delivery` | Pushover rejected the change alert. The snapshot is not advanced, so the same changes are re-detected and re-sent on the next run. |

An unhandled crash in a scheduled run sends a "check crashed" alert.

## Required secrets

Set these yourself via `wrangler secret put <NAME>` (never commit them, never
paste them into chat; the prompt is masked and only you see the value):

```
wrangler secret put POKEHIVE_SESSION_COOKIE  # full Cookie request header, see below
wrangler secret put PUSHOVER_USER_KEY        # your user key, from the Pushover dashboard
wrangler secret put PUSHOVER_APP_TOKEN       # API token of an app created at pushover.net/apps/build
wrangler secret put PUSHOVER_ERROR_APP_KEY   # API token of a second app, used only for failure alerts
wrangler secret put RUN_KEY                  # long URL-safe random string (e.g. openssl rand -hex 32); required by /run and /test-error-alert
```

The cookie is sent only to the host of `SOURCE_URL`, with redirects disabled. It
is never logged, never included in an alert, and never stored in KV.

### Capturing and renewing the cookie

1. Use a dedicated browser profile for this, and sign in to
   www.thepokehive.com with Shop. Do not log out afterward: logging out
   invalidates the session.
2. Open DevTools, go to the Network tab, and reload the site.
3. Click any request to `www.thepokehive.com` and copy the **full `Cookie`
   request header value** (all cookies, not a single one).
4. Run `wrangler secret put POKEHIVE_SESSION_COOKIE` and paste the value.

Renew the same way when a `session` alert arrives.

## Notifications

Alerts go through the [Pushover](https://pushover.net) app.
Messages are capped at 1024 characters, so long change lists are split into
several messages titled "(1/3)", "(2/3)", and so on.

Pushover replaced ntfy.sh because ntfy rate-limits by source IP, and
Cloudflare Workers share egress IPs, so the shared quota was exhausted and the
Worker's alerts were rejected with 429 even when authenticated.

## Develop

```
npm install
npm run dev      # local dev server
npm run build    # bundle without deploying (wrangler deploy --dry-run); the verification gate
npm run deploy   # deploy to Cloudflare
npm run tail     # stream logs from the deployed worker
```

## Endpoints

- `GET /` — status: last check time and item counts per section.

`/run` and `/test-error-alert` require the `RUN_KEY` secret, sent as an
`Authorization: Bearer <key>` header (preferred, e.g.
`curl -H "Authorization: Bearer $RUN_KEY" https://<worker>/run`) or as `?key=<key>`
for use in a browser. A key in the URL can end up in browser history and request
logs, so prefer the header. If an `Authorization: Bearer` header is present it is used and
`?key=` is ignored. Without `RUN_KEY` set, both routes return 503.

- `GET /run` — manually trigger a check (same logic as the cron; sends real notifications and updates the snapshot).
- `GET /run?accept=1` — same, but if the partial-list guard (`suspect`) trips, save the current list as the new baseline. It never saves on a session, parse or page-load failure.
- `GET /test-error-alert` — send a test alert through the failure-alert channel (separate Pushover app, high priority).

## Storage

In the `SNAPSHOTS` KV namespace:

- `state` — the latest snapshot (schema 2): fetch time, the Eastern date of the
  last notified change, and the items of each section keyed by `id`.
- `lastErrorAlert` — `{ date, steps }`: the failed steps already alerted on that Eastern
  date, used to alert at most once per step per Eastern date. Deleted on the next successful
  run.
