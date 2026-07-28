// lib/manifest-extract.mts
//
// PURE helpers for the scanned-manifest OCR feature (manifest-ocr.mts): the extraction
// prompt, the model-output JSON parsing, and row normalization/validation. No network,
// no env — everything here is unit-testable. The handler owns the Anthropic call.
//
// Context: Davis receives LTL delivery manifests (Estes Express Lines, and others in
// the same shape) as SCANNED PDFs — 1-bit fax images, zero embedded text (verified with
// pdffonts/pdfimages on a real one) — so no text parser can read them. Claude vision
// reads the pages and returns the consignee rows as strict JSON; these helpers validate
// that JSON hard, because a misread digit in a PRO becomes a wrong order number. The
// manifest itself gives us two integrity anchors, and the prompt exploits both:
//   1. every PRO is printed TWICE (dashed number + the digit string under its barcode);
//   2. the header carries "Total Pros: N" — an expected row count.

// One consignee row as the model must emit it. proDigits is the authoritative PRO (the
// barcode digit string); proPrinted is the human-formatted one (e.g. "028-8347656").
export interface ManifestRow {
  name: string;
  addr1: string;
  addr2: string | null;
  city: string;
  state: string;
  zip: string;
  units: number | null;
  weight: number | null;
  description: string | null;
  proPrinted: string | null;
  proDigits: string | null;
}

export const MANIFEST_SYSTEM = 'You are a precise OCR extractor for scanned LTL freight delivery manifests. You return ONLY strict JSON — no prose, no markdown fences.';

// Header placeholders. These are deliberately UNREAL. The prompt used to illustrate the
// shape with the actual values off manifest 047-52228 (the scan this feature was built
// against) — a real number, real date, real time, real trailer. An OCR reader that cannot
// make out a fax-blurred header has an obvious out in that situation: copy the example.
// The result reads like a perfectly good manifest and is silently wrong. Placeholders that
// could never appear on a real Estes page remove the temptation, and `assertNotPlaceholder`
// below catches one if it is ever echoed anyway.
export const MANIFEST_PLACEHOLDERS = ['NNN-NNNNN', 'MM/DD/YY', 'HH:MM:SS', 'TTTTTT', 'PPP-PPPPPPP', 'PPPPPPPPPP'];

// The user-turn instructions that ride along with the PDF document block.
export const MANIFEST_PROMPT = `Read this scanned delivery manifest (all pages) and extract EVERY consignee (delivery) row into JSON.

Return EXACTLY this shape (the values below are FORMAT PLACEHOLDERS, never data — read every value off the page):
{
  "carrier": string|null,          // from the page header, e.g. "Estes Express Lines"
  "manifestNumber": string|null,   // the "Delivery Manifest" number, format NNN-NNNNN
  "manifestDate": string|null,     // as printed, format MM/DD/YY
  "manifestTime": string|null,     // as printed under the date, format HH:MM:SS
  "trailer": string|null,          // the Trailer band's number (often under a barcode), 6 digits
  "totalPros": number|null,        // the header's "Total Pros" count
  "totalUnits": number|null,       // the header's "Units" count
  "totalWeight": number|null,      // the header's "Wgt" total, pounds
  "rows": [
    {
      "name": string,              // consignee/business name. The name may wrap across lines around the street — reconstruct the full name; never include the street or city in it.
      "addr1": string,             // the street line (starts with a number)
      "addr2": string|null,        // suite/unit/building ONLY if genuinely a second address line; null otherwise
      "city": string,
      "state": string,             // 2-letter code
      "zip": string,               // 5-digit ZIP
      "units": number|null,        // the Units column
      "weight": number|null,       // the Wgt column, pounds, integer
      "description": string|null,  // the Description column; join its lines with "; "
      "proPrinted": string|null,   // the Pro Number as printed, format PPP-PPPPPPP
      "proDigits": string|null     // the digit string printed UNDER the barcode, 10 digits
    }
  ]
}

OUTPUT FORMAT — read this twice, a malformed response costs the whole manifest:
- Emit COMPACT JSON: no indentation, no line breaks between fields. A long manifest pretty-printed can overrun the response limit and get cut off mid-row.
- ESCAPE every double-quote that appears INSIDE a string value as \\". Descriptions routinely carry inch marks — 20" WIDE ELECTRIC COIL must be emitted as "20\\" WIDE ELECTRIC COIL". An unescaped inch mark makes the whole response unparseable.
- No trailing commas. No comments. No prose before or after the JSON.

Accuracy rules — this is fax-quality; digits get misread:
- Every row prints its PRO twice: the dashed "Pro Number" column AND the digits under the barcode. They MUST agree once the dash is removed. Use the barcode digits as authoritative; if you cannot reconcile them, still output both exactly as read.
- Skip header/trailer/summary bands (Trailer, Delivering Terminal, Total Pros, page headers, "Manifest Continued" lines) — rows are consignees only.
- Include every consignee across ALL pages; do not stop at page 1. The header's "Total Pros" is how many rows you must return.
- Do not invent values: anything unreadable is null. NEVER copy a value from the shape above.
- The pages may be rotated 90°; read them in whatever orientation they are printed.`;

