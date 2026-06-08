// scripts/scan-length-signals.mjs
//
// READ-ONLY length-signal inventory for the inches->feet geometry rework.
// Discovery only: it makes NO writes (NuVizz or Firestore), changes NO app
// behavior, and prints ONLY redacted aggregates — never a raw stop dump.
//
// It reuses the repo's EXISTING readers and the EXISTING deterministic geometry
// derivation — nothing here re-implements ingest or normalization:
//   - lib/firestore.mts   listDocs()                (nuvizz_stop_index live cache)
//   - lib/history-store.mts listStops()             (history_days warehouse)
//   - lib/freight-geometry.mts deriveGeometryDeterministic(), palletLinearInches()
//   - lib/routing-types.mts PALLET_LENGTH_IN
//
// Sources (pick widest available; can combine):
//   default  : enumerate every nuvizz_stop_index/{tenant}__{date} and
//              history_days/{tenant}__{date} day, read their stops, union.
//              Requires FIREBASE_SA in env (the same SA the readers use).
//   --demo   : read the committed synthetic fixture
//              (test/fixtures/routing-geometry-stops.json) — no creds, lets you
//              validate the pattern + aggregation logic offline.
//   --json P : read a local JSON array of ALREADY-REDACTION-SAFE normalized
//              stops exported on the creds side. The script still only prints
//              aggregates, but you are responsible for the export being PII-safe.
//   --limit N: cap the number of days read (default: all). --max N caps stops.
//
// Usage:
//   FIREBASE_SA="$(cat sa.json)" node scripts/scan-length-signals.mjs
//   node scripts/scan-length-signals.mjs --demo
//   node scripts/scan-length-signals.mjs --json /tmp/redacted-stops.json
//
// NOTE: written in a sandbox WITHOUT creds, so the live-read path is UNVERIFIED
// at runtime; the --demo path (fixture) was run and exercises all aggregation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = (m) => path.join(__dirname, '..', 'netlify', 'functions', 'lib', m);

const { PALLET_LENGTH_IN } = await import(LIB('routing-types.mts'));
const { deriveGeometryDeterministic, palletLinearInches } = await import(LIB('freight-geometry.mts'));

const ASSUMED_LONG_IN = PALLET_LENGTH_IN * 2; // today's "unknown long item" fallback (96in = 8ft)

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DAY_LIMIT = Number(val('--limit', 'Infinity'));
const STOP_MAX = Number(val('--max', 'Infinity'));

// ── redaction ───────────────────────────────────────────────────────────────
// Conservative: length tokens are short (<=3 digits, maybe a decimal), so masking
// runs of 4+ digits, emails, and 3+ consecutive Capitalized words never eats the
// length signal but does scrub IDs / names / phones / street numbers.
function redact(s) {
  return String(s)
    .replace(/\S+@\S+/g, '[REDACTED]')
    .replace(/\b\d{4,}\b/g, '[REDACTED]')
    .replace(/\b(?:\d[\d\-().\s]{6,}\d)\b/g, '[REDACTED]')
    .replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,})\b/g, '[REDACTED]')
    .trim();
}
function window(text, idx, len, pad = 14) {
  const a = Math.max(0, idx - pad);
  const b = Math.min(text.length, idx + len + pad);
  return (a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : '');
}

