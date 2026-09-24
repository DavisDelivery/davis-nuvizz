// test/claude-shadow-settings.test.mjs — THE CLAUDE SHADOW'S CAPACITY SETTINGS: a person's number
// replaces the learned one, a cleared box never becomes a truck that holds nothing, two people
// saving at once never erase each other, and every answer says what actually happened.
//
// Chad, 2026-09-24: "truck capacity should be learned from all the data we have and we should have
// a ui where we can customize it." Every test names the mistake it prevents at the dock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  validateSettingsChange, withOverrides, capDocId, capDocPath, capsFromDocs, ratioInForce,
  CAP_BOUNDS, LOOSE_PER_SKID_BOUNDS, CAPS_COLLECTION, SETTINGS_LOG_COLLECTION,
} from '../netlify/functions/lib/claude-shadow/settings-core.mts';
import { saveSettings, readSettings } from '../netlify/functions/lib/claude-shadow/settings.mts';
import { CAPACITY_PATH, SETTINGS_PATH, LEARN_VERSION } from '../netlify/functions/lib/claude-shadow/learn-core.mts';
import { runLearn, rebuildModel } from '../netlify/functions/lib/claude-shadow/learn.mts';

// ── what a change may say ────────────────────────────────────────────────────

test('A CLEARED BOX IS NOT A CAP OF 0: a blank cap or ratio is refused — only an explicit null clears', () => {
  for (const blank of ['', '   ']) {
    const r = validateSettingsChange({ caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: blank }] });
    assert.equal(r.ok, false, JSON.stringify(blank));
    assert.match(r.errors[0], /blank/);
    assert.equal(validateSettingsChange({ loosePerSkid: blank }).ok, false);
  }
  const clear = validateSettingsChange({ caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: null }] });
  assert.equal(clear.ok, true);
  assert.equal(clear.normalized.caps[0].cap, null);
});

test('NOTHING IS COERCED into a cap: true, [5], "0x1A", Infinity, 1e1-as-text and objects are refused, not read as 1, 5 or 26', () => {
  for (const bad of [true, false, [5], {}, '0x1A', '0b11', '1e1', Infinity, NaN, 'twenty']) {
    assert.equal(validateSettingsChange({ caps: [{ kind: 'route', name: 'SUW 9', cap: bad }] }).ok, false, String(bad));
    assert.equal(validateSettingsChange({ loosePerSkid: bad }).ok, false, `ratio ${String(bad)}`);
  }
  for (const badName of [{}, 123, ['a'], true, null]) {
    assert.equal(validateSettingsChange({ caps: [{ kind: 'driver', name: badName, cap: 5 }] }).ok, false, JSON.stringify(badName));
  }
});

test('a cap outside 1–60 skid spots, zero or negative is refused with the reason', () => {
  for (const bad of [0, -3, 61, 180, '0', '61']) assert.equal(validateSettingsChange({ caps: [{ kind: 'route', name: 'SUW 9', cap: bad }] }).ok, false, String(bad));
  assert.deepEqual(CAP_BOUNDS, [1, 60]);
  for (const bad of [0, 101]) assert.equal(validateSettingsChange({ loosePerSkid: bad }).ok, false, String(bad));
  assert.deepEqual(LOOSE_PER_SKID_BOUNDS, [1, 100]);
});

test('a good change reads typed decimals, keeps one decimal place, and keys names the way the learned model does', () => {
  const r = validateSettingsChange({ loosePerSkid: ' 8 ', caps: [{ kind: 'driver', name: 'Ben  Paintsil ', cap: '18.25' }] });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.normalized.loosePerSkid, 8);
  assert.deepEqual(r.normalized.caps[0], { kind: 'driver', key: 'BEN PAINTSIL', name: 'Ben Paintsil', cap: 18.3 });
});

