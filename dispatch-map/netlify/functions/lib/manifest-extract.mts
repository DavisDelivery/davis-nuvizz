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

// The user-turn instructions that ride along with the PDF document block.
export const MANIFEST_PROMPT = `Read this scanned delivery manifest (all pages) and extract EVERY consignee (delivery) row into JSON.

Return EXACTLY this shape:
{
  "carrier": string|null,          // e.g. "Estes Express Lines" (from the page header)
  "manifestNumber": string|null,   // e.g. "047-52228"
  "manifestDate": string|null,     // as printed, e.g. "7/14/26"
  "manifestTime": string|null,     // as printed under the date, e.g. "9:14:26"
  "trailer": string|null,          // the Trailer band's number (often under a barcode), e.g. "521104"
  "totalPros": number|null,        // the header's "Total Pros" count
  "totalUnits": number|null,       // the header's "Units" count
  "totalWeight": number|null,      // the header's "Wgt" total, pounds
  "rows": [
    {
      "name": string,              // consignee/business name. The name may wrap across lines around the street — reconstruct the full name; never include the street or city in it.
      "addr1": string,             // the street line (starts with a number, e.g. "306 GWINNETT SQUARE CIR")
      "addr2": string|null,        // suite/unit/building ONLY if genuinely a second address line; null otherwise
      "city": string,
      "state": string,             // 2-letter code
      "zip": string,               // 5-digit ZIP
      "units": number|null,        // the Units column
      "weight": number|null,       // the Wgt column, pounds, integer
      "description": string|null,  // the Description column; join its lines with "; "
      "proPrinted": string|null,   // the Pro Number as printed, e.g. "028-8347656"
      "proDigits": string|null     // the digit string printed UNDER the barcode, e.g. "0288347656"
    }
  ]
}

Accuracy rules — this is fax-quality; digits get misread:
- Every row prints its PRO twice: the dashed "Pro Number" column AND the digits under the barcode. They MUST agree once the dash is removed. Use the barcode digits as authoritative; if you cannot reconcile them, still output both exactly as read.
- Skip header/trailer/summary bands (Trailer, Delivering Terminal, Total Pros, page headers, "Manifest Continued" lines) — rows are consignees only.
- Include every consignee across ALL pages; do not stop at page 1.
- Do not invent values: anything unreadable is null.`;

// Strip optional ```json fences / surrounding prose and parse the first JSON object.
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
} {
  const warnings: string[] = [];
  const manifest = {
    carrier: strOrNull(parsed?.carrier),
    manifestNumber: strOrNull(parsed?.manifestNumber),
    manifestDate: strOrNull(parsed?.manifestDate),
    manifestTime: strOrNull(parsed?.manifestTime),
    trailer: strOrNull(parsed?.trailer),
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
  if (manifest.totalUnits != null && unitSum !== manifest.totalUnits) {
    warnings.push(`Units add up to ${unitSum} but the header says ${manifest.totalUnits} — a Units cell may be misread`);
  }
  if (manifest.totalWeight != null && wgtSum !== manifest.totalWeight) {
    warnings.push(`Weights add up to ${wgtSum} lb but the header says ${manifest.totalWeight} — a Wgt cell may be misread`);
  }
  return { manifest, rows, warnings };
}