// ── free-text length pattern catalog ──────────────────────────────────────────
// Each: name, regex (global), and feet-extractor (number -> inches, or null for a
// qualitative call-out). Order matters only for example attribution, not counting.
const NUM = String.raw`(\d{1,3}(?:\.\d+)?)`;
const PATTERNS = [
  { name: 'NUM_FT_WORD',   re: new RegExp(`\\b${NUM}\\s?(?:ft|foot|feet)\\b`, 'ig'),                 inches: (m) => parseFloat(m[1]) * 12 },
  { name: 'NUM_APOSTROPHE',re: new RegExp(`\\b${NUM}\\s?['’](?!\\s?[a-z])`, 'ig'),                    inches: (m) => parseFloat(m[1]) * 12 },
  { name: 'NUM_LF_LINFT',  re: new RegExp(`\\b${NUM}\\s?(?:lf|lin\\.?\\s?ft|lineal\\s?ft|linear\\s?ft)\\b`, 'ig'), inches: (m) => parseFloat(m[1]) * 12 },
  { name: 'L_EQUALS',      re: new RegExp(`\\bL\\s?[=:]\\s?${NUM}\\s?(?:ft|foot|feet|'|’)?`, 'ig'),   inches: (m) => parseFloat(m[1]) * 12 },
  { name: 'X_FT_LONG',     re: new RegExp(`\\b${NUM}\\s?(?:ft|foot|feet|'|’)\\s?(?:long|lengths?|pieces?|sticks?|sections?|uprights?|joints?)\\b`, 'ig'), inches: (m) => parseFloat(m[1]) * 12 },
  { name: 'NUM_INCH',      re: new RegExp(`\\b${NUM}\\s?(?:in|inch|inches|")\\b`, 'ig'),              inches: (m) => parseFloat(m[1]) },
  { name: 'OVERLENGTH_CALLOUT', re: /\b(over[\s-]?length|over[\s-]?sized?|oversize|extra[\s-]?long|long\s?(?:load|item|piece|haul))\b/ig, inches: () => null },
];

// ── UOM bucketing ─────────────────────────────────────────────────────────────
function uomBucket(u) {
  if (u == null || String(u).trim() === '') return 'blank';
  const x = String(u).toUpperCase().trim();
  if (x === 'FT' || x === 'FOOT' || x === 'FEET') return 'FT';
  if (x === 'IN' || x === 'INCH' || x === 'INCHES' || x === '"') return 'IN';
  if (x === 'CM' || x === 'M' || x === 'MM' || x === 'MTR' || x === 'METER') return 'metric';
  return `other:${x}`;
}

// ── aggregation state ─────────────────────────────────────────────────────────
const A = {
  stops: 0, lines: 0,
  lengthUOM: {}, critUOM: {}, prodCat: {},                 // distinct-value freq maps
  lineHasLength: 0, lineHasCrit: 0, lineCatL: 0,
  // per-stop coverage, cross-tabbed by current oversize flag
  cov: { structured: { os: 0, no: 0 }, freeOnly: { os: 0, no: 0 }, none: { os: 0, no: 0 } },
  freetextHits: {},                                        // pattern -> { count, examples:Set }
  divergence: [],                                          // {assumedIn, realIn} where 2-pallet fires AND a real length exists
};
for (const p of PATTERNS) A.freetextHits[p.name] = { count: 0, examples: new Set() };
const bump = (map, k) => { map[k] = (map[k] || 0) + 1; };

function scanFreeText(text, structuredInchesForLine) {
  if (!text) return { sawNumericFeet: false, bestInches: null };
  let sawNumericFeet = false, bestInches = null;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      A.freetextHits[p.name].count++;
      if (A.freetextHits[p.name].examples.size < 3) {
        A.freetextHits[p.name].examples.add(redact(window(text, m.index, m[0].length)));
      }
      const inch = p.inches(m);
      if (inch != null && Number.isFinite(inch)) {
        if (p.name === 'NUM_FT_WORD' || p.name === 'NUM_APOSTROPHE' || p.name === 'NUM_LF_LINFT' || p.name === 'X_FT_LONG') sawNumericFeet = true;
        if (bestInches == null || inch > bestInches) bestInches = inch;
      }
      if (m.index === p.re.lastIndex) p.re.lastIndex++; // zero-width guard
    }
  }
  return { sawNumericFeet, bestInches };
}

