// useSortable.jsx — shared sortable-table primitives.
//
// Lifted verbatim from the copies that live at module scope in App.jsx so a
// component file can use them without importing App.jsx, which would create an
// import cycle (App.jsx imports the components). Same comparator: asc -> desc
// toggle, nulls last, numeric-aware natural string compare.
//
// App.jsx's own copies are untouched. If the comparator ever changes, change both.

import React, { useState, useCallback, useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

export function useSortable(rows, defaultKey = null, defaultDir = 'asc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  const toggle = useCallback((key) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...(rows || [])];
    copy.sort((a, b) => {
      const av = a?.[sortKey];
      const bv = b?.[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggle };
}

export function SortableTh({ label, k, sortKey, sortDir, onToggle, className = '' }) {
  const active = sortKey === k;
  return (
    <th
      onClick={() => onToggle(k)}
      className={`px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 cursor-pointer select-none hover:bg-slate-100 ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </span>
    </th>
  );
}
