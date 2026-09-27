// test/address-queue-wave-off-sticks.test.mjs — "Wave off" on the problem-address queue has to
// STICK, and "Undo" has to bring the row back.
//
// THE DEFECT (audit 2026-09-27, firestore-history-address-1). The dismissal was written with
// updateDocFields(path, { date, ['items.<key>']: record }). That helper puts each object key
// straight into the REST body's `fields` map, where a key is a literal field NAME — so the
// body carried a top-level field literally called "items.no_pin__007174397" and no `items`
// map at all — and into updateMask.fieldPaths, where the same unquoted string is a nested
// PATH (items → no_pin__007174397) the body does not contain. Firestore applies a masked
// path that is absent from the body as a delete, so nothing landed. The reader looks in
// `items[key]`, found nothing, and the row came straight back while the POST had answered
// { ok: true, dismissed: true } — an intent reported as an outcome.
//
// WHY THIS TEST WRAPS THE FAKE. test/_firestore-fake.mjs applies a mask one TOP-LEVEL key at
// a time, so under it the broken write "worked" as a literal dotted field name and the bug
// was invisible. This file layers Firestore's documented field-path semantics over the fake
// for any PATCH whose mask names a nested path (a '.' or a backtick): each masked path is SET
// from the body when the body holds it and DELETED when it does not; fields outside the mask
// are untouched. Everything else passes through to the shared fake unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const DAY = '2026-09-10';
const STOP_PATH = `nuvizz_stop_index/davis__${DAY}/stops/007174397`;
const DISMISS_PATH = `address_queue_dismissals/${DAY}`;

// A stop with no coordinates and no customer note: the queue files it as `no_pin`.
const seed = () => ({
  [STOP_PATH]: {
    stopNbr: '007174397', businessName: 'LED ENERGY PLUS',
    addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071',
    isPlanned: true, routeName: 'NOR 2',
  },
});

// ── Firestore field-path semantics, for the test only ────────────────────────
/** "items.`a-b`.c" → ['items', 'a-b', 'c'] — backtick-quoted segments, with \` and \\ escapes. */
function parseFieldPath(p) {
  const segs = [];
  let i = 0;
  while (i < p.length) {
    let seg = '';
    if (p[i] === '`') {
      i += 1;
      while (i < p.length && p[i] !== '`') {
        if (p[i] === '\\' && i + 1 < p.length) { seg += p[i + 1]; i += 2; } else { seg += p[i]; i += 1; }
      }
      i += 1; // closing backtick
    } else {
      while (i < p.length && p[i] !== '.') { seg += p[i]; i += 1; }
    }
    segs.push(seg);
    if (p[i] === '.') i += 1;
  }
  return segs;
}
const has = (obj, segs) => {
  let cur = obj;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, s)) return false;
    cur = cur[s];
  }
  return true;
};
const getAt = (obj, segs) => segs.reduce((cur, s) => cur[s], obj);
function setAt(obj, segs, val) {
  let cur = obj;
  for (const s of segs.slice(0, -1)) {
    if (!cur[s] || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = val;
}
function deleteAt(obj, segs) {
  let cur = obj;
  for (const s of segs.slice(0, -1)) { if (!cur || typeof cur !== 'object') return; cur = cur[s]; }
  if (cur && typeof cur === 'object') delete cur[segs[segs.length - 1]];
}
const decVal = (v) => {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decVal(x)]));
  return null;
};

function installWithFieldPaths() {
  const fake = installFirestoreFake(seed());
  const inner = globalThis.fetch;
  const patches = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'PATCH' && url.includes('firestore.googleapis.com')) {
      const mask = new URL(url).searchParams.getAll('updateMask.fieldPaths');
      if (mask.some((m) => m.includes('.') || m.includes('`'))) {
        const path = decodeURIComponent(url.match(/\/documents\/(.+?)(\?|$)/)[1]);
        const body = Object.fromEntries(Object.entries(JSON.parse(String(init.body)).fields || {}).map(([k, v]) => [k, decVal(v)]));
        const next = structuredClone(fake.store.get(path) || {});
        for (const m of mask) {
          const segs = parseFieldPath(m);
          if (has(body, segs)) setAt(next, segs, structuredClone(getAt(body, segs)));
          else deleteAt(next, segs);
        }
        patches.push({ path, mask, bodyKeys: Object.keys(body) });
        fake.store.set(path, next);
        return new Response('{}', { status: 200 });
      }
    }
    return inner(input, init);
  };
  return { ...fake, patches, restore: () => { globalThis.fetch = inner; fake.restore(); } };
}

