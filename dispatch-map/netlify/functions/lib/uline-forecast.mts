// lib/uline-forecast.mts
//
// ── ULINE'S MONTHLY SHIPMENT FORECAST, READ OUT OF THE SPREADSHEET THEY SEND ──
//
// Chad: "find in my email the Uline forecasts they present and I want to start comparing
// them to what the manifest actually produce so we can try to forecast what is coming."
//
// WHAT THEY SEND (read from the mailbox, not assumed): "DA - G - Uline Forecast", monthly in
// the first week, since June 2022. One attachment, ULINE_Forecast.xlsx, one sheet, a header
// row and ~330 data rows:
//
//     date      warehouse  via  viatype  estimate  upperest
//     7/15/26   G          DA   DA       671       745
//
// `date` is Uline's SHIP date — the same "SHIPPED ON" date printed at the top of the nightly
// freight report, and the same date the manifest archive keys a night on (manifestDeliveryDate
// ranks the rows' ship dates). That is what makes the comparison a plain join and not a guess.
// Twelve months forward, no Saturdays, Sundays at ~75, weekdays 500–700. `upperest` is the
// high range, about 62 above the estimate.
//
// SELF-VALIDATING, like the manifest reader. The columns are found BY NAME, not by position,
// so a re-ordered export still reads; a missing name is a warning and an empty result, not a
// column of wrong numbers. Every row that cannot be read says why. A file that reads clean
// but says something impossible — an estimate above its own high range, the same date twice —
// keeps the row and carries the warning, because a forecast with a wart is still a forecast
// and the screen can say "with 2 warnings" where a silent drop would just be a shorter list.
//
// PURE. Bytes in, rows out. No I/O, no dates from the clock: the version date comes from the
// email that carried the file, and the caller supplies it.

import * as XLSX from 'xlsx';

export interface ForecastRow {
  /** ISO ship date, YYYY-MM-DD. */
  date: string;
  warehouse: string | null;
  via: string | null;
  viaType: string | null;
  /** Uline's expected order count for that ship date. */
  estimate: number;
  /** Uline's high range for that ship date. */
  upperEst: number | null;
}

export interface ForecastRead {
  rows: ForecastRow[];
  warnings: string[];
  /** First and last ship date covered, or null when nothing read. */
  from: string | null;
  to: string | null;
  sheet: string | null;
}

/** The header names Uline uses, lower-cased, with the aliases a human re-export might use. */
const HEADER_ALIASES: Record<keyof Omit<ForecastRow, 'date'> | 'date', string[]> = {
  date: ['date', 'ship date', 'shipdate', 'ship_date'],
  warehouse: ['warehouse', 'whs', 'wh'],
  via: ['via'],
  viaType: ['viatype', 'via type', 'via_type'],
  estimate: ['estimate', 'est', 'forecast'],
  upperEst: ['upperest', 'upper est', 'upper', 'high', 'high range', 'upper_est'],
};

const norm = (v: any): string => String(v ?? '').trim().toLowerCase();

/**
 * M/D/YY or M/D/YYYY (what the sheet holds when read with raw:false), or an ISO date, or an
 * Excel serial (when a cell is a real date and the reader hands back the number). Anything
 * else is null — and null is reported, never guessed at.
 */
export function forecastDateToIso(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial day → UTC date. 25569 is 1970-01-01.
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime()) || v < 20000 || v > 80000) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const mo = Number(m[1]); const d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // Reject 2/30 and friends by round-tripping through a real calendar.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

/** Map header cells to our field names. Unknown headers are ignored; missing ones are reported. */
export function resolveForecastColumns(header: any[]): { cols: Partial<Record<keyof ForecastRow, number>>; missing: string[] } {
  const cols: Partial<Record<keyof ForecastRow, number>> = {};
  const cells = (header || []).map(norm);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof ForecastRow, string[]][]) {
    const idx = cells.findIndex((c) => aliases.includes(c));
    if (idx >= 0) cols[field] = idx;
  }
  const missing = (['date', 'estimate'] as const).filter((f) => cols[f] == null);
  return { cols, missing };
}

