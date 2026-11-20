// Pure, synchronous wholesale-list logic: parsing, the partial-parse guard,
// diffing and alert formatting. No Env access, no I/O.

export interface WholesaleItem {
  id: string;
  name: string;
  /** "Pack" | "Case" | "Display" | "Box" | other free text. */
  unit: string;
  /** Integer cents, > 0. */
  price: number;
  /** e.g. "$60.00", parsed from a note like "25 units per case · $60.00 per unit". */
  perUnit?: string;
  note?: string;
}

/** heading -> id -> item, headings in page order. */
export type Catalog = Record<string, Record<string, WholesaleItem>>;

export interface StoredState {
  schema: 2;
  /** ISO timestamp. */
  fetchedAt: string;
  /** YYYY-MM-DD in DEFAULT_TIMEZONE; scheduled checks are skipped for the rest of that date. */
  lastChangeDate?: string;
  sections: Catalog;
}

export type FailureStep = "session" | "page-load" | "parse" | "suspect" | "state" | "delivery";

export class ParseError extends Error {}
/** The response is the logged-out view (cookie missing, expired or rejected). */
export class SessionError extends Error {}

const PER_UNIT_RE = /\$[\d,]+\.\d{2}(?= per unit)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseWholesale(doc: unknown): Catalog {
  if (!isRecord(doc)) throw new ParseError("Response is not a JSON object");
  if (doc.showPrices !== true) {
    throw new SessionError("Response is the logged-out view (showPrices is not true)");
  }
  if (doc.ok !== true) throw new ParseError("Response ok is not true");
  const list = doc.list;
  if (!isRecord(list) || !Array.isArray(list.categories) || list.categories.length === 0) {
    throw new ParseError("list.categories is missing or empty");
  }

  const catalog: Catalog = {};
  for (const cat of list.categories as unknown[]) {
    if (!isRecord(cat) || typeof cat.name !== "string" || cat.name === "") {
      throw new ParseError("A category has no name");
    }
    if (!Array.isArray(cat.items) || cat.items.length === 0) {
      throw new ParseError(`Category "${cat.name}" has no items`);
    }
    const section: Record<string, WholesaleItem> = catalog[cat.name] ?? {};
    for (const raw of cat.items as unknown[]) {
      if (
        !isRecord(raw) ||
        typeof raw.id !== "string" ||
        typeof raw.name !== "string" ||
        typeof raw.unit !== "string"
      ) {
        throw new ParseError(`Category "${cat.name}" has an item without a string id/name/unit`);
      }
      if (typeof raw.price !== "number" || !Number.isFinite(raw.price) || raw.price <= 0) {
        throw new ParseError(`Item ${raw.id} in "${cat.name}" has an invalid price`);
      }
      const item: WholesaleItem = {
        id: raw.id,
        name: raw.name,
        unit: raw.unit,
        price: raw.price,
      };
      if (typeof raw.note === "string" && raw.note !== "") {
        item.note = raw.note;
        const m = PER_UNIT_RE.exec(raw.note);
        if (m) item.perUnit = m[0];
      }
      section[raw.id] = item;
    }
    catalog[cat.name] = section;
  }
  return catalog;
}

export function countItems(catalog: Catalog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [heading, items] of Object.entries(catalog)) out[heading] = Object.keys(items).length;
  return out;
}

export function totalItems(catalog: Catalog): number {
  return Object.values(countItems(catalog)).reduce((a, b) => a + b, 0);
}

/**
 * Partial-parse guard versus the previous schema-2 snapshot. Returns a
 * description of what tripped, or null when the result looks complete.
 */
