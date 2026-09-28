// test/bulk-undo-import-after-live-push.test.mjs
//
// "WRONG COLUMNS? UNDO & MAP MANUALLY" STAYED LIVE THROUGH A LIVE PUSH (review 2026-09-03, A2-S9-1).
//
// A spreadsheet whose header Bulk add recognised is imported automatically, with an Undo that
// puts the grid back and reopens the column mapper on the same parse. That Undo was cleared only
// by adding, removing or clearing a row. A LIVE push (Create all, Create as load) never cleared
// it and the Undo itself had no busy guard, so:
//   • DURING the push, Undo swapped the grid under createAll, which removes finished rows by the
//     index they had when Create was pressed;
//   • AFTER it, Undo reopened the mapper on the parse holding the orders just created — one
//     Import and one Create away from sending every one of them to NuVizz a second time.
//
// undoAutoImport is RUN out of BulkOrderScreen; the two pushes are read for where they disarm it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const compStart = APP.indexOf('function BulkOrderScreen(');
const COMP = APP.slice(compStart, APP.indexOf('\nfunction ', compStart + 1));

function fnBody(name) {
  const at = COMP.indexOf(`  const ${name} = `);
  assert.ok(at > 0, `${name} is in BulkOrderScreen`);
  return COMP.slice(at, COMP.indexOf('\n  };\n', at) + 5);
}

function undoWith({ busy }) {
  const calls = [];
  let undo = { prevRows: [{ name: 'EARLIER ROW' }], stash: { dataRows: [['a']], mapping: {} } };
  // eslint-disable-next-line no-new-func
  const make = new Function('busy', 'setAutoImportUndo', 'setRows', 'setImportInfo', 'setImporter', 'bulkEmptyRow',
    `'use strict';\n${fnBody('undoAutoImport')}\nreturn undoAutoImport;`);
  const run = make(busy,
    (v) => { undo = typeof v === 'function' ? v(undo) : v; },
    (v) => calls.push(['rows', v]), (v) => calls.push(['info', v]), (v) => calls.push(['mapper', v]), () => ({}));
  run();
  return { calls, undo };
}

test('Undo pressed while a push is running changes nothing — the grid createAll is working through stays put', () => {
  const { calls, undo } = undoWith({ busy: true });
  assert.deepEqual(calls, [], 'no grid swap, no mapper reopened');
  assert.ok(undo, 'and the undo is not spent');
});

test('Undo with nothing running still restores the grid and reopens the mapper, as before', () => {
  const { calls, undo } = undoWith({ busy: false });
  assert.deepEqual(calls.map(([k]) => k).sort(), ['info', 'mapper', 'rows']);
  assert.equal(undo, null);
});

for (const push of ['createAll', 'createAsLoad']) {
  test(`a LIVE ${push} disarms the import Undo before anything reaches NuVizz — the created orders cannot be re-imported from it`, () => {
    const body = fnBody(push);
    const beta = body.indexOf('if (!live) {');
    const disarm = body.indexOf('setAutoImportUndo(null);');
    const firstWrite = body.indexOf('callWrite(');
    assert.ok(beta > 0 && firstWrite > 0, `${push} is shaped as it was`);
    assert.ok(disarm > beta, 'after the Beta early return — a dry run sends nothing, so the Undo still stands');
    assert.ok(disarm < firstWrite, 'and before the first write goes out');
  });
}