/**
 * Read the forecast out of the workbook bytes.
 *
 * Rows are returned sorted by date, de-duplicated on date (FIRST occurrence kept, the
 * duplicate reported), with every unreadable row named in `warnings`. An empty `rows` with
 * warnings is the "this is not a forecast" answer — the caller decides what that means.
 */
export function readUlineForecast(buf: Buffer | Uint8Array): ForecastRead {
  const warnings: string[] = [];
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  } catch (e: any) {
    return { rows: [], warnings: [`not a readable workbook: ${String(e?.message || e).slice(0, 120)}`], from: null, to: null, sheet: null };
  }
  const sheetName = wb.SheetNames[0] ?? null;
  const ws = sheetName ? wb.Sheets[sheetName] : null;
  if (!ws) return { rows: [], warnings: ['workbook has no sheets'], from: null, to: null, sheet: null };

  // raw:false hands back the DISPLAY text (so a date cell reads "7/15/26" the way Uline wrote
  // it); numbers still come back as numbers when the cell is numeric.
  const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  if (!grid.length) return { rows: [], warnings: ['sheet is empty'], from: null, to: null, sheet: sheetName };

  // The header is the first row that carries a `date` and an `estimate` — Uline's is row 1,
  // but a re-export with a title line above it should still read.
  let headerIdx = -1;
  let cols: Partial<Record<keyof ForecastRow, number>> = {};
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const r = resolveForecastColumns(grid[i] || []);
    if (!r.missing.length) { headerIdx = i; cols = r.cols; break; }
  }
  if (headerIdx < 0) {
    const first = resolveForecastColumns(grid[0] || []);
    return {
      rows: [], sheet: sheetName, from: null, to: null,
      warnings: [`no header row with ${first.missing.join(' and ')} — first row was: ${(grid[0] || []).map((c) => String(c ?? '')).join(' | ').slice(0, 120)}`],
    };
  }

  const seen = new Map<string, number>();
  const rows: ForecastRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    const isBlank = r.every((c) => c == null || String(c).trim() === '');
    if (isBlank) continue;
    const line = i + 1; // 1-based, as a spreadsheet shows it
    const date = forecastDateToIso(r[cols.date!]);
    if (!date) { warnings.push(`row ${line}: unreadable date "${String(r[cols.date!] ?? '')}"`); continue; }
    const estimate = num(r[cols.estimate!]);
    if (estimate == null) { warnings.push(`row ${line} (${date}): unreadable estimate "${String(r[cols.estimate!] ?? '')}"`); continue; }
    if (estimate < 0) { warnings.push(`row ${line} (${date}): negative estimate ${estimate}`); continue; }
    const upperEst = cols.upperEst != null ? num(r[cols.upperEst]) : null;
    if (upperEst != null && upperEst < estimate) warnings.push(`row ${line} (${date}): high range ${upperEst} is below the estimate ${estimate}`);
    if (seen.has(date)) { warnings.push(`row ${line}: ${date} appears twice (first at row ${seen.get(date)}) — first kept`); continue; }
    seen.set(date, line);
    rows.push({
      date,
      warehouse: cols.warehouse != null ? (String(r[cols.warehouse] ?? '').trim() || null) : null,
      via: cols.via != null ? (String(r[cols.via] ?? '').trim() || null) : null,
      viaType: cols.viaType != null ? (String(r[cols.viaType] ?? '').trim() || null) : null,
      estimate,
      upperEst,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    rows, warnings, sheet: sheetName,
    from: rows.length ? rows[0].date : null,
    to: rows.length ? rows[rows.length - 1].date : null,
  };
}

/** Is this workbook the Uline forecast at all? A forecast has dates and estimates; a random
 *  spreadsheet does not. Used the way the manifest ingest uses "is this the freight report". */
export function looksLikeUlineForecast(read: ForecastRead): boolean {
  return read.rows.length >= 20 && read.rows.every((r) => r.estimate >= 0);
}
