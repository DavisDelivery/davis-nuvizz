// test/estes-profile.test.mjs
//
// §EP — THE ESTES ORDER PROFILE (v1.108.0).
//
// Chad, 10/03: "I created an order profile ... and has a specific parameter that makes anything
// that's an estes order that's uploaded require three photos. So anytime that we're using the new
// order creation either for bulk or single and it's an estes order which is notified by the estes
// at the beginning of the pro this is the format it's supposed to be in." NuVizz configured the
// ESTES profile in Production ("3 mandatory images") and sent a stop/sync/update body carrying
// "profile": "ESTES" for every ESTES order.
//
// The rules this file pins, each named for what a driver or dispatcher would see go wrong:
//   • every Estes order we create goes out with profile ESTES — whichever field carries "ESTES-";
//   • every other order goes out byte-for-byte as before;
//   • the route import never carries it (its stops come from buildStopPayload, which still never
//     emits a profile — the live-learned rule this repo already had);
//   • one env switch puts it all back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildOpRequest, buildStopPayload, withOrderProfile, orderProfileFor, createProfileFor,
  estesProfileEnabled, ESTES_PROFILE,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { manifestRowsToIntake, bulkRowNuvizzRefs } from '../src/lib/bulk-orders.js';
import { isEstesOrder } from '../src/lib/carrier-mark.js';
import writeHandler from '../netlify/functions/nuvizz-write.mts';

