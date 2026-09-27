// test/saturday-heal-switch-not-pinned.test.mjs — NUVIZZ_SATURDAY_HEAL_ET=0 turns the heal off,
// whatever the schedule editor has saved.
//
// Audit 2026-09-27 (nuvizz-read-scan-board-3). The Saturday heal's documented off switch is the
// env var (scan-schedule.mts: "Set NUVIZZ_SATURDAY_HEAL_ET=0 to turn it off"). But the heal hour
// was ALSO a stored scan_config field with no field on the Diagnostics screen: the editor loads
// the whole effective config into its form and POSTs the whole form back on Save, so changing any
// unrelated setting stored saturdayHealHour: 7. From then on the scanner read the stored 7 ahead
// of the env var, Saturday 07:00 ET still scanned NuVizz with the switch set to 0, and
// nuvizz-scan-config?explain=1 printed the switch as 0 — a switch whose position could not be read.
//
// The env var is read at module load, so it is set before anything is imported; node --test runs
// each file in its own process. Firestore fake only — nothing here can reach NuVizz.

process.env.NUVIZZ_SATURDAY_HEAL_ET = '0';
delete process.env.AUTH_REQUIRED;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const { clampScanConfig, scanDecision, SATURDAY_HEAL_HOUR } = await import('../netlify/functions/lib/scan-schedule.mts');
const { readScanConfig } = await import('../netlify/functions/lib/firestore.mts');
const handler = (await import('../netlify/functions/nuvizz-scan-config.mts')).default;

const URL_ = 'https://x.netlify.app/.netlify/functions/nuvizz-scan-config';
const get = async () => (await handler(new Request(URL_))).json();
const post = async (body) => (await handler(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();

const FRI_LAST = '2026-09-11T23:50:00Z';     // Friday 19:50 ET — the week's last scheduled scan
const SAT_0705 = new Date('2026-09-12T11:05:00Z');
// What the scanner does with what is stored: refresh-stops-core reads clampScanConfig(readScanConfig()).
const scannerAt0705Saturday = async () => scanDecision(SAT_0705, false, FRI_LAST, clampScanConfig(await readScanConfig()));

test('a dispatcher saves an unrelated schedule change, then NUVIZZ_SATURDAY_HEAL_ET=0 still keeps Saturday 07:00 off NuVizz', async () => {
  const fake = installFirestoreFake({});
  try {
    assert.equal(SATURDAY_HEAL_HOUR, 0, 'the switch is set to off');
    // Exactly what the Diagnostics editor does: load the whole config into the form, change one
    // field, and POST the whole form back.
    const loaded = await get();
    assert.equal(loaded.ok, true);
    const saved = await post({ ...loaded.config, intervalDayMin: 45 });
    assert.equal(saved.ok, true);
    assert.equal(saved.stored.intervalDayMin, 45, 'the change the dispatcher made is saved');
    assert.equal('saturdayHealHour' in saved.stored, false, 'a setting with no field on the screen is not saved by a Save');

    const d = await scannerAt0705Saturday();
    assert.equal(d.act, false, `Saturday 07:05 must not scan with the heal switched off: ${d.reason}`);
    assert.equal(d.skip, 'weekend');
    assert.equal(fake.log.other.length, 0, 'nothing but Firestore was called');
  } finally { fake.restore(); }
});

test('a Saturday heal hour pinned by an EARLIER Save no longer outranks the switch', async () => {
  // The document as it already stands on a site where somebody pressed Save after v0.95.2.
  const fake = installFirestoreFake({ 'nuvizz_ops/scan_config': { saturdayHealHour: 7, intervalDayMin: 30, updatedAt: '2026-09-20T14:00:00.000Z' } });
  try {
    const d = await scannerAt0705Saturday();
    assert.equal(d.act, false, `the stored 7 must not reopen the weekend: ${d.reason}`);
    assert.equal(d.skip, 'weekend');
    // …and what the explain dry run prints as the switch is what the scanner obeys.
    const ex = await (await handler(new Request(`${URL_}?explain=1`))).json();
    assert.equal(ex.frozen.switches.saturdayHealHourET, 0);
    assert.equal('saturdayHealHour' in (await get()).config, false, 'the effective schedule does not carry a second copy of the switch');
    assert.equal(fake.log.other.length, 0, 'nothing but Firestore was called');
  } finally { fake.restore(); }
});

test('the schedule\'s write path cannot store a Saturday heal hour at all — the env var is the one switch', () => {
  assert.equal('saturdayHealHour' in clampScanConfig({ saturdayHealHour: 9, intervalDayMin: 30 }), false);
  assert.equal(clampScanConfig({ saturdayHealHour: 9, intervalDayMin: 30 }).intervalDayMin, 30);
});