function analyzeStop(stop) {
  A.stops++;
  const details = Array.isArray(stop?.stopDetails) ? stop.stopDetails : [];
  let stopStructuredLen = false;
  let longLineNoStructured = false; // a line the 2-pallet assumption would fire on

  for (const d of details) {
    A.lines++;
    bump(A.lengthUOM, uomBucket(d?.lengthUOM));
    bump(A.critUOM, uomBucket(d?.criticalDimensionUOM));
    bump(A.prodCat, (d?.productCategory == null || d.productCategory === '') ? 'blank' : String(d.productCategory).toUpperCase());
    const hasLen = d?.length != null && Number.isFinite(Number(d.length));
    const hasCrit = d?.criticalDimension != null && Number.isFinite(Number(d.criticalDimension));
    if (hasLen) A.lineHasLength++;
    if (hasCrit) A.lineHasCrit++;
    const isCatL = String(d?.productCategory || '').toUpperCase() === 'L';
    if (isCatL) A.lineCatL++;
    if (hasLen || hasCrit) stopStructuredLen = true;

    // Lines where today's fallback fires: flagged long (cat L or long keyword in
    // product text) but NO structured length -> assumed 2 pallets (96in) * qty.
    const longByText = /\b(rack|racking|tube|tubing|ladder|pipe|pipes|lineal|linear|lumber|beam|beams|rod|rods|conduit|mast|pole|poles|coil|coils|extrusion|moulding|molding|trim|baseboard|gutter)\b/i.test(String(d?.product || ''));
    if ((isCatL || longByText) && !(hasLen || hasCrit)) longLineNoStructured = true;
  }

  // Free-text sources present in the live cache today: orderInstructions + addr2 +
  // product description text (comments are folded into orderInstructions).
  const freeText = [
    stop?.signalSources?.orderInstructions || '',
    stop?.addr2 || '',
    details.map((d) => d?.product || '').join(' '),
  ].join('  ');
  const ft = scanFreeText(freeText);

  // Current oversize verdict from the REAL derivation (no re-implementation).
  let oversize = false;
  try { oversize = !!deriveGeometryDeterministic(stop).oversize; } catch { oversize = false; }
  const osKey = oversize ? 'os' : 'no';

  if (stopStructuredLen) A.cov.structured[osKey]++;
  else if (ft.bestInches != null) A.cov.freeOnly[osKey]++;
  else A.cov.none[osKey]++;

  // Divergence: a long line with no structured length (2-pallet assumption fires)
  // AND a real numeric length recovered from free text -> compare.
  if (longLineNoStructured && ft.sawNumericFeet && ft.bestInches != null) {
    A.divergence.push({ assumedIn: ASSUMED_LONG_IN, realIn: ft.bestInches });
  }
}

