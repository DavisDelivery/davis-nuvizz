// netlify/functions/dispatch.js
// Reads today's dispatch manifest from the Glory Bound Firebase (project: glorybounddispatch).
// Returns stops + loads in a shape compatible with the dashboard UI, so the app can blend
// NuVizz data (Uline/Davis Delivery freight) with live Glory Bound dispatch (Emser, Florida Tile,
// Specialty, etc.)
//
// Endpoints:
//   ?path=__today                → today's stops + loads + summary
//   ?path=__date&date=YYYY-MM-DD → any specific day
//   ?path=__range&days=7         → last N days
//
// Firestore path: manifests/{YYYY-MM-DD}, doc shape: { entries: [...], updatedAt }
//
// NOTE: Firebase API key here is the glorybounddispatch project's PUBLIC web API key
// (it's embedded in the dispatch app's JS bundle and safe to use client-side too).
// Security is enforced via Firestore rules, not the API key.

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/glorybounddispatch/databases/(default)/documents';
const API_KEY = process.env.GLORYBOUND_FIREBASE_KEY || 'AIzaSyDY2OceDzBWMHPR3C3O1oxktrCIy3mKMqU';

// --- Firestore value format → plain JS ---
function fsVal(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal);
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k of Object.keys(fields)) out[k] = fsVal(fields[k]);
    return out;
  }
  return v;
}

function fsDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const k of Object.keys(doc.fields)) out[k] = fsVal(doc.fields[k]);
  return out;
}

