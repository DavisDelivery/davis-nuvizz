// lib/load-columns.mts — WHAT DOES THE LOAD LIST ACTUALLY RETURN? (pure half)
//
// This module summarises the RAW load-list response (POST /entity/filterdata/PkgRoute, the
// portal's "Loads" grid) so one look answers a question the normalised rows cannot: which
// COLUMNS the grid carries. It was written on 2026-09-02 to settle whether the list exposes a
// per-load vehicle type — the truthiest "is this a tractor" source, dead since the fleet index
// stopped in April.
//
// WHAT THE ONE CALL SAID (2026-09-02, stored at nuvizz_ops/load_columns__2026-09-02): 21
// columns, 106 rows, 106 normalised, and NO vehicle-type column. The per-load type lives only
// on /load/info/{loadNbr} (loadHeader.vehicleType) and beside the load number on /stop/info
// (Stop.load.vehicleType). What the grid DOES carry is rteNbr, labelled "Load Number"
// ("DAVIS000203100") — the exact key /load/info wants — plus name, driver, status and stop
// count, cached hourly in nuvizz_load_roster at zero extra calls.
//
// A CORRECTION, recorded where the mistake was made. The first version of this comment said
// the hourly roster "has returned ZERO loads on every day on file". It had not. The roster doc
// stores its rows as a JSON string under `loadsJson` with a `count` beside it (106 that day);
// the ad-hoc reader that produced the zero looked for a `loads` array. A number is not a fact
// until the thing that produced it has been checked too — that one had not been.
//
// PURE: takes the parsed JSON, returns a summary safe to store and read back. No network.
import { normalizeLoads } from './nuvizz-loads.mts';
import { linkVal } from './nuvizz-list.mts';

export interface ColumnDef { key: string; label: string }
export interface LoadColumnsSummary {
  topLevelKeys: string[];
  totalRecords: number | null;
  columnCount: number;
  columns: ColumnDef[];
  vehicleColumns: ColumnDef[];       // any column whose key or label smells like a truck type
  rowCount: number;
  firstRows: Record<string, any>[];  // up to 3, keyed by column KEY, link-objects unwrapped, values truncated
  normalizedCount: number;           // what normalizeLoads makes of it — the number the roster stores
  verdict: string;                   // one sentence a person can act on
}

const VEHICLE_RE = /vehicle|truck|trailer|tractor|equip|fleet.?type|asset/i;

export function summarizeLoadColumns(j: any, opts: { rows?: number; maxValue?: number } = {}): LoadColumnsSummary {
  const rows = opts.rows ?? 3;
  const maxValue = opts.maxValue ?? 80;
  const colDefs: Record<string, any> = (j && j.filterData && j.filterData[0]) || {};
  const columns: ColumnDef[] = Object.keys(colDefs).map((key) => ({ key, label: String(colDefs[key]?.columnName ?? '') }));
  const vehicleColumns = columns.filter((c) => VEHICLE_RE.test(`${c.key} ${c.label}`));
  const values: any[] = Array.isArray(j?.values) ? j.values : [];
  const firstRows = values.slice(0, rows).map((row: any[]) => {
    const out: Record<string, any> = {};
    columns.forEach((c, i) => {
      const v = linkVal(row?.[i]);
      out[c.key] = typeof v === 'string' && v.length > maxValue ? v.slice(0, maxValue) + '…' : v;
    });
    return out;
  });
  const totalRecords = [j?.totalRecords, j?.totalCount, j?.total, j?.count]
    .map((x) => Number(x)).find((n) => Number.isFinite(n)) ?? null;
  let normalizedCount = 0;
  try { normalizedCount = normalizeLoads(j).length; } catch { normalizedCount = -1; }

  let verdict: string;
  if (!columns.length) verdict = 'the response carries no filterData column definitions — this is not the grid shape the code expects';
  else if (!values.length) verdict = `${columns.length} columns and ZERO rows — the list definition or the period filter matched no loads`;
  else if (!normalizedCount) verdict = `${values.length} rows came back but normalizeLoads kept none — the id/name column patterns do not match these keys`;
  else verdict = `${normalizedCount} loads normalised from ${values.length} rows`;
  if (vehicleColumns.length) verdict += `; vehicle-type column present: ${vehicleColumns.map((c) => c.key).join(', ')}`;
  else if (columns.length) verdict += '; NO vehicle-type column among these columns';

  return {
    topLevelKeys: j && typeof j === 'object' ? Object.keys(j) : [],
    totalRecords, columnCount: columns.length, columns, vehicleColumns,
    rowCount: values.length, firstRows, normalizedCount, verdict,
  };
}
