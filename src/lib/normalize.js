// src/lib/normalize.js — translate raw nuVizz API shapes into UI-friendly shapes

// --- status buckets ---
// NuVizz uses numeric stop/load status codes:
//   10=Created, 30=Scheduled, 40=In Transit / Out for Delivery / Arrived, 50=Exception, 90=Delivered/Complete
// Glory Bound (Firestore) and older shapes use English strings. Handle both.
export function statusBucket(status) {
  if (status == null) return 'pending';
  const raw = status.toString().trim();

  // Numeric NuVizz codes first (most common path in Davis/Uline tenants)
  if (raw === '90') return 'completed';
  if (raw === '40') return 'inProgress';
  if (raw === '50') return 'failed';
  if (raw === '10' || raw === '30') return 'pending';

  // Fall back to string matching (Glory Bound tenant, older data, etc.)
  const s = raw.toUpperCase();
  if (s.includes('COMPLET') || s.includes('CLOSED') || s.includes('DELIV')) return 'completed';
  if (s.includes('PROGRESS') || s.includes('DISPATCH') || s.includes('ENROUTE') || s.includes('ARRIVED') || s.includes('TRANSIT')) return 'inProgress';
  if (s.includes('FAIL') || s.includes('EXCEPT')) return 'failed';
  if (s.includes('CANCEL')) return 'cancelled';
  return 'pending';
}

export const BUCKET_COLORS = {
  completed: '#10b981',
  inProgress: '#f59e0b',
  pending: '#64748b',
  failed: '#ef4444',
  cancelled: '#dc2626',
};

export const BUCKET_LABELS = {
  completed: 'Delivered',
  inProgress: 'En Route',
  pending: 'Pending',
  failed: 'Exception',
  cancelled: 'Cancelled',
};

// --- normalize a stop from the customer-search / today-aggregate response ---
// The nuVizz Stop schema has `stop.from` (pickup) and `stop.to` (delivery); stopType tells us which matters.
export function normalizeStop(raw) {
  // Idempotent: if the object is already normalized (has bucket/fullAddress), pass through.
  // This lets pre-normalized data from the Firestore-backed dispatch source flow through
  // the same rendering path as raw NuVizz payloads.
  if (raw && typeof raw.bucket === 'string' && 'fullAddress' in raw) {
    return raw;
  }

  // Raw might come as { stop, stopExecutionInfo, load } OR flat with these merged.
  // The Stop response from /stop/info/customer/... is likely flat; /stop/info/{nbr}/... is wrapped in { Stop: { stop, ... } }
  const stop = raw.stop || raw;
  const exec = raw.stopExecutionInfo || raw.execInfo || {};
  const load = raw.load || raw.stopLoad || {};

  // Determine PU vs DO - and use the right side's address
  const stopType = stop.stopType || raw.stopType || '';
  const primary = stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
  const addr = primary.address || stop.address || {};
  const schedule = primary.schedule || {};
  const contact = primary.contact || {};
  const optInfo = primary.stopOptInfo || {};

  const fromTS = exec.from || {};
  const toTS = exec.to || {};
  const ts = stopType === 'PU' ? fromTS : toTS;

  const status = exec.stopStatus || stop.status || raw.status || 'PENDING';

  // NuVizz quirk: stopStatus=50 doesn't always mean "exception."
  // When exceptions[] is empty AND exceptionPresent is false, the driver just
  // didn't tap "Complete Delivery" — it's a paperwork issue, not a real problem.
  // Bucket those as 'pending' (or 'inProgress' if they at least arrived) so they
  // don't show up in the dispatcher's Issues count.
  let bucket = statusBucket(status);
  const realExceptions = exec.exceptions || [];
  const realExceptionPresent = !!exec.exceptionPresent;
  const hasArrival = !!toTS.arrivalDTTM || !!fromTS.arrivalDTTM;
  if (status === '50' && !realExceptionPresent && realExceptions.length === 0) {
    // Status code is exception but there's no actual exception data.
    // Reclassify based on what the driver actually did:
    if (hasArrival) {
      bucket = 'inProgress'; // arrived but didn't close out → still active
    } else {
      bucket = 'pending';
    }
  }

  return {
    id: stop.stopId || raw.stopId,
    nbr: stop.stopNbr || raw.stopNbr,
    seq: stop.stopSeq || raw.stopSeq,
    type: stopType,
    status,
    bucket,

    // location (from address)
    name: addr.name || stop.custInfo?.custName || '',
    addr1: addr.addr1,
    addr2: addr.addr2,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    lat: addr.latitude,
    lng: addr.longitude,
    fullAddress: [addr.addr1, addr.city, addr.state, addr.zip].filter(Boolean).join(', '),

    // contact
    contactName: contact.contactName,
    phone: contact.phone,

    // schedule (planned window)
    plannedFrom: schedule.timeFrom,
    plannedTo: schedule.timeTo,
    estimatedDuration: schedule.estimatedDuration,

    // timestamps (actuals)
    plannedEta: ts.plannedEtaDTTM || optInfo.plannedEta,
    actualEta: ts.etaDttm,
    arrival: ts.arrivalDTTM,
    departure: ts.departureDTTM,
    confirmed: ts.confirmedDTTM,
    dwellMin: ts.duration,
    etaCode: ts.etaCode,

    // references
    txnRef: primary.txnRef || stop.proNumber,
    proNumber: stop.proNumber,
    sealNbr: stop.sealNbr,
    shipmentNbr: stop.shipmentNbr,

    // counts
    cartons: stop.totalCartons,
    pallets: stop.totalPallets,
    weight: stop.weight,
    weightUOM: stop.weightUOM,

    // customer
    customerName: stop.custInfo?.custName || raw.custInfo?.custName,
    customerAcct: stop.accountNumber || stop.custInfo?.custAccNbr,

    // load assoc
    loadNbr: load.loadNbr || raw.loadNbr,
    loadId: load.loadId,
    driverName: load.driverName,
    driverPhone: load.driverPhoneNum,
    vehicleNbr: load.vehicleNbr,

    // exceptions
    exceptions: exec.exceptions || [],
    hasException: !!exec.exceptionPresent,
    cancellation: exec.cancellation,
    rejection: exec.rejection,

    // raw for debugging
    _raw: raw,
  };
}