// ── data sources ──────────────────────────────────────────────────────────────
async function loadStops() {
  if (has('--demo')) {
    const p = path.join(__dirname, '..', 'test', 'fixtures', 'routing-geometry-stops.json');
    return { label: `fixture ${path.basename(p)}`, stops: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  if (has('--json')) {
    const p = val('--json');
    return { label: `json ${path.basename(p)}`, stops: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  // Live: enumerate cache + history days via the existing readers.
  if (!process.env.FIREBASE_SA) {
    throw new Error('No FIREBASE_SA in env and no --demo/--json given. Set FIREBASE_SA to read the live cache + history, or pass --demo to validate logic against the fixture.');
  }
  const { listDocs } = await import(LIB('firestore.mts'));
  const { listStops } = await import(LIB('history-store.mts'));
  const stops = [];
  const days = [];
  // nuvizz_stop_index meta docs: ids are {tenant}__{date}
  for (const meta of await listDocs('nuvizz_stop_index')) days.push({ kind: 'cache', id: meta._id });
  for (const man of await listDocs('history_days')) days.push({ kind: 'history', id: man._id });
  let used = 0;
  for (const day of days) {
    if (used >= DAY_LIMIT || stops.length >= STOP_MAX) break;
    const [tenant, date] = String(day.id).split('__');
    if (!tenant || !date) continue;
    const dayStops = day.kind === 'cache'
      ? await listDocs(`nuvizz_stop_index/${day.id}/stops`)
      : await listStops(tenant, date);
    for (const s of dayStops) { if (stops.length < STOP_MAX) stops.push(s); }
    used++;
  }
  return { label: `live: ${used} day(s) across cache+history`, stops };
}

// ── report ────────────────────────────────────────────────────────────────────
function pct(n, d) { return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a'; }
function freqTable(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => `      ${k.padEnd(12)} ${v}`).join('\n') || '      (none)';
}
function quantiles(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

const { label, stops } = await loadStops();
for (const s of stops) analyzeStop(s);

const lines = [];
lines.push('=== LENGTH-SIGNAL INVENTORY (read-only, redacted) ===');
lines.push(`source: ${label}`);
lines.push(`stops sampled: ${A.stops}   line items: ${A.lines}   (assumed-long fallback today = ${ASSUMED_LONG_IN}in / ${ASSUMED_LONG_IN / 12}ft per unknown long item × qty)`);
lines.push('');
lines.push('1) STRUCTURED LENGTH (per line item)');
lines.push(`   length populated:            ${A.lineHasLength}/${A.lines} (${pct(A.lineHasLength, A.lines)})`);
lines.push(`   criticalDimension populated: ${A.lineHasCrit}/${A.lines} (${pct(A.lineHasCrit, A.lines)})`);
lines.push(`   productCategory = 'L':       ${A.lineCatL}/${A.lines} (${pct(A.lineCatL, A.lines)})`);
lines.push('   lengthUOM distinct values:'); lines.push(freqTable(A.lengthUOM));
lines.push('   criticalDimensionUOM distinct values:'); lines.push(freqTable(A.critUOM));
lines.push('   productCategory distinct values:'); lines.push(freqTable(A.prodCat));
lines.push('');
lines.push('2) FREE-TEXT LENGTH DENOTATIONS (orderInstructions + addr2 + product text)');
for (const p of PATTERNS) {
  const h = A.freetextHits[p.name];
  lines.push(`   ${p.name.padEnd(16)} count=${h.count}   /${p.re.source}/${p.re.flags}`);
  for (const ex of h.examples) lines.push(`        e.g. ${ex}`);
}
lines.push('');
lines.push('3) COVERAGE (per stop, split by current oversize flag)');
const cov = A.cov;
const covRow = (name, o) => `   ${name.padEnd(22)} total=${o.os + o.no}  (oversize=${o.os}, not=${o.no})  ${pct(o.os + o.no, A.stops)}`;
lines.push(covRow('(a) structured length', cov.structured));
lines.push(covRow('(b) free-text only', cov.freeOnly));
lines.push(covRow('(c) NO length signal', cov.none));
lines.push('');
lines.push('4) DIVERGENCE (2-pallet assumption vs a real free-text length, same line)');
const diffs = A.divergence.map((d) => d.realIn - d.assumedIn);
const q = quantiles(diffs);
if (q) {
  const over = diffs.filter((x) => x < 0).length;  // real < assumed -> today INFLATES
  const under = diffs.filter((x) => x > 0).length;  // real > assumed -> today UNDER-estimates
  lines.push(`   cases: ${q.n}   today INFLATES (assumed>real): ${over}   today UNDER-estimates: ${under}`);
  lines.push(`   real-minus-assumed inches  min=${q.min} p25=${q.p25} median=${q.median} p75=${q.p75} max=${q.max}`);
  lines.push(`   (assumed is fixed at ${ASSUMED_LONG_IN}in; negative => today over-counts floor, positive => under-counts)`);
} else {
  lines.push('   no overlapping cases in this sample (need a long line w/o structured length AND a numeric free-text feet value).');
}
lines.push('');
lines.push('REDACTION: identifiers masked as [REDACTED]; only aggregates + windowed examples printed. No raw stop dump.');
console.log(lines.join('\n'));
