// lib/uline-manifest.mts
//
// PARSER for the nightly ULINE FREIGHT REPORT ("SHIPMENTS BY SHIPTO ZIP W/IN
// STATE SHIPPED ON"). This is the shipper's own statement of what it handed us,
// so it is the only independent check on whether an order NuVizz never received
// is quietly missing from the board.
//
// It is a TEXT-LAYER PDF, not a scan. That matters: the Estes bulk-add path pays
// for an Anthropic vision call per document because those manifests arrive as
// faxes. This one carries real text with real coordinates, so parsing it costs
// NOTHING — no AI call, no NuVizz call. Pure arithmetic on the bytes.
//
// Row layout:
//   DATE SHIPPED | VIA | WHS | ZIP CODE | CUST NAME | CITY | ST | LBS | SKID | PIECE | PRO # | TRAILER # | RTG
// and the document closes with its own checksum:
//   FINAL TOTALS ----> COUNT: 660 | 359,769 | 1,019 | 310
//
// ZERO network calls of any kind. Pure, unit-tested.

import { inflateSync } from 'node:zlib';

export interface PdfCell { page: number; x: number; y: number; text: string }

export interface UlineRow {
  shipDate: string | null;
  via: string | null;
  whs: string | null;
  zip: string | null;
  custName: string | null;
  city: string | null;
  state: string | null;
  lbs: number;
  skids: number;
  pieces: number;
  pro: string;
}

export interface UlineTotals { count: number; lbs: number; skids: number; pieces: number }

export interface UlineManifest {
  rows: UlineRow[];
  totals: UlineTotals | null;
  /** True only when the parsed rows reproduce the document's own FINAL TOTALS on all four numbers. */
  verified: boolean;
  warnings: string[];
  columns: Array<{ lo: number; hi: number; n: number }>;
}

const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2}$/;
const PRO_RE = /^\d{9}$/;
const NUM_RE = /^[\d,]+$/;
// Freight columns sit ~184 text-units apart and each column's values cluster far
// tighter than that, so any gap wider than this starts a new column.
const COL_GAP = 120;

const toNum = (v: any): number => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ── text extraction WITH coordinates ─────────────────────────────────────────
// Every cell is drawn by a relative `Td` inside a BT/ET block, so tracking the
// text-line origin gives each string a real x. Coordinates are not a nicety
// here: the freight numbers are RIGHT-aligned, so reading them by their order in
// the token stream silently swaps SKID and PIECE on any row whose SKID column is
// blank — which is every loose-only order.
export function pdfCells(buf: Uint8Array | Buffer): PdfCell[] {
  const s = Buffer.from(buf).toString('latin1');
  const streams: string[] = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const raw = Buffer.from(m[1], 'latin1');
    let t: string;
    try { t = inflateSync(raw).toString('latin1'); } catch { t = raw.toString('latin1'); }
    if (/\bTj\b/.test(t)) streams.push(t);
  }
  const cells: PdfCell[] = [];
  let page = 0;
  for (const st of streams) {
    page++;
    let x = 0, y = 0;
    const tok = /BT|ET|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let g: RegExpExecArray | null;
    while ((g = tok.exec(st))) {
      const w = g[0];
      if (w === 'BT') { x = 0; y = 0; continue; }
      if (w === 'ET') continue;
      if (g[5] !== undefined) { x = Number(g[5]); y = Number(g[6]); continue; }   // Tm — absolute
      if (g[7] !== undefined) { x += Number(g[7]); y += Number(g[8]); continue; } // Td/TD — relative
      if (g[9] !== undefined) {
        const text = g[9].replace(/\\([()\\])/g, '$1').trim();
        if (text) cells.push({ page, x, y, text });
      }
    }
  }
  return cells;
}

// ── the manifest itself ──────────────────────────────────────────────────────

