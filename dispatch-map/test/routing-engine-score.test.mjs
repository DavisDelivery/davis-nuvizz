// Official challenge scoring metric — exact-port checks + PARITY against the
// official Python implementation (MIT-CAVE/rc-cli scoring/score.py). The
// fixture routing-engine-score-parity.json embeds scores computed by running
// the official Python on the same inputs during the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  scoreRoute, scoreRouteParts, seqDev, erpPerEdit, normalizeMatrix, isInvalid, toScoreList,
} from '../netlify/functions/lib/score.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARITY = JSON.parse(readFileSync(join(__dirname, 'fixtures/routing-engine-score-parity.json'), 'utf8'));

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('identical sequence scores exactly 0', () => {
  const c = PARITY.cases.find((x) => x.name === 'identical');
  assert.equal(scoreRoute(c.actual, c.sub, PARITY.cost), 0);
});

test('full reversal scores 0 — the official metric preserves adjacency (seq_dev=0)', () => {
  // Verified against the official Python: seq_dev of a reversed route is 0, so
  // the product is 0 even though erp_per_edit is not. Port the code, not the
  // intuition.
  const c = PARITY.cases.find((x) => x.name === 'reversed');
  assert.ok(near(seqDev(c.actual, c.sub), 0));
  assert.ok(near(scoreRoute(c.actual, c.sub, PARITY.cost), 0));
});

test('single adjacent swap produces the official positive score', () => {
  const c = PARITY.cases.find((x) => x.name === 'single_swap');
  const got = scoreRoute(c.actual, c.sub, PARITY.cost);
  assert.ok(got > 0);
  assert.ok(near(got, c.expected), `${got} vs official ${c.expected}`);
});

test('PARITY: every fixture case matches the official Python score and components', () => {
  const norm = normalizeMatrix(PARITY.cost);
  for (const c of PARITY.cases) {
    assert.ok(near(seqDev(c.actual, c.sub), c.expected_seq_dev), `${c.name} seq_dev`);
    assert.ok(near(erpPerEdit(c.actual, c.sub, norm), c.expected_erp_per_edit), `${c.name} erp_per_edit`);
    assert.ok(near(scoreRoute(c.actual, c.sub, PARITY.cost), c.expected), `${c.name} score`);
  }
});

test('scoreRouteParts: the decomposition IS the official score — factors multiply back exactly', () => {
  for (const c of PARITY.cases) {
    const p = scoreRouteParts(c.actual, c.sub, PARITY.cost);
    assert.ok(near(p.seq_dev, c.expected_seq_dev), `${c.name} seq_dev part`);
    assert.ok(near(p.erp_per_edit, c.expected_erp_per_edit), `${c.name} erp part`);
    assert.ok(near(p.score, c.expected), `${c.name} product`);
    assert.ok(near(p.score, p.seq_dev * p.erp_per_edit), `${c.name} product identity`);
  }
});

test('normalizeMatrix: population z-score shifted so the minimum is exactly 0', () => {
  const mat = { a: { a: 0, b: 10 }, b: { a: 20, b: 0 } };
  const norm = normalizeMatrix(mat);
  const values = [norm.a.a, norm.a.b, norm.b.a, norm.b.b];
  assert.ok(near(Math.min(...values), 0));
  // mean 7.5, population std sqrt(68.75); check one entry end-to-end
  const std = Math.sqrt(68.75);
  assert.ok(near(norm.b.a, (20 - 7.5) / std - (0 - 7.5) / std));
});

test('isInvalid: length, set, and first-stop rules', () => {
  assert.equal(isInvalid(['D', 'a', 'b', 'D'], ['D', 'b', 'a', 'D']), false);
  assert.equal(isInvalid(['D', 'a', 'b', 'D'], ['D', 'a', 'D']), true);          // length
  assert.equal(isInvalid(['D', 'a', 'b', 'D'], ['D', 'a', 'c', 'D']), true);     // set
  assert.equal(isInvalid(['D', 'a', 'b', 'D'], ['a', 'D', 'b', 'D']), true);     // first stop
});

test('toScoreList wraps the ordered stops with the depot at both ends', () => {
  assert.deepEqual(toScoreList('D', ['a', 'b']), ['D', 'a', 'b', 'D']);
});
