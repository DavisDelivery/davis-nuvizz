// netlify/functions/nuvizz.js
// Proxy + aggregator for nuVizz REST API v7.
//
// CREDENTIALS: Uses HTTP Basic Auth directly on every call (no JWT exchange).
// Two credential sets required:
//   DAVIS  — for all shipment/stop/load/route data
//   ULINE  — for document retrieval (photos, PODs). Many Uline stop docs are stored
//            under the ULINE company code, not DAVIS. Try ULINE first, fallback DAVIS.
//
// COMPANY CODE CASING: NuVizz normalizes case internally (DAVIS, davis, Davis all work)
// but the guide recommends uppercase DAVIS / ULINE for consistency.
//
// PRO NUMBERS: Always 9 digits, zero-padded. "7100000" → "007100000".
// The URL parameter order is {stopNumber}/{companyCode} — stop number FIRST.
//
// Endpoints exposed:
//   ?tenant=davis&path=__health        → auth check for both tenants
//   ?tenant=davis&path=__lookup&pro=X  → smart PRO lookup (normalizes 9-digit, returns stop + load + docs)
//   ?tenant=davis&path=__doc&guid=X&ext=jpg → document retrieval (ULINE first, DAVIS fallback)
//   ?tenant=davis&path=__stopsaway&loadNbr=X&stopNbr=Y → count of non-delivered stops before Y
//   ?tenant=davis&path=__fleet&date=YYYY-MM-DD&from=N&to=N → scan load number range, return driver board
//   ?tenant=davis&path=__driver&userName=JIM&date=... → one driver's loads+stops for a day
//   ?tenant=davis&path=/stop/info/X/DAVIS → raw passthrough
//
// __fleet technique: since NuVizz v7 doesn't have a "list today's loads" endpoint, we scan
// a range of load numbers (e.g. 192500-192800) in parallel via /load/info/, filter to the
// target date, and return the dispatch board. Load numbers are roughly sequential per day
// (Davis dispatches ~100 loads/day), so a 300-wide scan covers 2-3 days.


const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const DOC_BASE = process.env.NUVIZZ_DOC_BASE || 'https://portal.nuvizz.com/deliverit/openapi/documentapi';

// Firestore persistence layer (cross-instance cache for fleet data)
const fs_db = require('./lib/firestore.cjs');

// PRO normalization: always 9 digits, zero-padded
function normalizePro(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^0+/, '');
  if (!cleaned) return '000000000';
  if (!/^\d+$/.test(cleaned)) return null; // non-numeric = invalid
  if (cleaned.length > 9) return cleaned; // keep as-is if already longer than 9
  return cleaned.padStart(9, '0');
}

