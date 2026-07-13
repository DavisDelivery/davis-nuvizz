// test/history-customers.test.mjs
//
// Unit tests for the PURE per-customer history rollup logic
// (lib/history-customers.mts): mergeProEntries + buildRollupsFromStops.
// Run with: npm test  (node --test strips .mts types natively on Node ≥ 22).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeProEntries, buildRollupsFromStops, MAX_PROS,
  nameSearchTokens, queryWords, matchesAllWords,
} from '../netlify/functions/lib/history-customers.mts';

test('nameSearchTokens: prefix-grams of every word find a word anywhere in the name', () => {
  const t = nameSearchTokens('SOLID LOCKSMITH');
  assert.ok(t.includes('so') && t.includes('solid'));
  assert.ok(t.includes('lo') && t.includes('lock') && t.includes('locksmith'));
  assert.ok(!t.includes('l')); // single chars excluded
});

test('nameSearchTokens: strips punctuation, lowercases', () => {
  const t = nameSearchTokens("A&M Supply, Inc.");
  assert.ok(t.includes('supply'));
  assert.ok(t.includes('su'));
});

test('queryWords: keeps words length >= 2', () => {
  assert.deepEqual(queryWords('  Solid  A lock '), ['solid', 'lock']);
  assert.deepEqual(queryWords('locksmith'), ['locksmith']);
});

test('matchesAllWords: ANDs every query word against stored tokens', () => {
  const tokens = nameSearchTokens('SOLID LOCKSMITH');
  assert.equal(matchesAllWords(tokens, ['locksmith']), true);   // mid-name word
  assert.equal(matchesAllWords(tokens, ['lock']), true);        // partial mid-name word
  assert.equal(matchesAllWords(tokens, ['solid', 'lock']), true); // both words
  assert.equal(matchesAllWords(tokens, ['solid', 'steel']), false); // steel not present
  assert.equal(matchesAllWords(tokens, []), false);
});

// ── Initialism search (BUFORD Jul 13: "E R SNELL CONTRACTOR" invisible for "er snell") ──
test('nameSearchTokens: joins a run of single-letter words into a searchable token', () => {
  // The customer is stored as "E R SNELL CONTRACTOR" — the "E.R." abbreviation. The old
  // tokenizer dropped the single letters, so no "er" token existed and "er snell" found nothing.
  const t = nameSearchTokens('E R SNELL CONTRACTOR');
  assert.ok(t.includes('er'), 'the initialism E R yields a joined "er" token');
  assert.ok(t.includes('snell') && t.includes('sn'));
  assert.ok(t.includes('contractor'));
});

test('nameSearchTokens: periods in an initialism also yield the joined token', () => {
  const t = nameSearchTokens('E.R. SNELL CONTRACTOR, INC');
  assert.ok(t.includes('er'), 'E.R. → er (periods become spaces, then the run joins)');
  assert.ok(t.includes('snell'));
});

test('nameSearchTokens: a 3-letter initialism yields prefixes (abc → ab, abc)', () => {
  const t = nameSearchTokens('A B C HOLDINGS');
  assert.ok(t.includes('ab') && t.includes('abc'));
  assert.ok(t.includes('holdings'));
});

test('nameSearchTokens: an isolated single letter is still not a token (no false run)', () => {
  const t = nameSearchTokens('J CREW');   // one single letter, no run to join
  assert.ok(!t.includes('j'));
  assert.ok(t.includes('crew') && t.includes('cr'));
});

test('matchesAllWords: "er snell" now matches E R SNELL CONTRACTOR (the reported case)', () => {
  const tokens = nameSearchTokens('E R SNELL CONTRACTOR');
  assert.equal(matchesAllWords(tokens, queryWords('er snell')), true);
  assert.equal(matchesAllWords(tokens, queryWords('snell')), true);       // single word already worked
  assert.equal(matchesAllWords(tokens, queryWords('er contractor')), true);
  assert.equal(matchesAllWords(tokens, queryWords('er publix')), false);  // publix not present
});

test('mergeProEntries: de-dupes by pro keeping the latest date, newest first', () => {
  const out = mergeProEntries(
    [{ pro: 'A', date: '2026-06-01' }, { pro: 'B', date: '2026-06-03' }],
    [{ pro: 'A', date: '2026-06-10' }, { pro: 'C', date: '2026-06-05' }],
  );
  assert.deepEqual(out.map((p) => p.pro), ['A', 'C', 'B']); // A bumped to 06-10
  assert.equal(out.find((p) => p.pro === 'A').date, '2026-06-10');
});

test('mergeProEntries: caps at max (newest kept)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ pro: `P${i}`, date: `2026-06-${String(i + 1).padStart(2, '0')}` }));
  const out = mergeProEntries([], many, MAX_PROS);
  assert.equal(out.length, MAX_PROS);
  assert.equal(out[0].pro, 'P29'); // newest first
  assert.equal(out[out.length - 1].pro, 'P10'); // oldest of the kept 20
});