// Strip optional ```json fences / surrounding prose and parse the first JSON object.
// STRICT: exactly as before, and still the fast path. Recovery lives in extractManifestJson.
export function extractJsonBlock(text: string): any | null {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// ── Recovery ─────────────────────────────────────────────────────────────────
// A manifest read is expensive (one vision call over a multi-page scan, ~20-40s) and the
// dispatcher is standing at the dock. Throwing away 24 good rows because ONE character is
// wrong is the worst possible trade, and it is exactly what used to happen: the reader
// returned "no usable JSON — try the drop again" for the whole file, which is a lie,
// because the same PDF fails the same way every time. Two real, observed break modes:
//
//  1. UNESCAPED INNER QUOTE. Estes descriptions carry inch marks. Manifest 047-54026 row 1
//     reads `TEM130BKWY 20" WIDE ELECTRIC COIL R`; emitted unescaped, that one character
//     ends the JSON string early and JSON.parse dies — taking all 24 orders with it.
//  2. TRUNCATION. A long manifest pretty-printed can exceed the response cap and stop
//     mid-row, leaving the outer object unclosed.
//
// Both are recoverable without guessing at any VALUE: (1) is a lexical repair, (2) is a
// matter of keeping the rows that did arrive. Whatever is recovered is reported so the
// caller can warn loudly — recovery never happens quietly.

// PURE: re-escape double-quotes that sit INSIDE a JSON string. A string value legally ends
// only at a quote whose next non-space character is one of , } ] : or end-of-input; any
// other quote is content and gets escaped. Exported for tests.
export function repairInnerQuotes(s: string): { text: string; escaped: number } {
  let out = '';
  let inStr = false;
  let escaped = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i++; continue; }
    if (ch !== '"') { out += ch; continue; }
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    const next = s[j];
    if (next === ',' || next === '}' || next === ']' || next === ':' || next === undefined) { out += ch; inStr = false; }
    else { out += '\\"'; escaped++; }
  }
  return { text: out, escaped };
}

// PURE: close a response that was cut off mid-array by dropping the incomplete tail row and
// terminating the structure. Returns null when there is nothing salvageable (no "rows" array,
// or not one complete row in it). Exported for tests.
export function closeTruncatedJson(s: string): string | null {
  const rowsAt = s.indexOf('"rows"');
  if (rowsAt < 0) return null;
  const open = s.indexOf('[', rowsAt);
  if (open < 0) return null;
  // Walk the array tracking brace depth, string-aware, and remember where the last
  // depth-1 row object closed.
  let inStr = false, depth = 0, lastRowEnd = -1;
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) lastRowEnd = i; }
    else if (ch === ']' && depth === 0) return null;   // array already closed — not a truncation
  }
  if (lastRowEnd < 0) return null;
  return `${s.slice(0, lastRowEnd + 1)}]}`;
}