export function parseUlineManifest(cells: PdfCell[]): UlineManifest {
  const warnings: string[] = [];

  // Column anchors from the header the report repeats on every page. Used for the
  // TEXT columns only — the numeric ones are found by clustering (see below).
  const hdr: Record<string, number> = {};
  const HDR: Record<string, string> = {
    LBS: 'lbs', SKID: 'skids', PIECE: 'pieces', ST: 'state', CITY: 'city',
    'CUST NAME': 'name', 'ZIP CODE': 'zip', WHS: 'whs', VIA: 'via',
  };
  for (const c of cells) {
    const k = HDR[c.text];
    if (k && hdr[k] === undefined) hdr[k] = c.x;
  }

  // Group cells into visual rows; a row is a data row iff it carries a 9-digit PRO.
  const byRow = new Map<string, PdfCell[]>();
  for (const c of cells) {
    const key = `${c.page}|${Math.round(c.y)}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key)!.push(c);
  }
  const dataRows: Array<{ cs: PdfCell[]; pro: PdfCell; date: PdfCell }> = [];
  for (const cs of byRow.values()) {
    cs.sort((a, b) => a.x - b.x);
    const pro = cs.find((c) => PRO_RE.test(c.text));
    if (!pro) continue;
    const date = cs.find((c) => DATE_RE.test(c.text));
    if (!date) { warnings.push(`PRO ${pro.text}: no ship date on its row`); continue; }
    dataRows.push({ cs, pro, date });
  }

  // FREIGHT COLUMNS BY CLUSTERING, NOT BY HEADER POSITION — the values are
  // right-aligned so they never line up with their header's left edge.
  const stateX = hdr.state ?? 2900;
  const xs: number[] = [];
  for (const { cs, pro } of dataRows) {
    for (const c of cs) if (NUM_RE.test(c.text) && c !== pro && c.x > stateX + 40) xs.push(c.x);
  }
  xs.sort((a, b) => a - b);
  const clusters: number[][] = [];
  let cur: number[] = [];
  for (const x of xs) {
    if (cur.length && x - cur[cur.length - 1] > COL_GAP) { clusters.push(cur); cur = []; }
    cur.push(x);
  }
  if (cur.length) clusters.push(cur);
  const columns = clusters.map((c) => ({ lo: c[0], hi: c[c.length - 1], n: c.length }));

  const totals = totalsOf(cells);
  if (!totals) warnings.push('no FINAL TOTALS line found — the manifest cannot be self-verified');

  // WHICH CLUSTER IS WHICH COLUMN? Left-to-right is LBS, SKID, PIECE — but PROVE
  // it rather than assume, by reproducing the document's own FINAL TOTALS. A
  // manifest with no loose pieces yields only two clusters, where guessing which
  // one is SKID and which is PIECE would be a coin flip on freight counts.
  const orders: Array<Array<'lbs' | 'skids' | 'pieces'>> =
    columns.length >= 3 ? [['lbs', 'skids', 'pieces']]
      : columns.length === 2 ? [['lbs', 'skids'], ['lbs', 'pieces']]
        : [['lbs']];

  let fallback: UlineManifest | null = null;
  for (const order of orders) {
    const rows = dataRows.map(({ cs, pro, date }) => buildRow(cs, pro, date, columns, order, hdr));
    const sum = (k: 'lbs' | 'skids' | 'pieces') => rows.reduce((a, r) => a + r[k], 0);
    const matches = !!totals
      && rows.length === totals.count
      && sum('lbs') === totals.lbs
      && sum('skids') === totals.skids
      && sum('pieces') === totals.pieces;
    if (matches) return { rows, totals, verified: true, warnings, columns };
    if (!fallback) fallback = { rows, totals, verified: false, warnings, columns };
  }

  const out = fallback ?? { rows: [], totals, verified: false, warnings, columns };
  out.warnings = [
    ...warnings,
    totals
      ? `parsed rows do not reconcile against the manifest's own FINAL TOTALS (expected ${totals.count} orders / ${totals.lbs} lb / ${totals.skids} skids / ${totals.pieces} pieces)`
      : 'freight columns could not be verified — no FINAL TOTALS to check against',
  ];
  return out;
}

function buildRow(
  cs: PdfCell[], pro: PdfCell, date: PdfCell,
  columns: Array<{ lo: number; hi: number }>,
  order: Array<'lbs' | 'skids' | 'pieces'>,
  hdr: Record<string, number>,
): UlineRow {
  const val = { lbs: 0, skids: 0, pieces: 0 };
  for (const c of cs) {
    if (c === pro || !NUM_RE.test(c.text)) continue;
    const bi = columns.findIndex((b) => c.x >= b.lo - 1 && c.x <= b.hi + 1);
    if (bi < 0 || !order[bi]) continue;
    val[order[bi]] = toNum(c.text);
  }
  const between = (a: number, b: number): string | null =>
    cs.filter((c) => c !== pro && c !== date && c.x >= a - 40 && c.x < b - 40)
      .map((c) => c.text).join(' ').trim() || null;
  return {
    shipDate: date.text,
    via: between(hdr.via ?? 440, hdr.whs ?? 640),
    whs: between(hdr.whs ?? 640, hdr.zip ?? 750),
    zip: between(hdr.zip ?? 750, hdr.name ?? 1200),
    custName: between(hdr.name ?? 1200, hdr.city ?? 2250),
    city: between(hdr.city ?? 2250, hdr.state ?? 2960),
    state: between(hdr.state ?? 2960, (hdr.lbs ?? 3270) - 60),
    ...val,
    pro: pro.text,
  };
}

function totalsOf(cells: PdfCell[]): UlineTotals | null {
  const i = cells.findIndex((c) => /FINAL TOTALS/i.test(c.text));
  if (i < 0) return null;
  const t = cells.slice(i, i + 8).filter((c) => NUM_RE.test(c.text)).map((c) => toNum(c.text));
  return t.length >= 4 ? { count: t[0], lbs: t[1], skids: t[2], pieces: t[3] } : null;
}

/** Convenience: bytes in, manifest out. */
export function readUlineManifest(buf: Uint8Array | Buffer): UlineManifest {
  return parseUlineManifest(pdfCells(buf));
}