async function handler() {
  return (await import('../netlify/functions/address-queue.mts')).default;
}
const getQueue = async (h, extra = '') => (await h(new Request(`https://x.netlify.app/.netlify/functions/address-queue?from=${DAY}&to=${DAY}${extra}`))).json();
const post = async (h, body) => (await h(new Request('https://x.netlify.app/.netlify/functions/address-queue', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))).json();

test('a dispatcher who waves off a no-pin row does not see it again on the next load', async () => {
  const fake = installWithFieldPaths();
  try {
    const h = await handler();
    const first = await getQueue(h);
    assert.equal(first.ok, true);
    const row = first.days[0].rows[0];
    assert.equal(row.signal, 'no_pin');
    assert.equal(row.key, 'no_pin__007174397');

    const res = await post(h, { date: DAY, key: row.key, fp: row.fp, signal: row.signal, stopNbr: row.stopNbr, by: 'dev-9F2A', why: 'customer pickup' });
    assert.equal(res.ok, true);
    assert.equal(res.dismissed, true);

    const stored = fake.store.get(DISMISS_PATH);
    assert.equal(stored?.items?.[row.key]?.fp, row.fp, 'the dismissal is stored INSIDE the items map, where the reader looks');
    assert.equal(stored?.date, DAY);

    const second = await getQueue(h);
    assert.equal(second.days[0].rows.length, 0, 'the waved-off row stays gone');
    assert.equal(second.summary.dismissed, 1);
    assert.equal(second.summary.no_pin, 0);

    // It is still there for the dispatcher who asks to see waved-off rows, with who and why.
    const withDismissed = await getQueue(h, '&dismissed=1');
    const shown = withDismissed.days[0].rows[0];
    assert.equal(shown.dismissed, true);
    assert.equal(shown.dismissedWhy, 'customer pickup');
  } finally { fake.restore(); }
});

test('Undo on a waved-off row brings it back on the next load', async () => {
  const fake = installWithFieldPaths();
  try {
    const h = await handler();
    const row = (await getQueue(h)).days[0].rows[0];
    await post(h, { date: DAY, key: row.key, fp: row.fp, signal: row.signal, stopNbr: row.stopNbr });
    assert.equal((await getQueue(h)).days[0].rows.length, 0);

    const undo = await post(h, { date: DAY, key: row.key, undo: true });
    assert.equal(undo.ok, true);
    const back = await getQueue(h);
    assert.equal(back.days[0].rows.length, 1, 'the row is back');
    assert.equal(back.summary.dismissed, 0);
  } finally { fake.restore(); }
});

test('two dispatchers waving off two rows on the same day both land (the write stays field-masked)', async () => {
  const fake = installWithFieldPaths();
  fake.store.set(`nuvizz_stop_index/davis__${DAY}/stops/007174398`, {
    stopNbr: '007174398', businessName: 'ACME', addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518',
  });
  try {
    const h = await handler();
    const rows = (await getQueue(h)).days[0].rows;
    assert.equal(rows.length, 2);
    for (const r of rows) await post(h, { date: DAY, key: r.key, fp: r.fp, signal: r.signal, stopNbr: r.stopNbr });
    const after = await getQueue(h);
    assert.equal(after.days[0].rows.length, 0, 'the second dismissal did not erase the first');
    assert.equal(after.summary.dismissed, 2);
    // Never a whole-document replace: every dismissal write names its paths.
    assert.ok(fake.patches.length >= 2);
    assert.equal(fake.log.sets.filter((s) => s.path === DISMISS_PATH).length, 0);
  } finally { fake.restore(); }
});

test('a key with a hyphen (a sanitised PRO) is quoted in the field path, so it is one segment', async () => {
  const { mapEntryPatch, quoteFieldPathSegment } = await import('../netlify/functions/lib/firestore-field-path.mts');
  assert.equal(quoteFieldPathSegment('no_pin__007174397'), 'no_pin__007174397');
  assert.equal(quoteFieldPathSegment('mis_split__avrt-0028093763'), '`mis_split__avrt-0028093763`');
  assert.equal(quoteFieldPathSegment('a`b\\c'), '`a\\`b\\\\c`');
  const p = mapEntryPatch({ date: DAY }, 'items', 'mis_split__avrt-0028093763', { fp: 'x' });
  assert.deepEqual(p.fieldPaths, ['date', 'items.`mis_split__avrt-0028093763`']);
  assert.deepEqual(p.data, { date: DAY, items: { 'mis_split__avrt-0028093763': { fp: 'x' } } });
  assert.deepEqual(parseFieldPath(p.fieldPaths[1]), ['items', 'mis_split__avrt-0028093763']);
});