export interface ManifestParse {
  parsed: any | null;
  /** Human-readable notes about any repair applied — empty when the JSON was already clean. */
  repairs: string[];
}

// Parse the model's response into the manifest object, repairing what is mechanically
// repairable. Strict parse first (the overwhelmingly common case, zero cost); recovery only
// when that fails, and every recovery is reported in `repairs`.
export function extractManifestJson(text: string): ManifestParse {
  const strict = extractJsonBlock(text);
  if (strict) return { parsed: strict, repairs: [] };

  const s = String(text ?? '').trim();
  if (!s) return { parsed: null, repairs: [] };
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const afterFence = fenced ? fenced[1] : s;
  const start = afterFence.indexOf('{');
  if (start < 0) return { parsed: null, repairs: [] };
  const body = afterFence.slice(start);
  const repairs: string[] = [];

  // 1) Inner-quote repair over the whole body, then retry the strict slice.
  const { text: fixed, escaped } = repairInnerQuotes(body);
  if (escaped > 0) repairs.push(`escaped ${escaped} stray quote mark(s) inside text values (inch marks in Description)`);
  const end = fixed.lastIndexOf('}');
  if (end > 0) {
    try {
      const parsed = JSON.parse(fixed.slice(0, end + 1));
      return { parsed, repairs };
    } catch { /* fall through to truncation recovery */ }
  }

  // 2) Truncation recovery — keep the complete rows, drop the severed tail.
  const closed = closeTruncatedJson(fixed);
  if (closed) {
    try {
      const parsed = JSON.parse(closed);
      repairs.push('the reader\'s response was CUT OFF mid-manifest — only the rows that arrived were kept');
      return { parsed, repairs };
    } catch { /* unrecoverable */ }
  }
  return { parsed: null, repairs };
}

const digitsOf = (v: any) => String(v ?? '').replace(/\D/g, '');
const intOrNull = (v: any) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const strOrNull = (v: any) => { const s = String(v ?? '').trim(); return s ? s : null; };