test('ONE BAD ROW REFUSES THE WHOLE CHANGE, and a change naming nothing, no kind, no name or a duplicate is refused', () => {
  assert.equal(validateSettingsChange({ loosePerSkid: 8, caps: [{ kind: 'driver', name: 'A', cap: 18 }, { kind: 'driver', name: 'B', cap: '' }] }).ok, false);
  assert.equal(validateSettingsChange({ caps: [{ kind: 'truck', name: 'A', cap: 5 }] }).ok, false);
  assert.equal(validateSettingsChange({ caps: [{ kind: 'driver', name: '  ', cap: 5 }] }).ok, false);
  assert.equal(validateSettingsChange({ caps: [{ kind: 'driver', name: 'A', cap: 5 }, { kind: 'driver', name: 'a', cap: 6 }] }).ok, false);
  assert.equal(validateSettingsChange({}).ok, false);
  assert.equal(validateSettingsChange(null).ok, false);
  assert.equal(validateSettingsChange([]).ok, false);
});

// ── where a cap is kept ──────────────────────────────────────────────────────

test('EACH CAP IS ITS OWN DOCUMENT, and no two names can share one — "COLIN/DJ 1" is a legal, distinct id', () => {
  assert.equal(capDocId('route', 'COLIN/DJ 1'), 'route__COLIN(2f)DJ 1');
  assert.notEqual(capDocId('route', 'COLIN/DJ 1'), capDocId('route', 'COLIN(2F)DJ 1'), 'the escape characters are escaped too');
  assert.notEqual(capDocId('driver', 'BEN 1'), capDocId('route', 'BEN 1'));
  assert.equal(capDocPath('driver', 'BEN PAINTSIL'), `${CAPS_COLLECTION}/driver__BEN PAINTSIL`);
  assert.equal(capDocId('driver', '__X__').startsWith('driver__'), true, 'never a reserved __…__ id');
});

// ── what the screen shows ────────────────────────────────────────────────────

const model = {
  loosePerSkid: 10,
  drivers: [{ key: 'BEN PAINTSIL', name: 'Ben Paintsil', cap: 16, trips: 40 }, { key: 'JOHN SMITH', name: 'John Smith', cap: null, trips: 6 }],
  routes: [{ key: 'SUW 9', name: 'SUW 9', cap: 21, trips: 44 }],
};

test('YOUR CAP REPLACES THE LEARNED ONE for that driver, and each row says which it is and who set it', () => {
  const m = withOverrides(model, capsFromDocs([{ kind: 'driver', key: 'BEN PAINTSIL', name: 'Ben Paintsil', cap: 18, by: 'dispatcher', at: 't' }]));
  const ben = m.drivers.find((d) => d.key === 'BEN PAINTSIL');
  assert.deepEqual({ yourCap: ben.yourCap, capUsed: ben.capUsed, capSource: ben.capSource, learned: ben.cap, by: ben.yourCapBy }, { yourCap: 18, capUsed: 18, capSource: 'yours', learned: 16, by: 'dispatcher' });
  const john = m.drivers.find((d) => d.key === 'JOHN SMITH');
  assert.deepEqual({ capUsed: john.capUsed, capSource: john.capSource }, { capUsed: null, capSource: null }, 'no history, no cap of yours: none — never a guess');
  assert.equal(m.routes[0].capSource, 'learned');
});

test('SETTINGS THAT CANNOT BE READ are shown as UNKNOWN on every row — never as "learned, nothing of yours"', () => {
  const m = withOverrides(model, null, { unknown: true });
  for (const r of [...m.drivers, ...m.routes]) { assert.equal(r.capSource, 'unknown'); assert.equal(r.capUsed, null); }
});

test('a cap for a driver with NO history yet (a new hire) is still shown, so it can be seen and cleared', () => {
  const m = withOverrides(model, capsFromDocs([{ kind: 'driver', key: 'NEW HIRE', name: 'New Hire', cap: 14 }]));
  const n = m.drivers.find((d) => d.key === 'NEW HIRE');
  assert.equal(n.noHistory, true);
  assert.equal(n.capUsed, 14);
});

