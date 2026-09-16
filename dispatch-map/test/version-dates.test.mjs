// test/version-dates.test.mjs — where the "landed" date on each rollback row comes from.
//
// Chad: "I want date and times those prs merged." The panel prints that date beside a button that
// changes production, so a wrong one is worse than none: it would make "roll back to 11:59pm
// Sept 14" resolve to the wrong build with nothing on screen looking off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionLog, renderModule } from '../scripts/emit-version-dates.mjs';
import { VERSION_DATES } from '../src/lib/version-dates.js';
import { rollbackTargets } from '../src/lib/rollback-targets.js';

const SEP = String.fromCharCode(1);
const logLines = (rows) => rows.map(([sha, secs, ver]) =>
  `COMMIT${SEP}${sha}${SEP}${secs}\n+const APP_VERSION = '${ver}';`).join('\n');

test('the FIRST landing wins when a version ships twice', () => {
  // v1.37.1 really did land twice (a56050b and a376d9a) — two branches claiming one number.
  // git log walks newest-first, so the last line seen is the earliest commit. Taking the last
  // landing would date a version by a later accident.
  const map = parseVersionLog(logLines([
    ['bbbb', 2000, '1.37.1'],   // newer
    ['aaaa', 1000, '1.37.1'],   // older — this is the honest "when did it land"
  ]));
  assert.equal(map['1.37.1'], 1000);
});

test('a version that never ran gets no date, rather than a neighbour\'s', () => {
  // v1.40.0 has a changelog row but never existed as a running APP_VERSION: one commit moved the
  // line 1.39.0 -> 1.41.0 while its subject said (v1.40.0). No source can date it.
  const map = parseVersionLog(logLines([['aaaa', 1000, '1.41.0'], ['bbbb', 900, '1.39.0']]));
  assert.equal(map['1.40.0'], undefined);
  assert.equal(VERSION_DATES['1.40.0'], undefined, 'and the real generated map agrees');
});

test('a commit with no version bump contributes nothing', () => {
  assert.deepEqual(parseVersionLog(`COMMIT${SEP}aaaa${SEP}1000\n someone edited a comment`), {});
  assert.deepEqual(parseVersionLog(''), {});
  assert.deepEqual(parseVersionLog(null), {});
});

test('a REMOVED version line is not read as a landing', () => {
  // `git log -L` prints both -old and +new. Only the + line is a landing.
  const map = parseVersionLog(`COMMIT${SEP}aaaa${SEP}1000\n-const APP_VERSION = '1.0.0';\n+const APP_VERSION = '1.1.0';`);
  assert.deepEqual(map, { '1.1.0': 1000 });
});

test('the generated module is valid JS and newest-first', () => {
  const out = renderModule({ '1.9.0': 300, '1.10.0': 400, '1.2.0': 100 });
  const parsed = new Function(`${out.replace('export const', 'const')}; return VERSION_DATES;`)();
  assert.deepEqual(Object.keys(parsed), ['1.10.0', '1.9.0', '1.2.0'], '1.10.0 sorts above 1.9.0');
  assert.equal(parsed['1.2.0'], new Date(100 * 1000).toISOString());
});

// ── WHAT THE PANEL ACTUALLY GETS ────────────────────────────────────────────

const LOG = [['1.41.0', 'Newer thing.'], ['1.40.0', 'The undateable one.'], ['1.39.0', 'Older thing.']];

test('rollbackTargets carries the landing date onto each row', () => {
  const rows = rollbackTargets(LOG, '1.41.0', 12, { '1.41.0': '2026-09-16T15:28:29Z', '1.39.0': '2026-09-16T14:28:13Z' });
  assert.equal(rows.find((r) => r.version === '1.41.0').at, '2026-09-16T15:28:29Z');
  assert.equal(rows.find((r) => r.version === '1.39.0').at, '2026-09-16T14:28:13Z');
});

test('a row with no date carries null, and the panel prints nothing for it', () => {
  const rows = rollbackTargets(LOG, '1.41.0', 12, { '1.41.0': '2026-09-16T15:28:29Z' });
  assert.equal(rows.find((r) => r.version === '1.40.0').at, null);
});

test('the date map is OPTIONAL — the old three-arg call still works', () => {
  // test/rollback-targets.test.mjs pins the positional `limit` as the third argument.
  const rows = rollbackTargets(LOG, '1.41.0', 2);
  assert.equal(rows.length, 2);
  assert.ok('at' in rows[0], 'every row still has the field, even when unknown');
});

test('a malformed date map degrades to no dates instead of throwing', () => {
  // `undefined` is NOT in this list on purpose: a default parameter only fires on undefined, so
  // passing it explicitly is the same as omitting it and the real map is the correct answer. The
  // first version of this test asserted otherwise and failed against correct code.
  for (const bad of [null, 'nonsense', 42, {}]) {
    const rows = rollbackTargets(LOG, '1.41.0', 12, bad);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].at, null, `${JSON.stringify(bad)} yields no date, not a crash`);
  }
});

test('omitting the map (or passing undefined) uses the generated one', () => {
  assert.equal(rollbackTargets(LOG, '1.41.0', 12, undefined)[0].at, VERSION_DATES['1.41.0']);
  assert.equal(rollbackTargets(LOG, '1.41.0')[0].at, VERSION_DATES['1.41.0']);
});

test('the real map dates the versions Chad was asking about', () => {
  // Cross-checked against the GitHub merge timestamps for #958 and #960.
  assert.match(VERSION_DATES['1.41.0'], /^2026-09-16T15:28:/, '#958 landed 11:28 AM EDT');
  assert.match(VERSION_DATES['1.39.0'], /^2026-09-16T14:28:/, '#960 landed 10:28 AM EDT');
  assert.ok(Object.keys(VERSION_DATES).length > 20, 'the map is populated, not a stub');
});