// --- Map a Glory Bound entry to the same shape our dashboard components expect ---
// (matches normalizeStop in src/lib/normalize.js)
function entryToStop(e, dateKey) {
  const statusRaw = (e.status || '').toString().toLowerCase();
  const bucket =
    statusRaw === 'delivered' || statusRaw === 'departed' || statusRaw === 'complete' ? 'completed' :
    statusRaw === 'arrived' || statusRaw === 'in_progress' || statusRaw === 'enroute' ? 'inProgress' :
    statusRaw === 'failed' || statusRaw === 'refused' ? 'failed' :
    statusRaw === 'cancelled' || statusRaw === 'canceled' ? 'cancelled' :
    'pending';

  // Parse address — most entries have single `addr` string like "5470 Oakbrook Pkwy, Norcross, GA 30093"
  const addrParts = (e.addr || '').split(',').map(s => s.trim());
  const addr1 = addrParts[0] || '';
  const city = addrParts[1] || '';
  const stateZip = (addrParts[2] || '').split(/\s+/);
  const state = stateZip[0] || '';
  const zip = stateZip[1] || '';

  // Arrival/departure — stored as "HH:MM AM" strings, combine with date
  function toISO(timeStr) {
    if (!timeStr) return null;
    try {
      const [tm, ampm] = timeStr.split(/\s+/);
      const [h, m] = tm.split(':').map(n => parseInt(n, 10));
      let hr = h;
      if (ampm === 'PM' && h < 12) hr += 12;
      if (ampm === 'AM' && h === 12) hr = 0;
      return `${dateKey}T${String(hr).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    } catch { return null; }
  }

  const arrival = toISO(e.arrivedAt);
  const departure = toISO(e.departedAt);
  let dwellMin = null;
  if (arrival && departure) {
    dwellMin = Math.round((new Date(departure) - new Date(arrival)) / 60000);
  }

  return {
    id: String(e.id || Math.random()),
    nbr: String(e.id || ''),
    seq: null,
    type: e.stopType === 'pickup' ? 'PU' : 'DO',
    status: e.status || 'pending',
    bucket,

    name: e.stop || e.customer || '',
    addr1, addr2: '', city, state, zip,
    lat: null, lng: null,
    fullAddress: e.addr || '',

    contactName: null,
    phone: null,

    plannedFrom: null,
    plannedTo: e.dueBy || null,
    plannedEta: null,
    actualEta: null,
    arrival, departure,
    confirmed: departure,
    dwellMin,
    etaCode: null,

    txnRef: e.refNum || null,
    proNumber: e.refNum || null,
    sealNbr: null,
    shipmentNbr: null,

    cartons: null,
    pallets: null,
    weight: e.weight || null,
    weightUOM: 'lbs',

    customerName: e.customer || '',
    customerAcct: null,

    loadNbr: `GB-${dateKey}-D${e.driverId || 0}-L${e.loadNum || 1}`,
    loadId: null,
    driverName: `Driver ${e.driverId || '?'}`,
    driverPhone: null,
    vehicleNbr: null,

    exceptions: [],
    hasException: false,
    cancellation: null,
    rejection: null,

    // keep original data for any UI that wants it
    _gb: e,
  };
}

function buildLoadsFromStops(stops) {
  // Group by loadNbr (which encodes driverId + loadNum + date)
  const byLoad = {};
  for (const s of stops) {
    if (!byLoad[s.loadNbr]) byLoad[s.loadNbr] = [];
    byLoad[s.loadNbr].push(s);
  }

  const loads = [];
  for (const [loadNbr, loadStops] of Object.entries(byLoad)) {
    const completed = loadStops.filter(s => s.bucket === 'completed').length;
    const total = loadStops.length;
    const bucketCounts = loadStops.reduce((acc, s) => { acc[s.bucket] = (acc[s.bucket] || 0) + 1; return acc; }, {});

    const loadStatus =
      bucketCounts.inProgress > 0 ? 'In Progress' :
      completed === total && total > 0 ? 'Completed' :
      completed > 0 ? 'In Progress' :
      'Pending';

    // Earliest arrival, latest departure = actual start/end
    const arrivals = loadStops.map(s => s.arrival).filter(Boolean).sort();
    const departures = loadStops.map(s => s.departure).filter(Boolean).sort();
    const actualStart = arrivals[0] || null;
    const actualEnd = departures[departures.length - 1] || null;

    const sampleStop = loadStops[0];

    loads.push({
      nbr: loadNbr,
      id: loadNbr,
      routeName: sampleStop._gb?.etaDest || `Load ${sampleStop._gb?.loadNum || '?'}`,
      status: loadStatus,
      bucket: loadStatus.toLowerCase().includes('complet') ? 'completed' : loadStatus.toLowerCase().includes('progress') ? 'inProgress' : 'pending',
      driverName: sampleStop.driverName,
      driverPhone: null,
      vehicleType: null,
      tractorNbr: null,
      trailerNbr: null,

      earliestStart: null,
      latestStart: null,
      actualStart, actualEnd,

      plannedMiles: null,
      actualMiles: null,
      plannedDuration: null,
      actualDuration: null,

      origin: { name: sampleStop._gb?.pickupFrom || 'Norcross', addr1: null, city: null, state: 'GA', zip: null, lat: null, lng: null },

      stopsOnRoute: total,
      completed, total,
      pctComplete: total ? Math.round((completed / total) * 100) : 0,

      totalCartons: null,
      totalPallets: null,
      weight: loadStops.reduce((w, s) => w + (s.weight || 0), 0),
      weightUOM: 'lbs',

      stops: loadStops,
    });
  }

  return loads;
}

function buildSummary(stops, loads) {
  const total = stops.length;
  let completed = 0, inProgress = 0, pending = 0, failed = 0, cancelled = 0;
  let dwellSum = 0, dwellCount = 0;
  const customerCounts = {};

  for (const s of stops) {
    if (s.bucket === 'completed') completed++;
    else if (s.bucket === 'inProgress') inProgress++;
    else if (s.bucket === 'failed') failed++;
    else if (s.bucket === 'cancelled') cancelled++;
    else pending++;

    if (s.dwellMin) { dwellSum += s.dwellMin; dwellCount++; }

    const cust = s.customerName || 'Unknown';
    customerCounts[cust] = (customerCounts[cust] || 0) + 1;
  }

  return {
    totalStops: total, completed, inProgress, pending, failed, cancelled,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,
    avgDwellMin: dwellCount ? Math.round(dwellSum / dwellCount) : 0,
    onTime: 0, late: 0, early: 0,  // Glory Bound doesn't track ETA codes
    totalLoads: loads.length,
    totalMiles: 0,  // Glory Bound doesn't store miles in manifest
    topCustomers: Object.entries(customerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
  };
}

async function fetchManifest(dateKey) {
  const url = `${FIRESTORE_BASE}/manifests/${dateKey}?key=${API_KEY}`;
  const resp = await fetch(url);
  if (resp.status === 404) return { entries: [], notFound: true };
  if (!resp.ok) throw new Error(`Firestore ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const doc = fsDoc(data);
  return { entries: doc?.entries || [], updatedAt: doc?.updatedAt };
}

// ---- Handler ----
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const apiPath = params.path || '__today';

    // Today
    if (apiPath === '__today') {
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10);
      const { entries, updatedAt, notFound } = await fetchManifest(dateKey);
      const stops = entries.map(e => entryToStop(e, dateKey));
      const loads = buildLoadsFromStops(stops);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          source: 'glorybound-firestore',
          dateKey,
          stops, loads,
          summary: buildSummary(stops, loads),
          notFound: !!notFound,
          updatedAt,
          generated: new Date().toISOString(),
        }),
      };
    }

    // Specific date
    if (apiPath === '__date') {
      const dateKey = params.date;
      if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need date=YYYY-MM-DD' }) };
      }
      const { entries, updatedAt, notFound } = await fetchManifest(dateKey);
      const stops = entries.map(e => entryToStop(e, dateKey));
      const loads = buildLoadsFromStops(stops);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          source: 'glorybound-firestore',
          dateKey,
          stops, loads,
          summary: buildSummary(stops, loads),
          notFound: !!notFound,
          updatedAt,
        }),
      };
    }

    // Date range (last N days)
    if (apiPath === '__range') {
      const days = Math.min(parseInt(params.days || '7', 10), 31);
      const results = [];
      const now = new Date();
      for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateKey = d.toISOString().slice(0, 10);
        try {
          const { entries, updatedAt, notFound } = await fetchManifest(dateKey);
          const stops = entries.map(e => entryToStop(e, dateKey));
          const loads = buildLoadsFromStops(stops);
          results.push({ dateKey, stops, loads, summary: buildSummary(stops, loads), notFound: !!notFound, updatedAt });
        } catch (e) {
          results.push({ dateKey, error: e.message });
        }
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ source: 'glorybound-firestore', days: results }) };
    }

    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Unknown path: ${apiPath}` }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
