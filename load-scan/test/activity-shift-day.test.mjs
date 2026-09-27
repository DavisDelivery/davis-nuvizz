// activity-shift-day.test.mjs — the dispatcher's Activity view opens on the
// shift being loaded, the same day the loaders' phones are writing to.
//
// The loader app keys its manifest and every scan session on the SHIFT day,
// which rolls at 8pm ET (lib/shift.js). load-manifest, load-assign and
// work-report all default to it too. The Activity panel alone opened on the ET
// calendar day, so from 8pm to midnight a dispatcher watching the night shift
// saw last night's finished board and none of the trucks being loaded now.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const fake = installFakeFirestore();

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const scanActivity = await import('../netlify/functions/scan-activity.mts');
const clientShift = await import('../src/lib/shift.js');

// Monday Sep 14 2026, 9:30pm EDT — loaders are loading Tuesday's freight.
const NINE_THIRTY_PM_MONDAY = Date.parse('2026-09-15T01:30:00Z');

test('at 9:30pm ET the Activity view opens on the shift being loaded, not the day that just finished', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const screen = app.slice(app.indexOf('function DispatcherScreen'));
  assert.match(
    screen,
    /const \[activityDate, setActivityDate\] = useState\(shiftDayString\(\)\);/,
    'the Activity panel starts on the shift day the loaders are writing to',
  );
  assert.doesNotMatch(screen.slice(0, 2000), /useState\(etToday\(\)\)/, 'never the ET calendar day');

  // And that expression, at 9:30pm Monday, names Tuesday — the loaders' day.
  assert.equal(clientShift.shiftDayString(new Date(NINE_THIRTY_PM_MONDAY)), '2026-09-15');
});

test('scan-activity asked for no date at 9:30pm ET answers for the shift day, like load-manifest does', async () => {
  fake.docs.clear();
  await fs.setDoc('driver_auth/1', { driverNumber: '1', displayName: 'Dispatcher', role: 'dispatcher', active: true, pinHash: '' });
  const token = auth.issueToken('1', 'Dispatcher', 'dispatcher');

  mock.timers.enable({ apis: ['Date'], now: NINE_THIRTY_PM_MONDAY });
  let res;
  try {
    res = await scanActivity.default(
      new Request('http://localhost/.netlify/functions/scan-activity', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  } finally {
    mock.timers.reset();
  }
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.date, '2026-09-15', 'Tuesday\'s shift, the one on the dock right now');
});
