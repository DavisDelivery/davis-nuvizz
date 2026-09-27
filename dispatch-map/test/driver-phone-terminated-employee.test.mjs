// test/driver-phone-terminated-employee.test.mjs — A TEXT "TO THE DRIVER" MUST NOT REACH A MAN
// WHO NO LONGER WORKS HERE.
//
// A3-S18-5. "Text driver" sends by NAME: send-sms resolves the name to a number server-side via
// resolveDriverPhone, and the stop's Route block labels the number via driver-phone. That lookup
// indexed EVERY roster row with a valid phone — terminated ones included — and first-wins, so a
// terminated employee listed ahead of an active one with the same name took the name outright.
// The Messages contact picker (listEmployees) already dropped non-active rows through
// isMessageable; the name lookup never did, so the two disagreed about who is reachable.
//
// Switch: DRIVER_PHONE_ACTIVE_ONLY=off puts the old lookup back (house shape: default ON, an
// explicit off-word turns it off, anything malformed leaves it ON).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { buildDriverPhoneIndex, driverPhoneActiveOnlyEnabled } from '../netlify/functions/lib/marginiq.mts';

const TERMINATED_TONY = { fullName: 'Tony Smith', phone: '(404) 555-0101', role: 'driver', status: 'terminated' };
const ACTIVE_TONY = { fullName: 'Tony Smith', phone: '404-555-0202', role: 'driver', status: 'active' };
const GONE_GARY = { fullName: 'Gary Old', aliases: ['G Old'], phone: '4045550303', role: 'driver', status: 'inactive' };
const NO_STATUS = { fullName: 'Mike Frye', aliases: ['Frye, Michael'], phone: '4045550404', role: 'driver' };

test('a terminated driver sharing a name with an active one: the text goes to the ACTIVE man', () => {
  const idx = buildDriverPhoneIndex([TERMINATED_TONY, ACTIVE_TONY], true);
  assert.equal(idx.get('smith tony'), '4045550202', 'first-wins handed the name to the terminated row');
});

test('a driver who has left has no number to text — the send reports "no phone on file" instead', () => {
  const idx = buildDriverPhoneIndex([GONE_GARY], true);
  assert.equal(idx.get('gary old'), undefined);
  assert.equal(idx.get('g old'), undefined, 'an alias must not reach a departed driver either');
});

test('a roster row with no status is still treated as active, aliases and all (unchanged)', () => {
  const idx = buildDriverPhoneIndex([NO_STATUS], true);
  assert.equal(idx.get('frye mike'), '4045550404');
  assert.equal(idx.get('frye michael'), '4045550404');
});

test('DRIVER_PHONE_ACTIVE_ONLY=off puts the old every-row lookup back', () => {
  const idx = buildDriverPhoneIndex([TERMINATED_TONY, ACTIVE_TONY, GONE_GARY], false);
  assert.equal(idx.get('smith tony'), '4045550101');
  assert.equal(idx.get('gary old'), '4045550303');
});

test('the switch is house shape: default ON, only an explicit off-word turns it off, malformed stays ON', () => {
  assert.equal(driverPhoneActiveOnlyEnabled({}), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ', 'No']) assert.equal(driverPhoneActiveOnlyEnabled({ DRIVER_PHONE_ACTIVE_ONLY: off }), false, off);
  for (const on of ['on', '1', 'true', 'yes', 'of', 'nope', '']) assert.equal(driverPhoneActiveOnlyEnabled({ DRIVER_PHONE_ACTIVE_ONLY: on }), true, on);
});

test('end to end: "Text driver" for a name whose first roster row is terminated resolves to the active number', async () => {
  delete process.env.DRIVER_PHONE_ACTIVE_ONLY;
  const fake = installFirestoreFake({
    'employees/t1': TERMINATED_TONY,
    'employees/a1': ACTIVE_TONY,
    'employees/g1': GONE_GARY,
  });
  try {
    const { resolveDriverPhone } = await import(`../netlify/functions/lib/marginiq.mts?e2e=${Date.now()}`);
    assert.equal(await resolveDriverPhone('Tony Smith'), '4045550202');
    assert.equal(await resolveDriverPhone('Gary Old'), null);
    assert.deepEqual(fake.log.other, [], 'no call left Firestore');
  } finally { fake.restore(); }
});