function getCreds(tenant) {
  if (tenant === 'uline') {
    return {
      companyCode: (process.env.NUVIZZ_ULINE_COMPANY_CODE || 'ULINE').toUpperCase(),
      user: process.env.NUVIZZ_ULINE_USER,
      pass: process.env.NUVIZZ_ULINE_PASS,
    };
  }
  return {
    companyCode: (process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase(),
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

function basicAuthHeader(tenant) {
  const { user, pass } = getCreds(tenant);
  if (!user || !pass) throw new Error(`Missing NUVIZZ_${tenant.toUpperCase()}_USER or _PASS env var`);
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// Document retrieval with dual-credential fallback.
// Most Uline stop documents live under the ULINE company code, not DAVIS.
// Strategy: try ULINE first, fall back to DAVIS if ULINE errors.
async function fetchDocument(documentGuid, ext, objectType = '02') {
  const attempts = [];

  // STRATEGY 1: Direct NuVizz call (preferred — own integration, no third-party hop)
  // Tries every combination of tenant (ULINE first per guide) x objectType.
  // NOTE: We've observed that NuVizz currently returns reasonCode 923 "No Document Found"
  // for every direct call despite valid auth. The integration guide's /doc/getdocument
  // endpoint may require params we can't yet determine (the tracker portal sends an
  // X-API-KEY header we don't have and uses a different endpoint path tree).
  // So this path often fails; strategy 2 is the working fallback.
  const objectTypes = [objectType, '', '02', '03', '01'].filter((v, i, a) => a.indexOf(v) === i);
  const tenants = ['uline', 'davis'];

  const tryDirect = async (tenant, otype) => {
    const { companyCode } = getCreds(tenant);
    const qs = new URLSearchParams({ documentGuid });
    qs.set('objectType', otype);
    if (ext) qs.set('extension', ext); // Missing field discovered in tracker portal JS
    const url = `${DOC_BASE}/doc/getdocument/${encodeURIComponent(companyCode)}?${qs.toString()}`;
    const resp = await fetch(url, {
      headers: { Authorization: basicAuthHeader(tenant), Accept: 'application/json' },
    });
    const text = await resp.text();
    const info = { strategy: 'direct', tenant, companyCode, objectType: otype, url, status: resp.status, ok: resp.ok, bodyPreview: text.slice(0, 150) };
    attempts.push(info);
    if (!resp.ok) return null;
    try {
      const data = JSON.parse(text);
      if (!data || !data.documentData) { info.reason = 'missing documentData'; return null; }
      info.sizeBytes = data.documentData.length;
      return data.documentData;
    } catch (e) { info.reason = 'parse: ' + e.message; return null; }
  };

  let b64 = null;
  outer: for (const tenant of tenants) {
    for (const otype of objectTypes) {
      try {
        const result = await tryDirect(tenant, otype);
        if (result) { b64 = result; break outer; }
      } catch (e) {
        attempts.push({ strategy: 'direct', tenant, objectType: otype, error: e.message });
      }
    }
  }

  // STRATEGY 2: Chain to tracking.davisdelivery.com's /doc function.
  // That site has a working NuVizz document integration — same Netlify team, same creds.
  // We proxy the call through it as a fallback until we fully understand the direct path.
  if (!b64) {
    const trackingUrl = `https://tracking.davisdelivery.com/.netlify/functions/doc?guid=${encodeURIComponent(documentGuid)}&ext=${encodeURIComponent(ext || 'jpg')}&company=ULINE`;
    const chainInfo = { strategy: 'tracking-chain', url: trackingUrl };
    try {
      const resp = await fetch(trackingUrl, { headers: { Accept: 'application/json' } });
      chainInfo.status = resp.status;
      chainInfo.ok = resp.ok;
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.dataUri) {
          // The tracking function already returns a data URI (fully formed), not raw base64.
          // Unwrap the base64 portion so our caller can re-wrap with correct mime for the ext.
          const commaIdx = data.dataUri.indexOf(',');
          if (commaIdx > 0) {
            b64 = data.dataUri.slice(commaIdx + 1);
            chainInfo.sizeBytes = b64.length;
          }
        } else {
          chainInfo.reason = 'no dataUri in response';
        }
      } else {
        const txt = await resp.text();
        chainInfo.bodyPreview = txt.slice(0, 150);
      }
      attempts.push(chainInfo);
    } catch (e) {
      chainInfo.error = e.message;
      attempts.push(chainInfo);
    }
  }

  if (!b64) return { ok: false, attempts };

  // Prepend the correct data URI prefix based on extension
  const extLower = (ext || 'jpg').toLowerCase();
  const mime =
    extLower === 'pdf' ? 'application/pdf' :
    extLower === 'png' ? 'image/png' :
    extLower === 'gif' ? 'image/gif' :
    'image/jpeg';
  return { ok: true, dataUri: `data:${mime};base64,${b64}`, mime, ext: extLower, attempts };
}

// Core authenticated fetch against nuVizz (Basic Auth directly — no JWT)
async function nvFetch(tenant, path, { method = 'GET', body = null, extraParams = {} } = {}) {
  const qs = new URLSearchParams(extraParams).toString();
  const url = `${NUVIZZ_BASE}${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuthHeader(tenant),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    // Bubble up the NuVizz error payload — it's more helpful than HTTP code alone
    const nvMsg = data?.message || data?.reasons?.[0]?.description || `HTTP ${resp.status}`;
    const err = new Error(nvMsg);
    err.status = resp.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  return data;
}

// Concurrency-limited parallel map
async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Aggregator: fetch all loads for a date ----
async function fetchLoadNbrsForDate(tenant, dateISO) {
  const { companyCode } = getCreds(tenant);
  const date = dateISO.slice(0, 10); // YYYY-MM-DD

  // Strategy 1: /event/eventactivity for entityType=ROUTE
  try {
    const raw = await nvFetch(tenant, `/event/eventactivity/${encodeURIComponent(companyCode)}`, {
      extraParams: { entityType: 'ROUTE', eventDttm: date },
    });
    const events = raw?.eventActivity || [];
    const loadNbrs = [...new Set(events.map(e => e.entityNbr).filter(Boolean))];
    if (loadNbrs.length > 0) return { loadNbrs, method: 'eventActivity' };
  } catch (_) {}

  // Strategy 2: /load/static/info with routeDate
  try {
    const raw = await nvFetch(tenant, `/load/static/info/${encodeURIComponent(companyCode)}`, {
      extraParams: { routeDate: date },
    });
    const routes = raw?.routes || raw?.loads || [];
    const loadNbrs = routes.map(r => r.loadNbr || r.routeNbr).filter(Boolean);
    if (loadNbrs.length > 0) return { loadNbrs, method: 'staticRoute' };
  } catch (_) {}

  // Strategy 3: stop/eventinfo by date — extract unique loadNbrs from stop data
  try {
    const raw = await nvFetch(tenant, `/stop/eventinfo/${encodeURIComponent(companyCode)}`, {
      extraParams: { eventDate: date },
    });
    const stops = raw?.stops || raw?.stopList || [];
    const loadNbrs = [...new Set(stops.map(s => s.loadNbr || s.routeNbr).filter(Boolean))];
    if (loadNbrs.length > 0) return { loadNbrs, method: 'stopEventInfo' };
  } catch (_) {}

  return { loadNbrs: [], method: 'none' };
}

async function fetchLoadsAndStopsForRange(tenant, fromDTTM, toDTTM) {
  const { companyCode } = getCreds(tenant);

  // Get all stops in range via /stop/info/customer (no customer filter → all stops)
  let stops = [];
  try {
    const stopSearch = await nvFetch(tenant, `/stop/info/customer/${encodeURIComponent(companyCode)}`, {
      extraParams: { fromDTTM, toDTTM },
    });
    stops = stopSearch?.stops || stopSearch?.stopList || stopSearch?.Stops || [];
  } catch (e) {
    // Fallback — try event-driven discovery
    const { loadNbrs } = await fetchLoadNbrsForDate(tenant, fromDTTM);
    const loadsRaw = await parallelMap(loadNbrs, 5, async (loadNbr) => {
      const data = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
      return data?.Load || data;
    });
    const loads = loadsRaw.filter(l => !l.__error);
    stops = loads.flatMap(l => (l.stops || []).map(s => ({ ...s, load: { loadNbr: l.loadHeader?.loadNbr } })));
    return { stops, loads, loadNbrs, summary: buildSummary(stops, loads), method: 'event-driven-fallback', generated: new Date().toISOString() };
  }

  // Unique loadNbrs on those stops
  const loadNbrs = Array.from(new Set(
    stops.map(s => s.load?.loadNbr || s.loadNbr || s.routeAsgnInfo?.routeNbr).filter(Boolean)
  ));

  // Fetch load details in parallel
  const loadsRaw = await parallelMap(loadNbrs, 5, async (loadNbr) => {
    const data = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
    return data?.Load || data;
  });
  const loads = loadsRaw.filter(l => !l.__error);

  return {
    stops, loads, loadNbrs,
    summary: buildSummary(stops, loads),
    method: 'stop-customer-search',
    generated: new Date().toISOString(),
  };
}

function buildSummary(stops, loads) {
  const total = stops.length;
  let completed = 0, inProgress = 0, pending = 0, failed = 0, cancelled = 0;
  let dwellSum = 0, dwellCount = 0;
  let onTime = 0, late = 0, early = 0;
  const customerCounts = {};

  for (const s of stops) {
    const exec = s.stopExecutionInfo || {};
    const status = (exec.stopStatus || s.status || '').toString().toUpperCase();
    if (status.includes('COMPLET') || status.includes('CLOSED') || status.includes('DELIV')) completed++;
    else if (status.includes('PROGRESS') || status.includes('DISPATCH') || status.includes('ENROUTE')) inProgress++;
    else if (status.includes('FAIL')) failed++;
    else if (status.includes('CANCEL')) cancelled++;
    else pending++;

    const toTs = exec.to || {};
    if (toTs.duration) { dwellSum += toTs.duration; dwellCount++; }
    if (toTs.etaCode === 'ONTIME') onTime++;
    else if (toTs.etaCode === 'LATE' || toTs.etaCode === 'DELAYED') late++;
    else if (toTs.etaCode === 'EARLY') early++;

    const cust = s.stop?.custInfo?.custName || s.custInfo?.custName || s.accountNumber || 'Unknown';
    customerCounts[cust] = (customerCounts[cust] || 0) + 1;
  }

  let miles = 0;
  for (const l of loads) {
    const exec = l.loadExecutionInfo || {};
    miles += (exec.actualDistanceMiles || exec.plannedDistanceMiles || 0);
  }

  return {
    totalStops: total, completed, inProgress, pending, failed, cancelled,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,
    avgDwellMin: dwellCount ? Math.round(dwellSum / dwellCount) : 0,
    onTime, late, early,
    totalLoads: loads.length,
    totalMiles: Math.round(miles),
    topCustomers: Object.entries(customerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
  };
}

// ---- Fleet scan: discover all loads for a given date via load-number range probe ----
// Davis dispatches ~100 loads/day in sequential DAVIS{9-digit} format. NuVizz has no native
// "list loads for date" endpoint, so we probe a range of load numbers in parallel. We use
// a ±75 window (150 numbers) at concurrency 20, which completes in ~6-10 seconds and
// reliably covers a full day's loads.
async function scanFleet(tenant, { dateFrom, dateTo, startNbr, endNbr, concurrency = 20, includeStops = false }) {
  const { companyCode } = getCreds(tenant);
  const authHeader = basicAuthHeader(tenant);
  const prefix = companyCode; // "DAVIS" or "ULINE"

  const probe = async (n) => {
    const loadNbr = `${prefix}${String(n).padStart(9, '0')}`;
    const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
    try {
      const resp = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (!resp.ok) return null;
      const d = await resp.json();
      const h = d?.Load?.loadHeader || {};
      const a = d?.Load?.loadAssignment || {};
      const stops = d?.Load?.stops || [];
      const startDate = (h.earliestStartDttm || '').slice(0, 10);
      if (dateFrom && startDate < dateFrom) return null;
      if (dateTo && startDate > dateTo) return null;
      const delivered = stops.filter(s => s?.stopExecutionInfo?.stopStatus === '90').length;
      const inProgress = stops.filter(s => ['30', '40'].includes(s?.stopExecutionInfo?.stopStatus)).length;
      // True exception: explicit flag or non-empty exceptions array. NuVizz sometimes leaves
      // stopStatus=50 on stops where the driver photographed but didn't tap Complete — those
      // aren't real problems and shouldn't inflate the dispatcher's issue count.
      const exceptions = stops.filter(s => {
        const ei = s?.stopExecutionInfo;
        if (!ei) return false;
        return ei.exceptionPresent === true || (Array.isArray(ei.exceptions) && ei.exceptions.length > 0);
      }).length;
      const summary = {
        loadNbr: h.loadNbr,
        loadId: h.loadId,
        route: h.routeName,
        startDate,
        driver: a.driverName,
        driverUserName: a.driverUserName,
        driverEmail: a.driverEmail,
        vehicleType: h.vehicleType,
        totalStops: stops.length,
        delivered,
        inProgress,
        exceptions,
        pctComplete: stops.length ? Math.round((delivered / stops.length) * 100) : 0,
        totalPallets: h.totalPallets,
        totalCartons: h.totalCartons,
        weight: h.weight,
        // Origin / terminal — needed by Map view to draw terminal markers + stem-out lines.
        origin: {
          name: h.originName,
          addr1: h.originAddr1,
          city: h.originCity,
          state: h.originState,
          zip: h.originZip,
          latitude: h.originLatitude,
          longitude: h.originLongitude,
        },
      };
      // Flatten stops into slim objects for the stop-level views (Map/Stops)
      if (includeStops) {
        summary.stops = stops.map(s => {
          const stop = s.stop || {};
          const exec = s.stopExecutionInfo || {};
          const toInfo = exec.to || {};
          const addr = stop.to?.address || {};
          return {
            stopNbr: stop.stopNbr,
            stopType: stop.stopType,
            status: exec.stopStatus,
            exceptionPresent: !!exec.exceptionPresent,
            exceptions: Array.isArray(exec.exceptions) ? exec.exceptions : [],
            name: addr.name,
            addr1: addr.addr1,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            latitude: addr.latitude,
            longitude: addr.longitude,
            bol: stop.bol,
            pallets: stop.totalPallets,
            cartons: stop.totalCartons,
            weight: stop.weight,
            plannedEta: toInfo.plannedEtaDTTM,
            etaDTTM: toInfo.etaDttm,
            arrivalDTTM: toInfo.arrivalDTTM,
            confirmedDTTM: toInfo.confirmedDTTM,
            etaCode: toInfo.etaCode,
            // carry load context so the UI can show "on JIM 1" or link back
            loadNbr: h.loadNbr,
            route: h.routeName,
            driver: a.driverName,
            driverUserName: a.driverUserName,
          };
        });
      }
      return summary;
    } catch (e) { return null; }
  };

  const nums = [];
  for (let n = endNbr; n >= startNbr; n--) nums.push(n);

  const results = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const myIdx = idx++;
      const r = await probe(nums[myIdx]);
      if (r) results.push(r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runOne));

  results.sort((a, b) => (a.route || '').localeCompare(b.route || ''));
  return results;
}

// ---- In-memory fleet cache (60s TTL, per-tenant, per-date) ----
// Netlify Functions reuse instances across warm invocations, so this gives us fast
// repeat loads without hitting NuVizz again. Clears automatically on cold start.
const __fleetCache = new Map();
const FLEET_CACHE_TTL_MS = 60 * 1000;
function getCachedFleet(tenant, dateStr) {
  const key = `${tenant}:${dateStr}`;
  const hit = __fleetCache.get(key);
  if (hit && Date.now() - hit.storedAt < FLEET_CACHE_TTL_MS) return hit.data;
  return null;
}
function setCachedFleet(tenant, dateStr, data) {
  const key = `${tenant}:${dateStr}`;
  __fleetCache.set(key, { storedAt: Date.now(), data });
  if (__fleetCache.size > 50) {
    const firstKey = __fleetCache.keys().next().value;
    __fleetCache.delete(firstKey);
  }
}

// ---- Persistent Firestore storage (shared across function instances) ----
// The scheduled function "fleet-refresh-background" writes pre-computed fleet data to
// Firestore every 2 minutes. When users hit __fleet / __fleetstops, we read from
// Firestore first — this eliminates the 10-15s cold-start scan on mobile.
// Firestore freshness: accept up to FLEET_FIRESTORE_MAX_AGE_MS, otherwise fall back to live scan.
const FLEET_FIRESTORE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Read the entire fleet for a date from Firestore. Returns { loads, summary } or null.
async function readFleetFromFirestore(tenant, dateStr) {
  if (!fs_db.isFirestoreEnabled()) return null;
  try {
    const [summary, loads] = await Promise.all([
      fs_db.readSummary(tenant, dateStr),
      fs_db.listLoads(tenant, dateStr),
    ]);
    if (!summary || !loads || loads.length === 0) return null;
    // Check age
    if (summary._updatedAt) {
      const age = Date.now() - new Date(summary._updatedAt).getTime();
      if (age > FLEET_FIRESTORE_MAX_AGE_MS) return null; // stale
    }
    return { loads, summary };
  } catch (e) {
    console.error('Firestore read failed:', e.message);
    return null;
  }
}

// Write the entire fleet (after a live scan) to Firestore. Per-load granularity means
// individual __refreshLoad calls can update one doc without rewriting the whole fleet.
async function writeFleetToFirestore(tenant, dateStr, loads, summary) {
  if (!fs_db.isFirestoreEnabled()) return;
  try {
    // Write loads in parallel batches of 10 to avoid overwhelming Firestore quotas
    const batchSize = 10;
    for (let i = 0; i < loads.length; i += batchSize) {
      const batch = loads.slice(i, i + batchSize);
      await Promise.all(batch.map(l => fs_db.writeLoad(tenant, dateStr, l).catch(() => null)));
    }
    // Build driver index from loads
    const driverIndex = {};
    for (const l of loads) {
      if (!l.driverUserName) continue;
      if (!driverIndex[l.driverUserName]) driverIndex[l.driverUserName] = [];
      driverIndex[l.driverUserName].push(l.loadNbr);
    }
    await Promise.all([
      fs_db.writeSummary(tenant, dateStr, summary),
      fs_db.writeDriverIndex(tenant, dateStr, driverIndex),
    ]);
  } catch (e) {
    console.error('Firestore write failed:', e.message);
  }
}

// Estimate the load number range for a given date. Davis's load numbering grows ~100/business
// day (Mon-Fri), with NO growth on weekends. The old calendar-day projection (×80/day including
// weekends) drifted badly over weeks because it counted Sat/Sun as +80 each when they're really 0.
// We now project using BUSINESS days only, anchored to a recent verified point.

// Anchor: Fri Jun 5 2026, actual load range 196094-196192 (center ~196143).
// Re-anchor this to any recent business day if drift returns: open the app, note today's
// first/last load number, set ANCHOR_DATE + ANCHOR_LOAD to the center.
const ANCHOR_DATE = new Date('2026-06-05T00:00:00Z');
const ANCHOR_LOAD = 196143; // center of Jun 5 (range 196094-196192)
const LOADS_PER_BIZ_DAY = 100; // Davis dispatches ~100 loads per business day

// Count business days (Mon-Fri) between two dates. Positive if `to` is after `from`,
// negative if before. Excludes weekends since Davis doesn't dispatch Sat/Sun.
function businessDaysBetween(from, to) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const sign = to >= from ? 1 : -1;
  let count = 0;
  let cur = new Date(Math.min(from, to));
  const end = new Date(Math.max(from, to));
  while (cur < end) {
    cur = new Date(cur.getTime() + msPerDay);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return sign * count;
}

// In-memory calibration cache: map date → { startNbr, endNbr } confirmed by a scan
const __rangeCache = new Map();

function estimateLoadRange(dateStr) {
  // If we have a recently-calibrated range for this date, use it (saves scan time).
  // Expires after 10 min to let new dispatches show up.
  const cached = __rangeCache.get(dateStr);
  if (cached && Date.now() - cached.storedAt < RANGE_CACHE_TTL_MS) {
    return cached.range;
  }

  const target = new Date(dateStr + 'T00:00:00Z');
  const bizDaysDiff = businessDaysBetween(ANCHOR_DATE, target);
  const center = ANCHOR_LOAD + bizDaysDiff * LOADS_PER_BIZ_DAY;
  // Window ±300 (600 numbers): comfortably covers a day's ~100-load span plus drift slack,
  // while fitting inside the 26s function timeout when scanning with stops at concurrency 50.
  // The self-calibrating range cache narrows this after the first scan so reads stay fast.
  return { startNbr: center - 300, endNbr: center + 300 };
}

// Called after every successful scan to lock in the actual range found for a date.
// Next scan for same date will use this tight range instead of the wide guess.
//
// Important: dispatchers add loads throughout the day, so we pad generously on the HIGH side
// (+100) to catch late additions, and modestly on the LOW side (-20) since older loads rarely
// backfill below the floor. Also TTL-expire the cache so a stale calibration from morning
// doesn't permanently clamp an afternoon scan.
//
// SANITY: don't narrow the cache if we found very few loads — probably an early-morning scan
// before dispatch finished. Keep the wide window for the next caller.
const RANGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_LOADS_TO_CALIBRATE = 50; // trust range narrowing only once we've found a decent batch
function calibrateLoadRange(dateStr, loadsFound) {
  if (!loadsFound || loadsFound.length < MIN_LOADS_TO_CALIBRATE) return;
  const nums = loadsFound
    .map(l => {
      const m = (l.loadNbr || '').match(/(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(n => n != null);
  if (nums.length < MIN_LOADS_TO_CALIBRATE) return;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  __rangeCache.set(dateStr, {
    storedAt: Date.now(),
    range: { startNbr: min - 20, endNbr: max + 100 },
  });
  if (__rangeCache.size > 30) {
    const firstKey = __rangeCache.keys().next().value;
    __rangeCache.delete(firstKey);
  }
}

// ---- Handler ----
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const tenant = (params.tenant || 'davis').toLowerCase();
    const apiPath = params.path;
    if (!apiPath) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing ?path=' }) };

    // Health check — just verify Basic Auth works on a cheap endpoint for each tenant
    if (apiPath === '__health') {
      const results = {};
      for (const t of ['davis', 'uline']) {
        try {
          const { companyCode } = getCreds(t);
          // Hit a tiny endpoint that we know responds. /stop/info/NOTAREAL/ will 400 with
          // a domain-level error meaning auth succeeded (we don't care about the 400).
          const url = `${NUVIZZ_BASE}/stop/info/__probe__/${encodeURIComponent(companyCode)}`;
          const r = await fetch(url, { headers: { Authorization: basicAuthHeader(t), Accept: 'application/json' } });
          const txt = await r.text();
          const authOk = r.status !== 401 && r.status !== 403;
          results[t] = { ok: authOk, status: r.status, preview: txt.slice(0, 120) };
        } catch (e) { results[t] = { ok: false, error: e.message }; }
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(results) };
    }

    // Today aggregator
    if (apiPath === '__today') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const data = await fetchLoadsAndStopsForRange(tenant, start.toISOString(), end.toISOString());
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // Date range aggregator
    if (apiPath === '__daterange') {
      if (!params.from || !params.to) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need from & to ISO dates' }) };
      }
      const data = await fetchLoadsAndStopsForRange(tenant, params.from, params.to);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // Loads-by-date (simpler than today — just load nbrs, no full stop data)
    if (apiPath === '__loadsbydate') {
      const date = params.date || new Date().toISOString().slice(0, 10);
      const data = await fetchLoadNbrsForDate(tenant, date);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // --- Smart PRO lookup ---
    // Normalizes PRO to 9-digit zero-padded, fetches stop info, and includes
    // the parent load header so the UI can show "stops away" / route context.
    //   ?tenant=davis&path=__lookup&pro=7100000
    if (apiPath === '__lookup') {
      const rawPro = params.pro || params.stopNbr || '';
      const pro = normalizePro(rawPro);
      if (!pro) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid PRO number — must be numeric' }) };
      }
      const { companyCode } = getCreds(tenant);
      let stop;
      try {
        stop = await nvFetch(tenant, `/stop/info/${encodeURIComponent(pro)}/${encodeURIComponent(companyCode)}`);
      } catch (e) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: e.message, pro, normalizedPro: pro, original: rawPro }) };
      }

      // Optionally pull the load to compute stops-away
      let load = null;
      let stopsAway = null;
      let loadError = null;
      const loadNbr = stop?.Stop?.load?.loadNbr;
      if (loadNbr && params.includeLoad !== 'false') {
        try {
          load = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
          const stops = load?.Load?.stops || [];
          const targetIdx = stops.findIndex(s => s?.stop?.stopNbr === pro);
          if (targetIdx > 0) {
            stopsAway = stops.slice(0, targetIdx)
              .filter(s => (s?.stopExecutionInfo?.stopStatus || '') !== '90')
              .length;
          } else if (targetIdx === 0) {
            stopsAway = 0;
          }
        } catch (e) {
          loadError = e.message;
        }
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          pro,
          normalizedPro: pro,
          originalInput: rawPro,
          stop: stop?.Stop ?? null,
          load: (load?.Load) ?? null,
          stopsAway: stopsAway ?? null,
          loadError,
          loadNbr,
        }),
      };
    }

    // --- Document retrieval (dual-credential fallback: ULINE first, DAVIS fallback) ---
    //   ?tenant=davis&path=__doc&guid=XXX&ext=jpg&objectType=02
    //   ?tenant=davis&path=__doc&guid=XXX&ext=jpg&debug=1   → returns per-attempt details
    if (apiPath === '__doc') {
      const guid = params.guid || params.documentGuid;
      const ext = params.ext || 'jpg';
      const objectType = params.objectType || '02';
      const debug = params.debug === '1' || params.debug === 'true';
      if (!guid) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing guid' }) };
      }
      const doc = await fetchDocument(guid, ext, objectType);
      if (!doc.ok) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'Document not found under ULINE or DAVIS',
            attempts: doc.attempts,
          }),
        };
      }
      const payload = { dataUri: doc.dataUri, mime: doc.mime, ext: doc.ext };
      if (debug) payload.attempts = doc.attempts;
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(payload) };
    }

    // --- Fleet dispatch board: scan load-number range, return all loads for a date ---
    //   ?tenant=davis&path=__fleet                    → today's fleet (auto-range, cached 60s)
    //   ?tenant=davis&path=__fleet&date=2026-04-15    → specific day
    //   ?tenant=davis&path=__fleet&from=192500&to=192800 → manual range override
    //   ?tenant=davis&path=__fleet&nocache=1          → bypass cache
    if (apiPath === '__fleet') {
      const dateStr = params.date || new Date().toISOString().slice(0, 10);
      const bypassCache = params.nocache === '1' || params.nocache === 'true';

      // Layer 1: in-memory cache (60s, per-function-instance, fastest)
      if (!bypassCache && !params.from && !params.to) {
        const cached = getCachedFleet(tenant, dateStr);
        if (cached) {
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'X-Cache': 'HIT-MEM' },
            body: JSON.stringify({ ...cached, cached: true }),
          };
        }
      }

      // Layer 2: Firestore (cross-instance, populated by scheduled function or any prior scan)
      // This is the big speedup — sub-second response from a single Firestore query.
      if (!bypassCache && !params.from && !params.to) {
        const fsData = await readFleetFromFirestore(tenant, dateStr);
        if (fsData && fsData.loads && fsData.loads.length > 0) {
          // Strip per-load stops to keep payload light — __fleet response is summary only
          const slimLoads = fsData.loads.map(({ stops, _updatedAt, ...rest }) => rest);
          slimLoads.sort((a, b) => (a.route || '').localeCompare(b.route || ''));
          const summary = { ...fsData.summary };
          delete summary._updatedAt;
          const result = { date: dateStr, loads: slimLoads, summary, source: 'firestore' };
          setCachedFleet(tenant, dateStr, result);
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'X-Cache': 'HIT-FS' },
            body: JSON.stringify({ ...result, cached: true }),
          };
        }
      }

      // Layer 3: live scan (fallback, ~10-12s)
      let startNbr, endNbr;
      if (params.from && params.to) {
        startNbr = parseInt(params.from, 10);
        endNbr = parseInt(params.to, 10);
      } else {
        const range = estimateLoadRange(dateStr);
        startNbr = range.startNbr;
        endNbr = range.endNbr;
      }
      const loads = await scanFleet(tenant, {
        dateFrom: dateStr,
        dateTo: dateStr,
        startNbr,
        endNbr,
        concurrency: 50,
        includeStops: true, // we need stops to write rich load docs to Firestore
      });

      // Calibrate: store the actual number range for this date so next scan is tight+fast
      if (!params.from && !params.to) calibrateLoadRange(dateStr, loads);

      const summary = {
        totalLoads: loads.length,
        assignedLoads: loads.filter(l => l.driver).length,
        unassignedLoads: loads.filter(l => !l.driver).length,
        totalStops: loads.reduce((sum, l) => sum + l.totalStops, 0),
        totalDelivered: loads.reduce((sum, l) => sum + l.delivered, 0),
        totalInProgress: loads.reduce((sum, l) => sum + l.inProgress, 0),
        totalExceptions: loads.reduce((sum, l) => sum + l.exceptions, 0),
        uniqueDrivers: new Set(loads.map(l => l.driverUserName).filter(Boolean)).size,
      };
      summary.pctComplete = summary.totalStops ? Math.round((summary.totalDelivered / summary.totalStops) * 100) : 0;

      // Persist to Firestore (with stops) — gives __fleetstops + __driver fast path later.
      // Fire-and-forget so we don't block the user's response on the write.
      if (!params.from && !params.to) {
        writeFleetToFirestore(tenant, dateStr, loads, summary).catch(() => null);
      }

      // Strip per-load stops from the response (caller of __fleet doesn't need them — saves bandwidth)
      const slimLoads = loads.map(({ stops, ...rest }) => rest);
      const result = { date: dateStr, loads: slimLoads, summary, scannedRange: { from: startNbr, to: endNbr }, source: 'live-scan' };

      // In-memory cache for 60s
      if (!params.from && !params.to) setCachedFleet(tenant, dateStr, result);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'X-Cache': 'MISS' },
        body: JSON.stringify(result),
      };
    }

    // --- Fleet stops: flat list of all stops across all of today's loads ---
    //   ?tenant=davis&path=__fleetstops             → all stops today (Map/Stops views)
    //   ?tenant=davis&path=__fleetstops&date=YYYY-MM-DD
    // Shares scan with __fleet via the same cache entry (keyed with :stops suffix).
    if (apiPath === '__fleetstops') {
      const dateStr = params.date || new Date().toISOString().slice(0, 10);
      const bypassCache = params.nocache === '1' || params.nocache === 'true';
      const stopsCacheKey = `${tenant}:${dateStr}:stops`;

      // Layer 1: in-memory cache
      if (!bypassCache) {
        const hit = __fleetCache.get(stopsCacheKey);
        if (hit && Date.now() - hit.storedAt < FLEET_CACHE_TTL_MS) {
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'X-Cache': 'HIT-MEM' },
            body: JSON.stringify({ ...hit.data, cached: true }),
          };
        }
      }

      // Layer 2: Firestore — load docs include their stops as inline arrays
      if (!bypassCache) {
        const fsData = await readFleetFromFirestore(tenant, dateStr);
        if (fsData && fsData.loads && fsData.loads.length > 0) {
          // Flatten stops across all loads
          const stops = [];
          const loadsMeta = [];
          for (const l of fsData.loads) {
            if (Array.isArray(l.stops)) stops.push(...l.stops);
            loadsMeta.push({
              nbr: l.loadNbr, route: l.route, driver: l.driver,
              driverUserName: l.driverUserName, vehicleType: l.vehicleType,
              totalStops: l.totalStops, delivered: l.delivered,
              inProgress: l.inProgress, exceptions: l.exceptions,
              pctComplete: l.pctComplete, origin: l.origin || null,
            });
          }
          stops.sort((a, b) => (a.plannedEta || '').localeCompare(b.plannedEta || ''));
          const summary = {
            totalStops: stops.length,
            delivered: stops.filter(s => s.status === '90').length,
            inProgress: stops.filter(s => s.status === '40').length,
            scheduled: stops.filter(s => s.status === '30').length,
            exceptions: stops.filter(s => s.exceptionPresent === true).length,
            withCoords: stops.filter(s => s.latitude && s.longitude).length,
          };
          summary.pctComplete = summary.totalStops ? Math.round((summary.delivered / summary.totalStops) * 100) : 0;
          const result = { date: dateStr, stops, loads: loadsMeta, summary, source: 'firestore' };
          __fleetCache.set(stopsCacheKey, { storedAt: Date.now(), data: result });
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'X-Cache': 'HIT-FS' },
            body: JSON.stringify({ ...result, cached: true }),
          };
        }
      }

      // Layer 3: live scan
      const range = estimateLoadRange(dateStr);
      const loadsWithStops = await scanFleet(tenant, {
        dateFrom: dateStr,
        dateTo: dateStr,
        startNbr: range.startNbr,
        endNbr: range.endNbr,
        concurrency: 50,
        includeStops: true,
      });

      calibrateLoadRange(dateStr, loadsWithStops);

      // Flatten to one array of stops, and pull out per-load metadata for the map.
      const stops = [];
      const loadsMeta = [];
      for (const l of loadsWithStops) {
        if (l.stops) stops.push(...l.stops);
        loadsMeta.push({
          nbr: l.loadNbr, route: l.route, driver: l.driver,
          driverUserName: l.driverUserName, vehicleType: l.vehicleType,
          totalStops: l.totalStops, delivered: l.delivered,
          inProgress: l.inProgress, exceptions: l.exceptions,
          pctComplete: l.pctComplete, origin: l.origin || null,
        });
      }
      // Sort by plannedEta for a chronological feed
      stops.sort((a, b) => (a.plannedEta || '').localeCompare(b.plannedEta || ''));

      const summary = {
        totalStops: stops.length,
        delivered: stops.filter(s => s.status === '90').length,
        inProgress: stops.filter(s => s.status === '40').length,
        scheduled: stops.filter(s => s.status === '30').length,
        exceptions: stops.filter(s => s.exceptionPresent === true).length,
        withCoords: stops.filter(s => s.latitude && s.longitude).length,
      };
      summary.pctComplete = summary.totalStops ? Math.round((summary.delivered / summary.totalStops) * 100) : 0;

      const result = { date: dateStr, stops, loads: loadsMeta, summary, scannedRange: { from: range.startNbr, to: range.endNbr }, source: 'live-scan' };
      __fleetCache.set(stopsCacheKey, { storedAt: Date.now(), data: result });
      if (__fleetCache.size > 50) {
        const firstKey = __fleetCache.keys().next().value;
        __fleetCache.delete(firstKey);
      }

      // Persist to Firestore so __fleet's read benefits from this scan too.
      // Compute the load summary stats for the fleet doc.
      const fleetSummary = {
        totalLoads: loadsWithStops.length,
        assignedLoads: loadsWithStops.filter(l => l.driver).length,
        unassignedLoads: loadsWithStops.filter(l => !l.driver).length,
        totalStops: summary.totalStops,
        totalDelivered: summary.delivered,
        totalInProgress: summary.inProgress,
        totalExceptions: summary.exceptions,
        uniqueDrivers: new Set(loadsWithStops.map(l => l.driverUserName).filter(Boolean)).size,
        pctComplete: summary.pctComplete,
      };
      writeFleetToFirestore(tenant, dateStr, loadsWithStops, fleetSummary).catch(() => null);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'X-Cache': 'MISS' },
        body: JSON.stringify(result),
      };
    }

    // --- Driver view: all loads + stops for one driver on a given date ---
    //   ?tenant=davis&path=__driver&userName=JIM
    //   ?tenant=davis&path=__driver&userName=JIM&date=2026-04-17
    //   ?tenant=davis&path=__driver&driverName=JIM+PALLETTE
    if (apiPath === '__driver') {
      const userName = (params.userName || '').toUpperCase();
      const driverNameFilter = (params.driverName || '').toUpperCase();
      const dateStr = params.date || new Date().toISOString().slice(0, 10);
      if (!userName && !driverNameFilter) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need userName or driverName' }) };
      }

      // Fetch the driver profile (if userName given) for sanity
      let driverProfile = null;
      if (userName) {
        try {
          const { companyCode } = getCreds(tenant);
          driverProfile = await nvFetch(tenant, `/user/info/${encodeURIComponent(companyCode)}`, {
            extraParams: { userName },
          });
        } catch (_) {}
      }

      // Granular path: read driver index from Firestore, then fetch ONLY that driver's
      // load(s) live from NuVizz. ~1-2 seconds total instead of full 10s scan.
      let matchedLoadNbrs = [];
      let allLoads = null;

      if (fs_db.isFirestoreEnabled() && userName) {
        try {
          const idx = await fs_db.readDriverIndex(tenant, dateStr);
          if (idx && idx.map && idx.map[userName]) {
            matchedLoadNbrs = idx.map[userName];
          }
        } catch (e) {
          console.error('Driver index read failed:', e.message);
        }
      }

      // Fall back to in-memory cache for driverName text-match or if index missing
      if (matchedLoadNbrs.length === 0) {
        allLoads = getCachedFleet(tenant, dateStr)?.loads;
        if (!allLoads) {
          // Last resort: also try Firestore listLoads (tenant-wide) since the
          // driver index might be missing but loads are populated
          try {
            const fsLoads = await fs_db.listLoads(tenant, dateStr);
            if (fsLoads && fsLoads.length > 0) allLoads = fsLoads;
          } catch (_) {}
        }
        if (!allLoads) {
          // Nothing cached anywhere — do the full scan
          const range = estimateLoadRange(dateStr);
          allLoads = await scanFleet(tenant, {
            dateFrom: dateStr,
            dateTo: dateStr,
            startNbr: range.startNbr,
            endNbr: range.endNbr,
            concurrency: 50,
            includeStops: true,
          });
          calibrateLoadRange(dateStr, allLoads);
          const summary = {
            totalLoads: allLoads.length,
            assignedLoads: allLoads.filter(l => l.driver).length,
            unassignedLoads: allLoads.filter(l => !l.driver).length,
            totalStops: allLoads.reduce((s, l) => s + l.totalStops, 0),
            totalDelivered: allLoads.reduce((s, l) => s + l.delivered, 0),
            totalInProgress: allLoads.reduce((s, l) => s + l.inProgress, 0),
            totalExceptions: allLoads.reduce((s, l) => s + l.exceptions, 0),
            uniqueDrivers: new Set(allLoads.map(l => l.driverUserName).filter(Boolean)).size,
          };
          summary.pctComplete = summary.totalStops ? Math.round((summary.totalDelivered / summary.totalStops) * 100) : 0;
          // Persist scan to Firestore so future requests benefit
          writeFleetToFirestore(tenant, dateStr, allLoads, summary).catch(() => null);
        }
        // Match by userName or driverName text
        const matched = allLoads.filter(l => {
          if (userName && l.driverUserName === userName) return true;
          if (driverNameFilter) {
            const dn = (l.driver || '').toUpperCase();
            if (dn.includes(driverNameFilter) || driverNameFilter.split(/\s+/).every(tok => dn.includes(tok))) return true;
          }
          return false;
        });
        matchedLoadNbrs = matched.map(l => l.loadNbr);
      }

      // Now: re-fetch each matched load LIVE from NuVizz for freshest data on the screen
      // the user is actually looking at. This is the key insight from Chad's request:
      // when you tap a driver, that driver's data should be fresh, not the whole fleet's.
      const { companyCode } = getCreds(tenant);
      const loadsWithStops = await Promise.all(
        matchedLoadNbrs.map(async (loadNbr) => {
          try {
            const full = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
            const h = full?.Load?.loadHeader || {};
            const a = full?.Load?.loadAssignment || {};
            const stops = full?.Load?.stops || [];
            return {
              loadNbr: h.loadNbr,
              route: h.routeName,
              driver: a.driverName,
              driverUserName: a.driverUserName,
              full: full?.Load,
            };
          } catch (e) {
            return { loadNbr, fullError: e.message };
          }
        })
      );

      // Flatten all stops into a unified list for driver-day view
      const allStops = [];
      for (const load of loadsWithStops) {
        const stops = load.full?.stops || [];
        for (const s of stops) {
          allStops.push({
            loadNbr: load.loadNbr,
            route: load.route,
            driver: load.driver,
            stopNbr: s.stop?.stopNbr,
            stopSeq: s.stop?.stopSeq,
            stopType: s.stop?.stopType,
            status: s.stopExecutionInfo?.stopStatus,
            name: s.stop?.to?.address?.name,
            city: s.stop?.to?.address?.city,
            state: s.stop?.to?.address?.state,
            bol: s.stop?.bol,
            pallets: s.stop?.totalPallets,
            weight: s.stop?.weight,
            confirmedDTTM: s.stopExecutionInfo?.to?.confirmedDTTM,
            plannedEta: s.stopExecutionInfo?.to?.plannedEtaDTTM,
            arrivalDTTM: s.stopExecutionInfo?.to?.arrivalDTTM,
            exceptionPresent: s.stopExecutionInfo?.exceptionPresent,
          });
        }
      }
      // Sort by plannedEta (real route order — NuVizz's stopSeq field is always 1, unusable).
      // Stops with no plannedEta go to the end. Within loads, this gives the driver's day in
      // route order. Across multiple loads (rare), loadNbr is the tiebreaker.
      allStops.sort((a, b) => {
        const aEta = a.plannedEta || '';
        const bEta = b.plannedEta || '';
        if (aEta && bEta) return aEta.localeCompare(bEta);
        if (aEta) return -1;
        if (bEta) return 1;
        return (a.loadNbr || '').localeCompare(b.loadNbr || '');
      });

      // Assign a display sequence number based on the sort — so the UI shows #1, #2, #3...
      allStops.forEach((s, i) => { s.displaySeq = i + 1; });

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          date: dateStr,
          userName,
          driverProfile: driverProfile ? {
            userName: driverProfile.userName,
            firstName: driverProfile.firstName,
            lastName: (driverProfile.lastName || '').trim(),
            email: driverProfile.email,
            userId: driverProfile.userId,
            accountStatus: driverProfile.accountStatus,
          } : null,
          loads: loadsWithStops.map(l => {
            const stops = l.full?.stops || [];
            const delivered = stops.filter(s => s?.stopExecutionInfo?.stopStatus === '90').length;
            const inProgress = stops.filter(s => ['30', '40'].includes(s?.stopExecutionInfo?.stopStatus)).length;
            const exceptions = stops.filter(s => s?.stopExecutionInfo?.stopStatus === '50' || s?.stopExecutionInfo?.exceptionPresent).length;
            const h = l.full?.loadHeader || {};
            return {
              loadNbr: l.loadNbr,
              route: l.route,
              driver: l.driver,
              totalStops: stops.length,
              delivered,
              inProgress,
              exceptions,
              pctComplete: stops.length ? Math.round((delivered / stops.length) * 100) : 0,
              vehicleType: h.vehicleType,
            };
          }),
          stops: allStops,
          summary: {
            loadsCount: matchedLoadNbrs.length,
            totalStops: allStops.length,
            delivered: allStops.filter(s => s.status === '90').length,
            inProgress: allStops.filter(s => s.status === '40').length,
            pending: allStops.filter(s => ['10', '30'].includes(s.status)).length,
            exceptions: allStops.filter(s => s.exceptionPresent === true).length,
          },
        }),
      };
    }

    // --- Refresh a single load: live-fetch from NuVizz, update Firestore, return fresh ---
    //   ?tenant=davis&path=__refreshLoad&loadNbr=DAVIS000192640
    // Used by LoadDetail/StopDetail screens to refresh just the load they're displaying.
    // Fast (~1s) because it's a single NuVizz call. Updates the Firestore doc as a side
    // effect so other tabs (Stops, Map, Drivers) see the freshness.
    if (apiPath === '__refreshLoad') {
      const loadNbr = params.loadNbr;
      const dateStr = params.date || new Date().toISOString().slice(0, 10);
      if (!loadNbr) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need loadNbr' }) };
      }
      const { companyCode } = getCreds(tenant);
      try {
        const full = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
        const h = full?.Load?.loadHeader || {};
        const a = full?.Load?.loadAssignment || {};
        const stops = full?.Load?.stops || [];

        // Build the slim load shape (same as scanFleet output)
        const delivered = stops.filter(s => s?.stopExecutionInfo?.stopStatus === '90').length;
        const inProgress = stops.filter(s => ['30', '40'].includes(s?.stopExecutionInfo?.stopStatus)).length;
        const exceptions = stops.filter(s => {
          const ei = s?.stopExecutionInfo;
          if (!ei) return false;
          return ei.exceptionPresent === true || (Array.isArray(ei.exceptions) && ei.exceptions.length > 0);
        }).length;

        const slimStops = stops.map(s => {
          const stop = s.stop || {};
          const exec = s.stopExecutionInfo || {};
          const toInfo = exec.to || {};
          const addr = stop.to?.address || {};
          return {
            stopNbr: stop.stopNbr,
            stopType: stop.stopType,
            status: exec.stopStatus,
            exceptionPresent: !!exec.exceptionPresent,
            exceptions: Array.isArray(exec.exceptions) ? exec.exceptions : [],
            name: addr.name,
            addr1: addr.addr1,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            latitude: addr.latitude,
            longitude: addr.longitude,
            bol: stop.bol,
            pallets: stop.totalPallets,
            cartons: stop.totalCartons,
            weight: stop.weight,
            plannedEta: toInfo.plannedEtaDTTM,
            etaDTTM: toInfo.etaDttm,
            arrivalDTTM: toInfo.arrivalDTTM,
            confirmedDTTM: toInfo.confirmedDTTM,
            etaCode: toInfo.etaCode,
            loadNbr: h.loadNbr,
            route: h.routeName,
            driver: a.driverName,
            driverUserName: a.driverUserName,
          };
        });

        const loadDoc = {
          loadNbr: h.loadNbr,
          loadId: h.loadId,
          route: h.routeName,
          startDate: (h.earliestStartDttm || '').slice(0, 10),
          driver: a.driverName,
          driverUserName: a.driverUserName,
          driverEmail: a.driverEmail,
          vehicleType: h.vehicleType,
          totalStops: stops.length,
          delivered,
          inProgress,
          exceptions,
          pctComplete: stops.length ? Math.round((delivered / stops.length) * 100) : 0,
          totalPallets: h.totalPallets,
          totalCartons: h.totalCartons,
          weight: h.weight,
          origin: {
            name: h.originName,
            addr1: h.originAddr1,
            city: h.originCity,
            state: h.originState,
            zip: h.originZip,
            latitude: h.originLatitude,
            longitude: h.originLongitude,
          },
          stops: slimStops,
        };

        // Persist the fresh load doc to Firestore (fire-and-forget)
        if (fs_db.isFirestoreEnabled()) {
          fs_db.writeLoad(tenant, dateStr, loadDoc).catch(() => null);
        }
        // Also invalidate the in-memory fleet cache so next __fleet read pulls from Firestore
        __fleetCache.delete(`${tenant}:${dateStr}`);
        __fleetCache.delete(`${tenant}:${dateStr}:stops`);

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ ok: true, load: loadDoc, refreshedAt: new Date().toISOString() }),
        };
      } catch (e) {
        return {
          statusCode: e.status || 500,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: e.message, loadNbr }),
        };
      }
    }

    // --- Refresh entire fleet: trigger a full scan, update Firestore, return summary ---
    //   ?tenant=davis&path=__refreshFleet
    // Used by the explicit "refresh fleet" button on Home. Returns immediately with a
    // freshness summary; client should re-fetch __fleet/__fleetstops afterward.
    if (apiPath === '__refreshFleet') {
      const dateStr = params.date || new Date().toISOString().slice(0, 10);
      const range = estimateLoadRange(dateStr);
      const loads = await scanFleet(tenant, {
        dateFrom: dateStr,
        dateTo: dateStr,
        startNbr: range.startNbr,
        endNbr: range.endNbr,
        concurrency: 50,
        includeStops: true,
      });
      calibrateLoadRange(dateStr, loads);

      const summary = {
        totalLoads: loads.length,
        assignedLoads: loads.filter(l => l.driver).length,
        unassignedLoads: loads.filter(l => !l.driver).length,
        totalStops: loads.reduce((sum, l) => sum + l.totalStops, 0),
        totalDelivered: loads.reduce((sum, l) => sum + l.delivered, 0),
        totalInProgress: loads.reduce((sum, l) => sum + l.inProgress, 0),
        totalExceptions: loads.reduce((sum, l) => sum + l.exceptions, 0),
        uniqueDrivers: new Set(loads.map(l => l.driverUserName).filter(Boolean)).size,
      };
      summary.pctComplete = summary.totalStops ? Math.round((summary.totalDelivered / summary.totalStops) * 100) : 0;

      // Persist + clear in-memory caches so all future reads pull fresh
      writeFleetToFirestore(tenant, dateStr, loads, summary).catch(() => null);
      __fleetCache.delete(`${tenant}:${dateStr}`);
      __fleetCache.delete(`${tenant}:${dateStr}:stops`);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true, summary, refreshedAt: new Date().toISOString() }),
      };
    }

    // --- Stops-away from a reference stop on a known load ---
    //   ?tenant=davis&path=__stopsaway&loadNbr=X&stopNbr=Y
    if (apiPath === '__stopsaway') {
      const loadNbr = params.loadNbr;
      const stopNbr = normalizePro(params.stopNbr);
      if (!loadNbr || !stopNbr) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need loadNbr and stopNbr' }) };
      }
      const { companyCode } = getCreds(tenant);
      const load = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
      const stops = load?.Load?.stops || [];
      const idx = stops.findIndex(s => s?.stop?.stopNbr === stopNbr);
      if (idx < 0) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Stop not found on load', loadNbr, stopNbr }) };
      }
      const stopsAway = stops.slice(0, idx)
        .filter(s => (s?.stopExecutionInfo?.stopStatus || '') !== '90')
        .length;
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ loadNbr, stopNbr, stopsAway, totalStopsOnLoad: stops.length, position: idx + 1 }),
      };
    }

    // Passthrough
    const extraParams = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'tenant' && k !== 'path') extraParams[k] = v;
    }
    const data = await nvFetch(tenant, apiPath, {
      method: event.httpMethod,
      body: event.body ? JSON.parse(event.body) : null,
      extraParams,
    });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
  } catch (err) {
    return {
      statusCode: err.status || 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, detail: err.body }),
    };
  }
};