test('mergeProEntries: ignores empty/malformed entries', () => {
  const out = mergeProEntries([{ pro: '', date: 'x' }, null], [{ pro: 'A' }]);
  assert.deepEqual(out, [{ pro: 'A', date: '', driver: null }]);
});

test('mergeProEntries: carries the driver (who delivered) through', () => {
  const out = mergeProEntries(
    [{ pro: 'A', date: '2026-06-01', driver: 'VINCENT SMITH' }],
    [{ pro: 'B', date: '2026-06-03', driver: 'JEAN DELSOIN' }],
  );
  assert.equal(out.find((p) => p.pro === 'A').driver, 'VINCENT SMITH');
  assert.equal(out.find((p) => p.pro === 'B').driver, 'JEAN DELSOIN');
});

test('mergeProEntries: same-date driver-bearing entry replaces a driverless one (backfill)', () => {
  // A stored driverless entry + a warehouse re-derivation at the SAME date must
  // take the driver — otherwise a backfill silently no-ops.
  const out = mergeProEntries(
    [{ pro: 'A', date: '2026-06-01', driver: null }],
    [{ pro: 'A', date: '2026-06-01', driver: 'VINCENT SMITH' }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].driver, 'VINCENT SMITH');
});

test('mergeProEntries: an existing driver is NOT clobbered by a later driverless dupe at equal date', () => {
  const out = mergeProEntries(
    [{ pro: 'A', date: '2026-06-01', driver: 'VINCENT SMITH' }],
    [{ pro: 'A', date: '2026-06-01', driver: null }],
  );
  assert.equal(out[0].driver, 'VINCENT SMITH');
});

test('buildRollupsFromStops: captures the delivering driver per PRO', () => {
  const stops = [
    { customerMatchKey: 'k1', businessName: 'ACME', pro: 'P1', date: '2026-06-19', driverName: 'JEAN DELSOIN' },
    { customerMatchKey: 'k1', businessName: 'ACME', pro: 'P2', date: '2026-06-19', driverUserName: 'jdoe' },
    { customerMatchKey: 'k1', businessName: 'ACME', pro: 'P3', date: '2026-06-19' },
  ];
  const k1 = buildRollupsFromStops(stops).get('k1');
  const byPro = Object.fromEntries(k1.pros.map((p) => [p.pro, p.driver]));
  assert.equal(byPro.P1, 'JEAN DELSOIN');      // driverName wins
  assert.equal(byPro.P2, 'jdoe');              // falls back to driverUserName
  assert.equal(byPro.P3, null);                // unplanned/no driver → null
});

test('buildRollupsFromStops: groups by customerMatchKey and collects pros', () => {
  const stops = [
    { customerMatchKey: 'k1', businessName: 'SOLID LOCKSMITH', addr1: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', pro: '007135610', date: '2026-06-19' },
    { customerMatchKey: 'k1', businessName: 'SOLID LOCKSMITH', addr1: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', pro: '007135611', date: '2026-06-19' },
    { customerMatchKey: 'k2', businessName: 'KINETICO', addr1: '9 B Rd', city: 'Marietta', state: 'GA', zip: '30060', pro: 'AVRT-1', date: '2026-06-19' },
  ];
  const map = buildRollupsFromStops(stops);
  assert.equal(map.size, 2);
  const k1 = map.get('k1');
  assert.equal(k1.name, 'SOLID LOCKSMITH');
  assert.equal(k1.city, 'Atlanta');
  assert.deepEqual(k1.pros.map((p) => p.pro).sort(), ['007135610', '007135611']);
  assert.equal(map.get('k2').pros[0].pro, 'AVRT-1');
});

test('buildRollupsFromStops: latest date wins for identity', () => {
  const stops = [
    { customerMatchKey: 'k', businessName: 'OLD NAME', addr1: 'old', pro: 'P1', date: '2026-06-01' },
    { customerMatchKey: 'k', businessName: 'NEW NAME', addr1: 'new', pro: 'P2', date: '2026-06-10' },
  ];
  const cur = buildRollupsFromStops(stops).get('k');
  assert.equal(cur.name, 'NEW NAME');
  assert.equal(cur.addr1, 'new');
  assert.equal(cur.last_date, '2026-06-10');
  assert.equal(cur.pros[0].pro, 'P2'); // newest first
});

test('buildRollupsFromStops: skips stops with no matchKey and no pro', () => {
  const stops = [
    { businessName: 'NO KEY', pro: 'X', date: '2026-06-01' }, // no customerMatchKey → skipped
    { customerMatchKey: 'k', businessName: 'HAS KEY', date: '2026-06-02' }, // no pro → kept as customer, empty pros
  ];
  const map = buildRollupsFromStops(stops);
  assert.equal(map.size, 1);
  assert.equal(map.get('k').name, 'HAS KEY');
  assert.deepEqual(map.get('k').pros, []);
});