test('ratioInForce: absent or out-of-range is the default 10', () => {
  assert.equal(ratioInForce(null), 10);
  assert.equal(ratioInForce({ loosePerSkid: null }), 10);
  assert.equal(ratioInForce({ loosePerSkid: 500 }), 10);
  assert.equal(ratioInForce({ loosePerSkid: 5 }), 5);
});

// ── the save, against the real store and a fake Firestore ────────────────────

const ENV_KEYS = ['CLAUDE_SHADOW', 'FIRESTORE_DATABASE'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const row = (o) => ({ status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, stopType: 'DO', routeName: 'BEN 1', driverName: 'Ben  Paintsil', ...o });
function seed() {
  return {
    'history_days/davis__2026-09-23': { complete: true, verified: true, captured_at: 'c' },
    'history_days/davis__2026-09-23/stops/A': row({ stopNbr: 'A', cartons: 17 }),
    'history_days/davis__2026-09-23/stops/B': row({ stopNbr: 'B', volume: 30 }),
    'nuvizz_load_roster/davis__2026-09-23': { loadsJson: JSON.stringify([{ name: 'BEN 1', trips: 2, status: 'Dispatched' }]) },
  };
}
const post = (b) => new Request('https://x/.netlify/functions/claude-shadow', { method: 'POST', body: JSON.stringify(b) });
const handler = async () => (await import('../netlify/functions/claude-shadow.mts')).default;
const noCall = () => { throw new Error('no call off-box expected'); };

test('SAVING A CAP writes that cap’s document and a log row — nothing else — and the tab reads it back with who set it', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      await runLearn({ trigger: 'manual' });
      const before = new Map(fake.store);
      const h = await handler();
      const res = await h(post({ action: 'settings', change: { caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: 18 }] } }));
      const j = await res.json();
      assert.equal(res.status, 200, JSON.stringify(j));
      assert.deepEqual(j.results.map((r) => r.outcome), ['saved']);
      const changed = [...fake.store.keys()].filter((k) => JSON.stringify(fake.store.get(k)) !== JSON.stringify(before.get(k)));
      assert.deepEqual(changed.filter((k) => !k.startsWith(`${SETTINGS_LOG_COLLECTION}/`)), [capDocPath('driver', 'BEN PAINTSIL')]);
      const logs = changed.filter((k) => k.startsWith(`${SETTINGS_LOG_COLLECTION}/`));
      assert.equal(logs.length, 1);
      assert.deepEqual({ before: fake.store.get(logs[0]).before, after: fake.store.get(logs[0]).after }, { before: null, after: 18 });
      const got = await (await h(new Request('https://x/.netlify/functions/claude-shadow'))).json();
      const ben = got.learned.drivers.find((d) => d.key === 'BEN PAINTSIL');
      assert.deepEqual({ yourCap: ben.yourCap, capUsed: ben.capUsed, capSource: ben.capSource }, { yourCap: 18, capUsed: 18, capSource: 'yours' });
      assert.ok(ben.yourCapAt, 'when it was set is shown');
    } finally { fake.restore(); }
  });
});

test('TWO DISPATCHERS SAVING AT ONCE never erase each other: each cap is its own document', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const h = await handler();
      const [a, b] = await Promise.all([
        h(post({ action: 'settings', change: { caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: 14 }] } })),
        h(post({ action: 'settings', change: { caps: [{ kind: 'route', name: 'SUW 9', cap: 20 }] } })),
      ]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      const caps = capsFromDocs((await readSettings()).caps ? [...fake.store.entries()].filter(([k]) => k.startsWith(`${CAPS_COLLECTION}/`)).map(([, v]) => v) : []);
      assert.equal(caps.drivers['BEN PAINTSIL'].cap, 14);
      assert.equal(caps.routes['SUW 9'].cap, 20);
    } finally { fake.restore(); }
  });
});