// Normalize + validate the model's output. NEVER throws on bad rows — it keeps the good
// ones and reports everything suspicious in `warnings`, because the rows land in an
// EDITABLE review grid (the dispatcher is the final gate), and a hard failure on row 17
// must not cost the 16 clean ones.
export function normalizeManifestRows(parsed: any): {
  manifest: {
    carrier: string | null; manifestNumber: string | null; manifestDate: string | null;
    manifestTime: string | null; trailer: string | null;
    totalPros: number | null; totalUnits: number | null; totalWeight: number | null;
  };
  rows: ManifestRow[];
  warnings: string[];
  /**
   * The manifest's OWN header checksums, evaluated. `shortBy > 0` means orders are MISSING
   * — categorically different from "row 12 has a short ZIP", and the caller must surface it
   * as a blocking banner rather than one more entry in the warning list.
   */
  integrity: {
    expectedPros: number | null; readPros: number; shortBy: number;
    unitsOk: boolean; weightOk: boolean;
  };
} {
  const warnings: string[] = [];
  // A header value echoed verbatim from the prompt's shape is NOT data — drop it rather
  // than let a fabricated manifest number ride into the intake looking authoritative.
  const notPlaceholder = (v: string | null, field: string) => {
    if (v && MANIFEST_PLACEHOLDERS.includes(v.toUpperCase())) {
      warnings.push(`The reader echoed the example ${field} instead of reading it off the page — treat this manifest's header as unread`);
      return null;
    }
    return v;
  };
  const manifest = {
    carrier: strOrNull(parsed?.carrier),
    manifestNumber: notPlaceholder(strOrNull(parsed?.manifestNumber), 'manifest number'),
    manifestDate: notPlaceholder(strOrNull(parsed?.manifestDate), 'date'),
    manifestTime: notPlaceholder(strOrNull(parsed?.manifestTime), 'time'),
    trailer: notPlaceholder(strOrNull(parsed?.trailer), 'trailer'),
    totalPros: intOrNull(parsed?.totalPros),
    totalUnits: intOrNull(parsed?.totalUnits),
    totalWeight: intOrNull(parsed?.totalWeight),
  };
  const rawRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const rows: ManifestRow[] = [];
  const seenPro = new Set<string>();
  rawRows.forEach((r: any, i: number) => {
    const name = strOrNull(r?.name);
    const addr1 = strOrNull(r?.addr1);
    if (!name && !addr1) { warnings.push(`Row ${i + 1}: empty (skipped)`); return; }
    const printed = strOrNull(r?.proPrinted);
    let digits = digitsOf(r?.proDigits) || null;
    const printedDigits = digitsOf(printed) || null;
    // The manifest's own cross-check: dashed PRO and barcode digits must agree. When they
    // don't, keep the barcode digits (denser print, machine-oriented) but SAY SO — the row
    // will sit in the review grid where the dispatcher can compare against the paper.
    if (digits && printedDigits && digits !== printedDigits) {
      warnings.push(`Row ${i + 1} (${name || addr1}): PRO mismatch — printed ${printed} vs barcode ${digits}; kept barcode`);
    }
    if (!digits && printedDigits) digits = printedDigits;
    if (!digits) warnings.push(`Row ${i + 1} (${name || addr1}): no readable PRO`);
    if (digits && seenPro.has(digits)) warnings.push(`Row ${i + 1} (${name || addr1}): duplicate PRO ${digits}`);
    if (digits) seenPro.add(digits);
    const zip = digitsOf(r?.zip).slice(0, 5) || '';
    if (!zip || zip.length !== 5) warnings.push(`Row ${i + 1} (${name || addr1}): missing/short ZIP`);
    rows.push({
      name: name || '',
      addr1: addr1 || '',
      addr2: strOrNull(r?.addr2),
      city: strOrNull(r?.city) || '',
      state: (strOrNull(r?.state) || '').toUpperCase().slice(0, 2),
      zip,
      units: intOrNull(r?.units),
      weight: intOrNull(r?.weight),
      description: strOrNull(r?.description),
      proPrinted: printed,
      proDigits: digits,
    });
  });
  if (manifest.totalPros != null && rows.length !== manifest.totalPros) {
    warnings.push(`Manifest header says ${manifest.totalPros} PROs but ${rows.length} row(s) were read — compare against the paper before importing`);
  }
  // The header also totals Units and Wgt — free checksums over every row's numbers.
  const unitSum = rows.reduce((a, r) => a + (r.units ?? 0), 0);
  const wgtSum = rows.reduce((a, r) => a + (r.weight ?? 0), 0);
  const unitsOk = manifest.totalUnits == null || unitSum === manifest.totalUnits;
  const weightOk = manifest.totalWeight == null || wgtSum === manifest.totalWeight;
  if (!unitsOk) {
    warnings.push(`Units add up to ${unitSum} but the header says ${manifest.totalUnits} — a Units cell may be misread`);
  }
  if (!weightOk) {
    warnings.push(`Weights add up to ${wgtSum} lb but the header says ${manifest.totalWeight} — a Wgt cell may be misread`);
  }
  const integrity = {
    expectedPros: manifest.totalPros,
    readPros: rows.length,
    // Only a SHORTFALL means lost orders. Reading more rows than the header claims is a
    // different (rarer) problem and stays in `warnings`.
    shortBy: manifest.totalPros != null ? Math.max(0, manifest.totalPros - rows.length) : 0,
    unitsOk,
    weightOk,
  };
  return { manifest, rows, warnings, integrity };
}