const CREDS = { base: 'https://nuvizz.example/api', companyCode: 'DAVIS', auth: 'Basic x' };
const SETTINGS = {
  origin: { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' },
  serviceDate: '2026-10-02', timeZone: 'America/New_York',
};
const ROW = (over = {}) => ({ name: 'ACME', addr1: '1 Main St', city: 'Buford', state: 'GA', zip: '30518', ...over });
const sent = (payload) => JSON.parse(buildOpRequest('createStop', payload, CREDS).body);

// NuVizz's own example, verbatim from their email to Chad (its one missing comma restored).
const NUVIZZ_SAMPLE = {
  companyCode: 'DAVIS',
  stop: {
    stopNbr: 'ESTES-0778201115', stopType: 'DO', stopExecution: 'APP', shipmentType: 'REG', profile: 'ESTES',
    from: {
      address: { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518', country: 'USA', addressType: 'COM' },
      schedule: { timeFrom: '2026-10-02T08:00:00', timeTo: '2026-10-02T12:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
    to: {
      address: { name: 'DAVID BARRETT', addr1: '1946 RAILROAD STREET', addr2: '#2900', city: 'STATHAM', state: 'GA', zip: '30666', country: 'USA', addressType: 'ANY' },
      contact: { contactName: 'DAVID BARRETT', phone: '7062860217' },
      schedule: { timeFrom: '2026-10-02T12:00:00', timeTo: '2026-10-02T17:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
    shipmentNbr: '0778201115', proNumber: '0778201115', reference1: 'PRO 0778201115',
    reference2: '2 PC AWHZ-30-CB WAS-30 (36X29X43); Pcs = 2', sealNbr: '$55.00',
    totalCartons: 2, totalPallets: 2, weight: 467, weightUOM: 'LBS', sourceType: 'INTG', clientBillable: 'NO', thirdParty: 'NO',
    stopDetails: [{ product: '2 PC AWHZ-30-CB WAS-30 (36X29X43); Pcs = 2', productIdentifier: '0778201115', quantity: 2, quantityUOM: 'PCS', stopDetailSeq: 1, deliveryType: 'DO', lineType: '01', weight: 467, weightUOM: 'LBS' }],
    comments: [{ commentType: '01', cmtType: 'ORD_IN', accessLevels: ['DISPATCHER', 'DRIVER'], commentDescription: '**SIGNATURE REQUIRED** TAKE 3 PHOTOS**  $55.00' }],
  },
};

const flatten = (o, p = '', out = {}) => {
  if (Array.isArray(o)) o.forEach((v, i) => flatten(v, `${p}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flatten(v, p ? `${p}.${k}` : k, out);
  else out[p] = o;
  return out;
};

test('NuVizz\'s own ESTES example, made the way the Manifest push makes it, goes out with profile ESTES and matches field for field', () => {
  // The order as the Manifest intake builds it (bulk-orders.js), plus the two fields a dispatcher
  // types on that screen: the price and the driver instruction.
  const [r] = manifestRowsToIntake([{ proDigits: '0778201115', name: 'DAVID BARRETT', addr1: '1946 RAILROAD STREET', addr2: '#2900', city: 'STATHAM', state: 'GA', zip: '30666', description: '2 PC AWHZ-30-CB WAS-30 (36X29X43); Pcs = 2', units: 2, weight: 467 }]);
  const body = sent({ settings: SETTINGS, row: {
    name: r.name, addr1: r.addr1, addr2: r.addr2, city: r.city, state: r.state, zip: r.zip,
    stopNbr: r.stopNbr, pro: r.pro, itemDesc: r.itemDesc, pallets: Number(r.pallets), loose: null, weight: Number(r.weight),
    price: '$55.00', phone: '7062860217', dispatchNotes: '**SIGNATURE REQUIRED** TAKE 3 PHOTOS**  $55.00',
  } });
  assert.equal(body.stop.profile, 'ESTES');
  const A = flatten(NUVIZZ_SAMPLE), B = flatten(body);
  const differ = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k])).sort();
  // The only differences are four this app has never sent differently on ANY order: three fields in
  // NuVizz's example our creates have never carried, and the loose count our builder sends as null.
  assert.deepEqual(differ, ['stop.clientBillable', 'stop.stopDetails[0].deliveryType', 'stop.thirdParty', 'stop.volume']);
  assert.equal(B['stop.volume'], null);
});

test('an Estes order is found by the order number OR the PRO reference — every create path puts "ESTES-" in one of them', () => {
  // Manifest push: the order number.
  assert.equal(sent({ row: ROW({ stopNbr: 'ESTES-0778201115', pro: '0778201115' }), settings: SETTINGS }).stop.profile, 'ESTES');
  // New Order: typed in the PRO box, with some other Order #.
  assert.equal(sent({ row: ROW({ stopNbr: '7712345', pro: 'ESTES-0778201115' }), settings: SETTINGS }).stop.profile, 'ESTES');
  // New Order: typed lowercase, the way dispatchers type it (the builder's own comment).
  assert.equal(sent({ row: ROW({ pro: 'estes-2258732686' }), settings: SETTINGS }).stop.profile, 'ESTES');
  // Bulk Add's ref swap: the grid's PRO goes out as the stop number, its Order # as the shipment number.
  const viaPro = bulkRowNuvizzRefs({ pro: 'ESTES-0538243875', stopNbr: 'SO-55' });
  assert.equal(sent({ row: ROW(viaPro), settings: SETTINGS }).stop.profile, 'ESTES');
  const viaOrder = bulkRowNuvizzRefs({ pro: 'SHP123', stopNbr: 'ESTES-0538243875' });
  assert.equal(sent({ row: ROW(viaOrder), settings: SETTINGS }).stop.profile, 'ESTES');
  // Duplicate and the UAT bench hand over a built stop: a copy of an Estes order is an Estes order.
  assert.equal(sent({ stop: { ...buildStopPayload(ROW({ stopNbr: 'ESTES-0538243875-1', pro: 'ESTES-0538243875-1' }), SETTINGS) } }).stop.profile, 'ESTES');
});

test('the same Estes rule the map paints by — WESTES, a bare PRO and a UAT copy are not Estes orders', () => {
  for (const nbr of ['WESTES-1', '0778201115', 'UT-ESTES-0538243875', 'AVRT-0028093763', '']) {
    assert.equal(isEstesOrder(nbr), false, nbr);
    assert.equal('profile' in sent({ row: ROW({ stopNbr: nbr || null, pro: nbr || null }), settings: SETTINGS }).stop, false, `${nbr} gets no profile`);
  }
  for (const nbr of ['ESTES-0538243875', 'Estes-0828068215', 'ESTES 123']) {
    assert.equal(orderProfileFor({ stopNbr: nbr }, true), ESTES_PROFILE, nbr);
  }
});

test('every other order goes out byte-for-byte as before — no profile key, nothing else moved', () => {
  for (const row of [ROW({ stopNbr: '007185553', pro: '007185553', pallets: 6, loose: 2, weight: 900 }), ROW({ stopNbr: 'AVRT-0028093763' }), ROW({})]) {
    const before = JSON.stringify({ companyCode: 'DAVIS', stop: buildStopPayload(row, SETTINGS) });
    assert.equal(buildOpRequest('createStop', { row, settings: SETTINGS }, CREDS).body, before);
  }
  const stop = buildStopPayload(ROW({ stopNbr: '007185553' }), SETTINGS);
  assert.equal(withOrderProfile(stop, true), stop, 'the very same object — untouched');
});

test('the route import never carries a profile: buildStopPayload, which it builds from, still never emits one', () => {
  // Bulk Add's "Create as load" and the Routing inline create send their new stops inside a load
  // import, built by buildStopPayload (nuvizz-write.mts). The live-learned rule stands there.
  const p = buildStopPayload(ROW({ stopNbr: 'ESTES-0778201115', pro: '0778201115' }), SETTINGS);
  assert.equal(/"profile"/.test(JSON.stringify(p)), false);
  // And the profile is added in exactly one place: the stop/sync/update create.
  const OPS = readFileSync(new URL('../netlify/functions/lib/nuvizz-write-ops.mts', import.meta.url), 'utf8');
  const EXEC = readFileSync(new URL('../netlify/functions/lib/nuvizz-write.mts', import.meta.url), 'utf8');
  assert.equal((OPS.match(/withOrderProfile\(built\)/g) || []).length, 1);
  assert.match(OPS, /case 'createStop': \{[\s\S]*?const stop = withOrderProfile\(built\);[\s\S]*?\/stop\/sync\/update\//);
  assert.doesNotMatch(EXEC, /withOrderProfile|profile:\s*'ESTES'/, 'the executor (import included) never adds one itself');
});

test('NUVIZZ_ESTES_PROFILE=off sends every create exactly as before; malformed leaves it ON', () => {
  assert.equal(estesProfileEnabled({}), true);
  for (const off of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(estesProfileEnabled({ NUVIZZ_ESTES_PROFILE: off }), false, off);
  for (const on of ['on', 'yes', 'of', 'ESTES', '1']) assert.equal(estesProfileEnabled({ NUVIZZ_ESTES_PROFILE: on }), true, on);
  const saved = process.env.NUVIZZ_ESTES_PROFILE;
  try {
    process.env.NUVIZZ_ESTES_PROFILE = 'off';
    const row = ROW({ stopNbr: 'ESTES-0778201115', pro: '0778201115' });
    assert.equal(buildOpRequest('createStop', { row, settings: SETTINGS }, CREDS).body, JSON.stringify({ companyCode: 'DAVIS', stop: buildStopPayload(row, SETTINGS) }));
    assert.equal(createProfileFor({ row, settings: SETTINGS }), null);
  } finally {
    if (saved === undefined) delete process.env.NUVIZZ_ESTES_PROFILE; else process.env.NUVIZZ_ESTES_PROFILE = saved;
  }
});

test('the dry run says the profile goes, and the ledger records what the create sent', async () => {
  assert.equal(createProfileFor({ row: ROW({ stopNbr: 'ESTES-0778201115' }), settings: SETTINGS }), 'ESTES');
  assert.equal(createProfileFor({ stop: { stopNbr: 'ESTES-0538243875-1' } }), 'ESTES');
  assert.equal(createProfileFor({ row: ROW({ stopNbr: '007185553' }), settings: SETTINGS }), null);
  const plan = async (row) => {
    const res = await writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
      method: 'POST', body: JSON.stringify({ op: 'createStop', payload: { row, settings: SETTINGS }, dryRun: true }),
    }));
    return (await res.json()).plan;
  };
  const estes = await plan(ROW({ stopNbr: 'ESTES-0778201115', pro: '0778201115' }));
  assert.equal(estes[0], 'CREATE order ESTES-0778201115 (stop/sync/update) → 1 NuVizz call');
  assert.match(estes[1], /^PROFILE ESTES — NuVizz's ESTES order profile \(3 mandatory photos\)/);
  const other = await plan(ROW({ stopNbr: '007185553' }));
  assert.deepEqual(other, ['CREATE order 007185553 (stop/sync/update) → 1 NuVizz call']);
  const EP = readFileSync(new URL('../netlify/functions/nuvizz-write.mts', import.meta.url), 'utf8');
  assert.match(EP, /op === 'createStop' && result\?\.ok[\s\S]*?profile: createProfileFor\(payload\)/);
  assert.match(EP, /op === 'duplicateOrder' && result\?\.created === true[\s\S]*?profile: orderProfileFor\(\{ stopNbr: result\.stopNbr \}\)/);
});