test('CLEARING a cap deletes its document and LOGS who took it off — the trace survives the clear', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const h = await handler();
      await h(post({ action: 'settings', change: { caps: [{ kind: 'route', name: 'BEN 1', cap: 20 }] } }));
      const res = await h(post({ action: 'settings', change: { caps: [{ kind: 'route', name: 'BEN 1', cap: null }] } }));
      assert.equal(res.status, 200);
      assert.equal(fake.store.get(capDocPath('route', 'BEN 1')), undefined);
      const logs = [...fake.store.entries()].filter(([k]) => k.startsWith(`${SETTINGS_LOG_COLLECTION}/`)).map(([, v]) => v);
      assert.deepEqual(logs.map((l) => [l.before, l.after]).sort(), [[20, null], [null, 20]].sort());
    } finally { fake.restore(); }
  });
});

test('A NEW RATIO REBUILDS every learned number straight away: 17 skids + 30 loose is 23 spots at 5 a spot — and the ratio records who and when', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      await runLearn({ trigger: 'manual' });
      assert.equal(fake.store.get(CAPACITY_PATH).drivers[0].max, 20);
      const j = await (await (await handler())(post({ action: 'settings', change: { loosePerSkid: 5 } }))).json();
      assert.equal(j.ok, true, JSON.stringify(j));
      assert.equal(j.rebuilt, true);
      const m = fake.store.get(CAPACITY_PATH);
      assert.deepEqual({ lps: m.loosePerSkid, src: m.loosePerSkidSource, max: m.drivers[0].max, v: m.learnVersion }, { lps: 5, src: 'setting', max: 23, v: LEARN_VERSION });
      const st = fake.store.get(SETTINGS_PATH);
      assert.equal(st.loosePerSkid, 5);
      assert.ok(st.loosePerSkidAt);
    } finally { fake.restore(); }
  });
});

test('AFTER A FAILED REBUILD, saving again RETRIES it — judged from the stored numbers, not "did this request move the ratio"', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      await runLearn({ trigger: 'manual' });
      const f = await import('../netlify/functions/lib/firestore.mts');
      const st = await import('../netlify/functions/lib/claude-shadow/store.mts');
      const deps = (rebuild) => ({ getDoc: f.getDoc, listDocs: f.listDocs, shadowSet: st.shadowSet, shadowPatch: st.shadowPatch, shadowDelete: st.shadowDelete, shadowCreate: st.shadowCreate, rebuild, now: () => new Date() });
      const r1 = await saveSettings({ loosePerSkid: 5 }, 'dispatcher', deps(async () => { throw new Error('503'); }));
      assert.equal(r1.body.ok, true, 'the ratio itself saved');
      assert.match(r1.body.rebuildError, /not at the saved ratio/);
      assert.equal(fake.store.get(CAPACITY_PATH).loosePerSkid, 10, 'the numbers are still at 10');
      const got = await (await (await handler())(new Request('https://x/.netlify/functions/claude-shadow'))).json();
      assert.equal(got.settings.ratioPending, true, 'the screen is told the numbers are behind the setting');
      const r2 = await saveSettings({ caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: 18 }] }, 'dispatcher', deps((s) => rebuildModel(undefined, s)));
      assert.equal(r2.body.rebuilt, true);
      assert.equal(fake.store.get(CAPACITY_PATH).loosePerSkid, 5);
    } finally { fake.restore(); }
  });
});

