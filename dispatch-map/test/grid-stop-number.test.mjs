// test/grid-stop-number.test.mjs — the bottom grid's Stop # cell must never be cut off.
//
// Chad, on the Stops grid showing "ESTES-2958…" / "ESTES-0158…": "i want the whole number to
// show." A stop number is an IDENTIFIER — half of one is not a shorter version of it, it is
// unusable — and these range from a bare "007157031" to a carrier-prefixed
// "ESTES-0828068215" that the old 96px max-width clipped.
//
// The grid renders inside App.jsx (no component export, no DOM test rig), so this pins the
// SOURCE, same approach as last-stop-removable.test.mjs. Two things have to hold together:
// the column has to ASK not to be clamped, and the cell renderer has to HONOR that — either
// one alone silently truncates again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test("the Stop # column opts out of the width clamp", () => {
  const col = src.match(/\{ k: 'stop', label: 'Stop #'[^\n]*/)?.[0];
  assert.ok(col, "the Stop # column is gone from the grid — if it moved, move this pin with it");
  assert.ok(
    /\bfit: true\b/.test(col),
    'the Stop # column must carry fit: true, or a carrier-prefixed number like ' +
    '"ESTES-0828068215" gets ellipsized back down to "ESTES-2958…".',
  );
});

test('both grid bodies honor fit (no max-width, no ellipsis)', () => {
  const cells = src.match(/<td key=\{c\.k\}[^\n]*/g) || [];
  assert.equal(cells.length, 2, `expected the Stops + Loads cell renderers, found ${cells.length}`);
  for (const td of cells) {
    assert.ok(
      td.includes('c.fit ? undefined : c.w'),
      'a grid cell still clamps every column to c.w — a fit column has to drop maxWidth or the ' +
      'flag does nothing.',
    );
    assert.ok(
      td.includes("c.fit ? '' : ' overflow-hidden text-ellipsis'"),
      'a grid cell still applies the ellipsis to every column — a fit column must drop it, ' +
      'otherwise the text is clipped even without an explicit max-width.',
    );
  }
});

test('the other columns still clamp', () => {
  // The point is a targeted exception, not "nothing truncates" — a long address SHOULD
  // ellipsize instead of shoving the whole grid sideways.
  const addr = src.match(/\{ k: 'addr1', label: 'Address 1'[^\n]*/)?.[0] || '';
  assert.ok(addr, 'Address 1 column not found');
  assert.ok(!/\bfit: true\b/.test(addr), 'Address 1 should keep its clamp — only identifiers opt out');
});