// --- normalize a load (from /load/info/...) ---
export function normalizeLoad(raw) {
  // Idempotent: if already normalized (has pctComplete + stops array of normalized stops), pass through.
  if (raw && typeof raw.pctComplete === 'number' && Array.isArray(raw.stops)) {
    return raw;
  }

  const l = raw?.Load || raw;
  const h = l.loadHeader || {};
  const exec = l.loadExecutionInfo || {};
  const asn = l.loadAssignment || {};
  const stops = (l.stops || []).map(normalizeStop);

  // Put the stops in route order and number them the way nuVizz sequences them.
  // NuVizz leaves stop.stopSeq = 1 on every stop, so it's useless for ordering. The
  // optimized route order is encoded in the planned ETA: earlier ETA = earlier on the
  // route. Sort ascending by plannedEta (stops without an ETA fall to the end), then stamp
  // a 1-based `routeSeq` for the UI. This mirrors the server-side __fleetstops/driver-day
  // ordering and the MapScreen route lines.
  stops.sort((a, b) => {
    const ae = a.plannedEta || '';
    const be = b.plannedEta || '';
    if (ae && be) return ae.localeCompare(be);
    if (ae) return -1;
    if (be) return 1;
    return 0;
  });
  stops.forEach((s, i) => { s.routeSeq = i + 1; });

  const completed = stops.filter(s => s.bucket === 'completed').length;
  const inProgress = stops.filter(s => s.bucket === 'inProgress').length;
  const total = stops.length;

  // Derive the load-level status from its stops. NuVizz keeps loadStatus at PLANNED/Pending
  // even after the driver has delivered stops, which made loads read "Pending" while they
  // were clearly underway. Trust the stop progress instead: all stops delivered => complete;
  // any stop delivered or active => the load is running; otherwise fall back to loadStatus.
  let bucket = statusBucket(exec.loadStatus);
  if (total > 0) {
    if (completed === total) bucket = 'completed';
    else if (completed > 0 || inProgress > 0) bucket = 'inProgress';
  }

  return {
    nbr: h.loadNbr,
    id: h.loadId,
    routeName: h.routeName,
    status: exec.loadStatus || 'PLANNED',
    bucket,
    driverName: asn.driverName,
    driverPhone: asn.driverPhoneNumber,
    driverEmail: asn.driverEmail,
    vehicleType: h.vehicleType,
    tractorNbr: h.tractorNbr,
    trailerNbr: h.trailerNbr,

    // timing
    earliestStart: h.earliestStartDttm,
    latestStart: h.latestStartDttm,
    actualStart: exec.actualStartDTTM,
    actualEnd: exec.actualEndDTTM,

    // distance
    plannedMiles: h.prePlannedLoadDistance || exec.plannedDistanceMiles,
    actualMiles: exec.actualDistanceMiles,
    plannedDuration: exec.plannedDuration || h.prePlannedLoadDuration,
    actualDuration: exec.actualDuration,

    // origin
    origin: {
      name: h.originName,
      addr1: h.originAddr1,
      city: h.originCity,
      state: h.originState,
      zip: h.originZip,
      lat: h.originLatitude,
      lng: h.originLongitude,
    },

    // counts
    stopsOnRoute: exec.stopsOnRoute || stops.length,
    completed,
    total,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,

    totalCartons: h.totalCartons,
    totalPallets: h.totalPallets,
    weight: h.weight,
    weightUOM: h.weightUOM,

    stops,
    _raw: raw,
  };
}

// --- time helpers ---
export function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}
export function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
  catch { return iso; }
}
export function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 60000);
}
export function stripLeadingZeros(s) {
  return (s || '').toString().replace(/^0+/, '') || '0';
}
