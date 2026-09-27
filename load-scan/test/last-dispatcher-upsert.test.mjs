// last-dispatcher-upsert.test.mjs — A5-S30-3.
//
// set-active and set-role both refuse to take the LAST active dispatcher off
// duty, because with the bootstrap secret used and removed, zero dispatchers is
// unrecoverable. The upsert action writes `active` too, and it had no such
// guard: `{ action:'upsert', driverNumber:<the only dispatcher>, active:false }`
// locked every dispatcher out of the admin screen. Driven end to end against the
// in-memory Firestore so the refusal is proven to leave the credential untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const fake = installFakeFirestore();

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const admin = await import('../netlify/functions/driver-admin.mts');

const DISPATCHER_TOKEN = auth.issueToken('1', 'Dispatcher', 'dispatcher');

const invoke = (body) =>
  admin.default(
    new Request('http://localhost/.netlify/functions/driver-admin', {
      method: 'POST',
      headers: { authorization: `Bearer ${DISPATCHER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const seedOnlyDispatcher = () =>
  fs.setDoc('driver_auth/1', { driverNumber: '1', displayName: 'Dispatcher', role: 'dispatcher', active: true, pinHash: '', nuvizzAliases: [] });

test('saving the only dispatcher with active:false is refused, and the dispatcher stays on duty', async () => {
  fake.docs.clear();
  await seedOnlyDispatcher();

  const res = await invoke({ action: 'upsert', driverNumber: '1', displayName: 'Dispatcher', nuvizzAliases: [], active: false });
  assert.equal(res.status, 409, 'the same refusal set-active gives');
  assert.match((await res.json()).error, /last dispatcher/);

  const cred = await fs.getDoc('driver_auth/1');
  assert.equal(cred.active, true, 'nothing was written — the office can still administer drivers');
});

test('with a second active dispatcher, upsert may still deactivate the first', async () => {
  fake.docs.clear();
  await seedOnlyDispatcher();
  await fs.setDoc('driver_auth/2', { driverNumber: '2', displayName: 'Night Dispatcher', role: 'dispatcher', active: true, pinHash: '' });

  const res = await invoke({ action: 'upsert', driverNumber: '2', displayName: 'Night Dispatcher', nuvizzAliases: [], active: false });
  assert.equal(res.status, 200);
  assert.equal((await fs.getDoc('driver_auth/2')).active, false, 'cover exists, so the deactivation lands');
});

test('an ordinary upsert of the only dispatcher (no active field) still saves', async () => {
  fake.docs.clear();
  await seedOnlyDispatcher();

  const res = await invoke({ action: 'upsert', driverNumber: '1', displayName: 'Chad', nuvizzAliases: [] });
  assert.equal(res.status, 200, 'renaming the dispatcher is not a deactivation');
  const cred = await fs.getDoc('driver_auth/1');
  assert.equal(cred.displayName, 'Chad');
  assert.equal(cred.active, true);
});

test('upsert may still deactivate a driver while one dispatcher remains', async () => {
  fake.docs.clear();
  await seedOnlyDispatcher();
  await fs.setDoc('driver_auth/4471', { driverNumber: '4471', displayName: 'Brad Goodroe', role: 'driver', active: true, pinHash: '' });

  const res = await invoke({ action: 'upsert', driverNumber: '4471', displayName: 'Brad Goodroe', nuvizzAliases: [], active: false });
  assert.equal(res.status, 200);
  assert.equal((await fs.getDoc('driver_auth/4471')).active, false);
});
