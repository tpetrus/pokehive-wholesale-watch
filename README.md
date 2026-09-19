# pokehive-wholesale-watch

Cloudflare Worker that checks
[thepokehivewholesale.com](https://www.thepokehivewholesale.com/member-site-homepage-2-2-1)'s
member-only wholesale list every hour, 10am-8pm Eastern on weekdays, and
pushes a [Pushover](https://pushover.net) notification when a product is added,
removed, or has a price change — across the main wholesale list and the
Pre-Orders section.

## Why this one looks different from `wholesale-pokemon-watch`

This site is nothing like the other watcher:

- **Real password login.** The site's member auth runs through Squarespace's
  own client-side JS against an undocumented internal endpoint (no stable
  API to call directly), so this Worker drives an actual headless browser
  ([Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/)
  via `@cloudflare/puppeteer`) to log in like a real user: fill
  `#login-email` / `#login-password`, click the submit button, wait for
  navigation.
- **The product list is a picture, not text.** The "Today's list" and
  "Pre Orders" tables aren't HTML — they're screenshots (PNGs) the site
  owner uploads manually, e.g. `Screenshot+2026-09-11+094720.png`. There's
  nothing to regex-parse. Reading them requires vision: this Worker sends
  the image to the Claude API and asks for structured JSON back.
- **The browser's job ends early.** The list images turn out to be
  publicly fetchable once you know the URL (Squarespace's CDN doesn't gate
  by cookie — only the *page* that reveals the URL is login-gated). So
  Puppeteer is only used for login + finding the current image URLs; the
  actual image download and Claude API call happen over plain `fetch`,
  after the browser is already closed. This keeps Browser Rendering usage
  (capped at 10 min/day on the Workers Free plan) to just login+navigate.

### Page layout (as of the site's current design)

The member page has 4 large images, in DOM order:

1. Main wholesale list, part 1
2. Main wholesale list, part 2 (sometimes a stale/reused screenshot from a
   prior day if that half of the list didn't change)
3. **Pre-Orders** table — but the same screenshot also contains the start
   of an out-of-scope "Chinese"/Gem/Jumbo section beneath it, so the
   extraction prompt for this image explicitly tells Claude to extract
   only the Pre-Orders rows and ignore the rest.
4. More of the Chinese/Jumbo section — out of scope, not read at all.

If the site's layout changes (more/fewer images, sections reordered),
`discoverImages` in `src/index.ts` will need updating — it currently
assumes this fixed order.

### Change detection

Each image's filename encodes its upload timestamp. Every run, the Worker
compares the current filenames against what's stored in KV from the last
run:

- Unchanged → reuse the stored catalog for that section, skip the Claude
  call entirely. This is the common case and keeps API spend near zero.
- Changed → download the image and re-extract via Claude vision.

The main list's two images are treated as one combined catalog (if either
half's image changed, both are re-extracted and merged) since a product
could shift between the two screenshots as the list grows or shrinks.

### Failure modes

- **Login fails** (selector missing, still on the login page after
  submit): sends a distinct "login failed" notification rather than
  failing silently — likely a credential problem or the site changed its
  login form.
- **Extraction fails** (Claude's response isn't parseable JSON, image
  download fails, or zero products come back): sends a distinct
  "extraction failed" notification and skips diffing that section for the
  run, without crashing the whole check.
- **Check crashes** (unhandled error in a scheduled run): sends a
  "check crashed" notification.
- **Delivery fails** (Pushover rejects the change alert): the snapshot is
  *not* advanced, so the same changes are re-detected and re-sent on the
  next run, and a "notification failed" alert is attempted.

All failure alerts are sent at Pushover high priority with the siren sound so
they stand out from normal list updates.

## Notifications

Alerts go through the [Pushover](https://pushover.net) app on your phone.
Messages are capped at 1024 characters, so long change lists are split into
several messages titled "(1/3)", "(2/3)", and so on.

Pushover replaced ntfy.sh because ntfy rate-limits by source IP, and
Cloudflare Workers share egress IPs — the shared quota was exhausted, so the
Worker's alerts were rejected with 429 even when authenticated (a free ntfy
account is still IP-based: `"basis":"ip"`).

## Required secrets

Set these yourself via `wrangler secret put <NAME>` (never commit them,
never paste them into chat — the prompt is masked and only you see the
value):

```
wrangler secret put POKEHIVE_EMAIL
wrangler secret put POKEHIVE_PASSWORD
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put PUSHOVER_USER_KEY    # your user key, from the Pushover dashboard
wrangler secret put PUSHOVER_APP_TOKEN   # API token of an app created at pushover.net/apps/build
```

`ANTHROPIC_API_KEY` is a real Anthropic API key from
[console.anthropic.com](https://console.anthropic.com/) — separate from a
Claude subscription — used to pay for the vision extraction calls
(model: `claude-opus-5`). Cost is low in practice since extraction only
runs when a tracked image's filename actually changes.

## Develop

```
npm install
npm run dev      # local dev server (uses real Browser Rendering + a real login)
npm run deploy   # deploy to Cloudflare
npm run tail     # stream logs from the deployed worker
```

## Endpoints

- `GET /` — status: last check time + product counts per section.
- `GET /run` — manually trigger a check (same logic as the cron; sends real notifications and updates the snapshot).

## Storage

A single JSON blob (`state`) in the `SNAPSHOTS` KV namespace holds the
most recent catalog + image filenames for both the main list and
Pre-Orders sections.
