// ROUTE CREATE, THE PORTAL'S WAY (v1.98.5) — the request built and the answer read.
//
// Chad, 2026-09-30: "HERE IS A HAR FOR CREATING A ROUTE." The capture (portal.nuvizz.com Route
// Workbench, "order load with full manual sequence") holds three addNewRoutePlan POSTs: SHEATS and
// TONY answered DuplicateRouteName, SEYMOUR was created as DAVIS000205172. The SEYMOUR entry below
// is copied from that capture field for field — minus its driver block, which carries a driver's
// home address and phone and which this app deliberately does not send (the profile marks driver
// isReq:false; the staged driver is assigned afterwards by the verified assignDriver step).
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildManualRouteJson, parseAddNewRoutePlan, rwbTimeObj, RWB_ROUTE_NAME_MAX } = await import('../netlify/functions/lib/nuvizz-rwb.mts');

// ── the capture ──────────────────────────────────────────────────────────────────────────────
const HAR_SEYMOUR = {
  profileId: '625bb549938c3b055c6b66ab', routePlanName: 'SEYMOUR', plannedETAWindow: '30',
  routeStart: '09/30/2026 08:00:00 am', routeEnd: '09/30/2026 11:59:00 pm', days: '0', originOption: '02',
  origin: 'Davis Delivery, 943 Gainesville Highway, Buford, Georgia, United States, 30518', lat: 34.14838, lng: -83.95948,
  routeStartTime: { HH: '08', H: '8', hh: '08', h: '8', a: 'am', A: 'AM', kk: '08', k: '8', m: '0', mm: '00', s: '', ss: '' },
  routeEndTime: { HH: '23', H: '23', hh: '11', h: '11', a: 'pm', A: 'PM', kk: '23', k: '23', m: '59', mm: '59', s: '', ss: '' },
  vehicleType: {
    costPerMile: 0, fixedCost: 0, description: 'Straight Truck', isActive: true, costPerHour: 0,
    los: [{ capacityType: 'Weight', capacity: 15000 }, { capacityType: 'Volume', capacity: 100 }, { capacityType: 'Carton', capacity: 25 }, { capacityType: 'Pallet', capacity: 125 }],
    isDefault: false, vehicleIconName: 'STRAIGHT_TRUCK', text: 'Straight Truck', value: '475', maxRouteDistMiles: 0, mileage: 0,
  },
  tz: 'America/New_York', returnToDepot: 'ALWAYS', seqMode: 'None', stagingLocation: '', stagingLocationText: '',
  recurrenceDay: '0111110', selectedProfile: {}, isStartEndTimeLocked: false, isVehicleLocked: false, isRteOriginLocked: false, isOriginAddrLocked: false,
  proReturnToDepot: { name: 'returnToDepot', selVal: 'NEVER', isReq: false, isLoc: false, isVis: true },
  proSeqMode: { name: 'seqMode', selVal: 'None', isReq: false, isLoc: false, isVis: true },
  cutOffTime: '09/30/2026 11:59:00 pm', line1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', line2: '', zipCode: '30518',
  country: 'UNITED STATES', orgAddrName: 'DAVIS DELIVERY', globalDate: 'Sep 30, 2026', routeDate: '09/30/2026', vehicleTypeId: '475',
};
// buildEmptyRouteJson, trimmed to what the create reads (the capture's own values).
const TEMPLATE = {
  defaultProfileRef: '625bb549938c3b055c6b66ab', lattitude: 34.14838, longitude: -83.95948,
  companyAddress: { zipCode: '30518', country: 'UNITED STATES', city: 'BUFORD', fullAddress: 'Davis Delivery, 943 Gainesville Highway, Buford, Georgia, United States, 30518', name: 'DAVIS DELIVERY', state: 'GEORGIA', line1: '943 GAINESVILLE HIGHWAY' },
  profilesData: [{
    id: '625bb549938c3b055c6b66ab', name: 'DAVISROUTE', isDefault: true,
    routeInfo: [
      { name: 'returnToDepot', selVal: 'NEVER', isReq: false, isLoc: false, isVis: true },
      { name: 'startEndTime', selVal: '', isReq: true, timeSlots: [{ startDay: '0', name: 'startEndTime', startTime: '08:00:00', endTime: '23:59:00', day: '0' }], isLoc: false, isVis: true },
    ],
    rtAsgmt: [{ name: 'vehicleType', selVal: '', isReq: true }, { name: 'driver', selVal: '', isReq: false }],
    addnlDtl: [{ name: 'seqMode', selVal: 'None', isReq: false, isLoc: false, isVis: true }],
  }],
};

test('the SEYMOUR create, rebuilt: every field the portal sent, in the portal\'s shape — no driver', () => {
  const built = buildManualRouteJson({ routeName: 'SEYMOUR', date: '2026-09-30' }, TEMPLATE);
  assert.deepEqual(built, HAR_SEYMOUR);
  assert.equal('driver' in built, false);
  assert.equal('driverId' in built, false);
});