export function suspectReason(previous: Catalog, current: Catalog): string | null {
  const prevCounts = countItems(previous);
  const curCounts = countItems(current);
  const reasons: string[] = [];

  for (const [heading, prev] of Object.entries(prevCounts)) {
    const cur = curCounts[heading];
    if (cur === undefined) {
      reasons.push(`section "${heading}" is missing (was ${prev} items)`);
    } else if (cur < prev * 0.5) {
      reasons.push(`section "${heading}" dropped from ${prev} to ${cur} items`);
    }
  }
  const prevTotal = Object.values(prevCounts).reduce((a, b) => a + b, 0);
  const curTotal = Object.values(curCounts).reduce((a, b) => a + b, 0);
  if (curTotal < prevTotal * 0.7) {
    reasons.push(`total dropped from ${prevTotal} to ${curTotal} items`);
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

export interface SectionDiff {
  heading: string;
  added: WholesaleItem[];
  removed: WholesaleItem[];
  changed: Array<{ from: WholesaleItem; to: WholesaleItem }>;
}

/** Per-section diff by id. Only sections with at least one change are returned. */
export function diffCatalogs(previous: Catalog, current: Catalog): SectionDiff[] {
  const headings = [...Object.keys(current)];
  for (const h of Object.keys(previous)) if (!headings.includes(h)) headings.push(h);

  const out: SectionDiff[] = [];
  for (const heading of headings) {
    const prev = previous[heading] ?? {};
    const cur = current[heading] ?? {};
    const d: SectionDiff = { heading, added: [], removed: [], changed: [] };
    for (const [id, item] of Object.entries(cur)) {
      const p = prev[id];
      if (!p) d.added.push(item);
      else if (p.price !== item.price || p.unit !== item.unit) d.changed.push({ from: p, to: item });
    }
    for (const [id, item] of Object.entries(prev)) if (!cur[id]) d.removed.push(item);
    if (d.added.length || d.removed.length || d.changed.length) out.push(d);
  }
  return out;
}

export function countChanges(diffs: SectionDiff[]): number {
  return diffs.reduce((n, d) => n + d.added.length + d.removed.length + d.changed.length, 0);
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function perUnitSuffix(item: WholesaleItem): string {
  return item.perUnit ? ` · ${item.perUnit} per unit` : "";
}

/** Formats NEW / PRICE CHANGES / REMOVED blocks, each grouped by section heading. */
export function formatDiff(diffs: SectionDiff[]): string {
  const blocks: string[] = [];

  const block = (
    title: string,
    count: number,
    linesFor: (d: SectionDiff) => string[],
  ): void => {
    if (count === 0) return;
    const parts: string[] = [];
    for (const d of diffs) {
      const lines = linesFor(d);
      if (lines.length > 0) parts.push(`${d.heading}\n${lines.join("\n")}`);
    }
    blocks.push(`${title} (${count})\n${parts.join("\n")}`);
  };

  block(
    "🆕 NEW",
    diffs.reduce((n, d) => n + d.added.length, 0),
    (d) => d.added.map((i) => `• ${i.name}\n   ${money(i.price)} / ${i.unit}${perUnitSuffix(i)}`),
  );
  block(
    "💰 PRICE CHANGES",
    diffs.reduce((n, d) => n + d.changed.length, 0),
    (d) =>
      d.changed.map(({ from, to }) => {
        let line: string;
        if (from.unit === to.unit) {
          line = `${money(from.price)} → ${money(to.price)} / ${to.unit}`;
        } else {
          line = `${money(from.price)} / ${from.unit} → ${money(to.price)} / ${to.unit}`;
        }
        if (to.price !== from.price) {
          const arrow = to.price > from.price ? "↑" : "↓";
          line += `  (${arrow} ${money(Math.abs(to.price - from.price))})`;
        } else {
          line += "  (unit changed)";
        }
        return `• ${to.name}\n   ${line}${perUnitSuffix(to)}`;
      }),
  );
  block(
    "❌ REMOVED",
    diffs.reduce((n, d) => n + d.removed.length, 0),
    (d) => d.removed.map((i) => `• ${i.name} (${i.unit})`),
  );

  return blocks.join("\n\n");
}

/** Per-section item counts, one line each, for baseline and status messages. */
export function formatCounts(catalog: Catalog): string {
  return Object.entries(countItems(catalog))
    .map(([heading, n]) => `• ${heading}: ${n}`)
    .join("\n");
}