test('A WRITE THAT TIMES OUT BUT LANDED is read back and reported saved — never "not saved" about a cap that is live', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const f = await import('../netlify/functions/lib/firestore.mts');
      const st = await import('../netlify/functions/lib/claude-shadow/store.mts');
      const deps = {
        getDoc: f.getDoc, listDocs: f.listDocs, shadowPatch: st.shadowPatch, shadowDelete: st.shadowDelete, shadowCreate: st.shadowCreate,
        shadowSet: async (p, d) => { await st.shadowSet(p, d); throw new Error('no answer within 20000ms'); },
        rebuild: async () => null, now: () => new Date('2026-09-24T14:00:00Z'),
      };
      const r = await saveSettings({ caps: [{ kind: 'driver', name: 'Ben Paintsil', cap: 18 }] }, 'dispatcher', deps);
      assert.equal(r.status, 200);
      assert.equal(r.body.results[0].outcome, 'saved');
      const lost = { ...deps, shadowSet: async () => { throw new Error('no answer within 20000ms'); } };
      const r2 = await saveSettings({ caps: [{ kind: 'route', name: 'SUW 9', cap: 20 }] }, 'dispatcher', lost);
      assert.equal(r2.status, 502);
      assert.equal(r2.body.results[0].outcome, 'failed', 'read back and not there: failed, with the reason');
      const blind = { ...lost, getDoc: async (p) => (p.startsWith(CAPS_COLLECTION) ? Promise.reject(new Error('503')) : f.getDoc(p)) };
      const r3 = await saveSettings({ caps: [{ kind: 'route', name: 'SUW 10', cap: 20 }] }, 'dispatcher', blind);
      assert.equal(r3.body.results[0].outcome, 'unknown', 'cannot read it back either: says it does not know');
    } finally { fake.restore(); }
  });
});

test('A LEARNING RUN OVERLAPPING A SAVE cannot leave the numbers at the old ratio: every rebuild re-checks the ratio after its own write', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      await runLearn({ trigger: 'manual' });
      const f = await import('../netlify/functions/lib/firestore.mts');
      const st = await import('../netlify/functions/lib/claude-shadow/store.mts');
      // The run read the ratio (10) before the save; the save lands while the run builds.
      let saved = false;
      const deps = {
        getDoc: f.getDoc, listDocs: f.listDocs, now: () => new Date(),
        shadowSet: async (p, d) => {
          if (!saved && p === CAPACITY_PATH) { saved = true; await st.shadowPatch(SETTINGS_PATH, { loosePerSkid: 5 }); }
          return st.shadowSet(p, d);
        },
      };
      const m = await rebuildModel(deps, { loosePerSkid: 10 });
      assert.equal(m.loosePerSkid, 5, 'the run noticed the new ratio after its write and rebuilt');
      assert.equal(fake.store.get(CAPACITY_PATH).loosePerSkid, 5);
    } finally { fake.restore(); }
  });
});

test('a REFUSED change answers 400 with every reason and writes NOTHING', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const res = await (await handler())(post({ action: 'settings', change: { loosePerSkid: '', caps: [{ kind: 'driver', name: 'A', cap: 0 }] } }));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).errors.length, 2);
      assert.equal(fake.log.sets.length + fake.log.commits.length + fake.log.deletes.length, 0);
    } finally { fake.restore(); }
  });
});

test('settings that cannot be READ before a save refuse the save (502) — nothing written on a guess', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const f = await import('../netlify/functions/lib/firestore.mts');
      const st = await import('../netlify/functions/lib/claude-shadow/store.mts');
      const r = await saveSettings({ caps: [{ kind: 'driver', name: 'A', cap: 5 }] }, 'x', {
        getDoc: f.getDoc, listDocs: async () => { throw new Error('503'); }, shadowSet: st.shadowSet, shadowPatch: st.shadowPatch,
        shadowDelete: st.shadowDelete, shadowCreate: st.shadowCreate, rebuild: async () => null, now: () => new Date(),
      });
      assert.equal(r.status, 502);
      assert.equal(fake.log.sets.length + fake.log.commits.length, 0);
    } finally { fake.restore(); }
  });
});

test('CLAUDE_SHADOW=off: settings are refused like everything else the shadow does (409, nothing written)', async () => {
  await withEnv({ CLAUDE_SHADOW: 'off' }, async () => {
    const fake = installFirestoreFake(seed(), noCall);
    try {
      const res = await (await handler())(post({ action: 'settings', change: { loosePerSkid: 5 } }));
      assert.equal(res.status, 409);
      assert.equal(fake.log.sets.length + fake.log.commits.length, 0);
    } finally { fake.restore(); }
  });
});