test('a failed template read falls back to the capture\'s own values — the same request', () => {
  assert.deepEqual(buildManualRouteJson({ routeName: 'SEYMOUR', date: '2026-09-30' }, null), HAR_SEYMOUR);
});

test('the template is ECHOED, not ignored: a later window or another depot rides through', () => {
  const t = JSON.parse(JSON.stringify(TEMPLATE));
  t.profilesData[0].routeInfo[1].timeSlots[0].startTime = '06:30:00';
  t.companyAddress.line1 = '1 OTHER RD';
  const b = buildManualRouteJson({ routeName: 'X', date: '2026-10-01' }, t);
  assert.equal(b.routeStart, '10/01/2026 06:30:00 am');
  assert.deepEqual(b.routeStartTime, rwbTimeObj('06:30:00'));
  assert.equal(b.line1, '1 OTHER RD');
  assert.equal(b.globalDate, 'Oct 1, 2026');
  assert.equal(b.routeDate, '10/01/2026');
});

test('the portal\'s time object, hour by hour', () => {
  assert.deepEqual(rwbTimeObj('08:00:00'), HAR_SEYMOUR.routeStartTime);
  assert.deepEqual(rwbTimeObj('23:59:00'), HAR_SEYMOUR.routeEndTime);
  assert.equal(rwbTimeObj('12:00').a, 'pm');
  assert.equal(rwbTimeObj('12:00').hh, '12');
  assert.equal(rwbTimeObj('00:15').hh, '12');
  assert.equal(rwbTimeObj('00:15').kk, '24');
});

test('nothing malformed is ever sent: no name, an over-long name, or a bad day throws', () => {
  assert.throws(() => buildManualRouteJson({ routeName: '  ', date: '2026-09-30' }), /needs a name/);
  assert.throws(() => buildManualRouteJson({ routeName: 'X'.repeat(RWB_ROUTE_NAME_MAX + 1), date: '2026-09-30' }), /caps it at 20/);
  for (const d of ['', '9/30/2026', '2026-9-30', null]) assert.throws(() => buildManualRouteJson({ routeName: 'X', date: d }), /service day/);
});

test('NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID overrides the vehicle type (id and name)', () => {
  const prev = [process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID, process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_NAME];
  process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID = '512';
  process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_NAME = 'Tractor';
  try {
    const b = buildManualRouteJson({ routeName: 'X', date: '2026-09-30' }, TEMPLATE);
    assert.equal(b.vehicleTypeId, '512');
    assert.equal(b.vehicleType.value, '512');
    assert.equal(b.vehicleType.text, 'Tractor');
  } finally {
    if (prev[0] === undefined) delete process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID; else process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_ID = prev[0];
    if (prev[1] === undefined) delete process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_NAME; else process.env.NUVIZZ_ROUTE_CREATE_VEHICLE_TYPE_NAME = prev[1];
  }
});

// ── the answer ───────────────────────────────────────────────────────────────────────────────
test('SEYMOUR\'s answer names the route: plan id and load number', () => {
  const body = { responseCode: 200, message: 'Success', routes: [{ id: '6abd0dba673007239214c8ad', entity: 'ROUTE', name: 'SEYMOUR', rteNbr: 'DAVIS000205172', status: '01' }] };
  assert.deepEqual(parseAddNewRoutePlan(200, body), { ok: true, route: { id: '6abd0dba673007239214c8ad', loadNbr: 'DAVIS000205172', name: 'SEYMOUR', status: '01' } });
});

test('SHEATS and TONY: a duplicate name rides a 200 inside a JSON string — read as a refusal', () => {
  const r = parseAddNewRoutePlan(200, { responseCode: 200, message: '{"DuplicateRouteName":["SHEATS"]}' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicate, ['SHEATS']);
  assert.match(r.error, /already has a route named SHEATS — open it from the Routes panel/);
});

test('anything else is a failure, never a guess that it landed', () => {
  assert.equal(parseAddNewRoutePlan(500, { error: 'x' }).ok, false);
  assert.equal(parseAddNewRoutePlan(200, 'Success').ok, false, 'not JSON');
  assert.equal(parseAddNewRoutePlan(200, { responseCode: 500, message: 'boom' }).ok, false);
  const noRoute = parseAddNewRoutePlan(200, { responseCode: 200, message: 'Success', routes: [] });
  assert.equal(noRoute.ok, false);
  assert.match(noRoute.error, /check the portal before trying again/, 'a 200 with no route may still have made one — say so');
  assert.equal(parseAddNewRoutePlan(200, { responseCode: 200, routes: [{ id: 'x' }] }).ok, false, 'no load number, no route');
  assert.equal(parseAddNewRoutePlan(200, null).ok, false);
});
