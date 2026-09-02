// lib/load-columns.mts — WHAT DOES THE LOAD LIST ACTUALLY RETURN? (pure half)
//
// The hourly load roster (POST /entity/filterdata/PkgRoute, the portal's "Loads" grid) has
// returned ZERO loads on every day on file, and nobody could say why, because the only thing
// the repo keeps from that response is the normalised rows — and when normalisation finds
// nothing, nothing is what gets written. This module summarises the RAW response so one look
// answers the two questions that were open on 2026-09-02:
//
//   • does the list carry a per-load vehicle type (the truthiest "is this a tractor" source,
//     dead since the fleet index stopped in April)?
//   • why does normalizeLoads see no rows — no KeyColumn, an empty values array, a shape the
//     column patterns miss?
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
