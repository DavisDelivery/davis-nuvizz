// netlify/functions/routing-build-background.mts
//
// Async build-job orchestration (Section 5/6). BACKGROUND function: the model +
// Google calls plus the solve/repair can exceed the 26s request cap, so the work
// runs here and the client polls the routing_jobs/{jobId} doc it created.
//
// Flow: client writes routing_jobs/{jobId} { status:'queued', request } and POSTs
// { jobId } here → we mark running, resolve the selected stops (live cache, READ-only)
// + their equipment restrictions (customer_notes) + the chosen truck profiles, run
// the five-stage pipeline with real deps (Google matrix + Opus, each gated by its
// key), and write { status:'done', result } or { status:'error', error }.
//
// GUARDRAILS: NuVizz is never written. We only READ nuvizz_stop_index and
// customer_notes. Nothing here touches the refresh functions or Phase 1 history.

import { isFirestoreEnabled, readStops } from './lib/firestore.mts';
import { getJob, updateJob, isRoutingJobId } from './lib/routing-store.mts';
import { profileToSolverTruck, getTruckProfile, type TruckProfile } from './lib/truck-profiles.mts';
import { runPipeline, type PipelineRequest, type PipelineStopInput } from './lib/routing-pipeline.mts';
import { resolveMatrix } from './google-route-matrix.mts';
import { isAnthropicEnabled, parseIntentModel, geometryAssistModel, explainModel } from './anthropic-routing.mts';
import { DEPOT, type SolverTruck } from './lib/routing-types.mts';
import { getDoc } from './lib/firestore.mts';
import { normalizeMatchKey } from '../../src/lib/matchKey.js';
import { stopTimeRestriction, boardDefaultSlots, timeRestrictionsEnabled } from './lib/routing-time-windows.mts';
import { withDeadline } from './lib/async-util.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
// The truck/stop rule is shared with step 4's "Fill my loads" (routing-cleanup-core) — one rule,
// two builders, so the same stop cannot ride a tractor from one button and a box from the other.
import { equipmentReqsFrom } from './lib/routing-equipment.mts';
import { hydrateRoutingSwitches, inRoutingSwitchRequest } from './lib/routing-switches-store.mts';
import { buildRules, buildFreightFields, trucksWithRoomLeft, withExistingFreight, type BuildRules } from './lib/routing-build-rules.mts';

// Overall job deadline (belt-and-suspenders with the per-call 8s timeouts). A
// normal deterministic build finishes in well under a second; this only fires if
// something pathological stalls the pipeline.
const BUILD_DEADLINE_MS = 25000;
// When AI assist is ON, hard-cap the number of per-stop geometry model calls so it
// can never become an unbounded sequential loop. Off by default → never runs.
const GEO_ASSIST_CAP = 10;

// ONE read of the customer note per stop. The equipment rule and the clock rule
// (routing-time-windows) both read it; neither reads the other's fields.
async function readNoteFor(stop: any): Promise<any | null> {
  try {
    const key = normalizeMatchKey(stop.businessName, stop.addr1, stop.city, stop.zip);
    return (await getDoc(`customer_notes/${key}`)) || null;
  } catch { return null; }
}

// Resolve the pipeline's stop inputs from selectedStopIds against the live cache. Returns the
// board too: the room-left rule counts a load's existing stops off the same rows.
async function resolveStops(
  tenant: string, date: string, selectedStopIds: string[],
  opts: { tractorOnlyGreen?: boolean; panelGreen?: Set<string>; rules: BuildRules },
): Promise<{ stops: PipelineStopInput[]; boardById: Map<string, any>; notPlaced: Array<{ stopId: string; reasons: string[] }> }> {
  const { stops } = await readStops(tenant, date);
  // The routing switches set on Diagnostics (src/lib/routing-switches.js), before any is read.
  await hydrateRoutingSwitches();
  // TIME RESTRICTIONS (routing-time-windows.mts) — on unless ROUTING_TIME_RESTRICTIONS=off.
  // The vendor's default creation slot is detected over the WHOLE board, never the
  // selection: 21 unrelated customers on one 09:00–09:30 stamp is the tell, and a
  // five-stop selection could never see it.
  const timeOn = timeRestrictionsEnabled();
  const defaultSlots = timeOn ? boardDefaultSlots(stops) : null;
  const byId = new Map(stops.map((s: any) => [String(s.stopNbr), s]));
  const want = new Set(selectedStopIds.map(String));
  const out: PipelineStopInput[] = [];
  // A selected stop the solver can never see is LISTED, not dropped: it used to vanish from the
  // result entirely — not routed, not on the "Could not place" list — so a dispatcher who picked
  // 40 stops and saw 37 routed had no way to know which 3 were missing, or why.
  const notPlaced: Array<{ stopId: string; reasons: string[] }> = [];
  for (const id of want) {
    const s = byId.get(id);
    if (!s) { notPlaced.push({ stopId: id, reasons: [`not on the ${date} board (moved, delivered or taken off since the list was made)`] }); continue; }
    if (s.lat == null || s.lng == null) { notPlaced.push({ stopId: id, reasons: ['no map pin — the address has not been located, so it cannot be routed'] }); continue; }
    const note = await readNoteFor(s);
    out.push({
      stopNbr: s.stopNbr, lat: Number(s.lat), lng: Number(s.lng),
      // pallets, weight, line items — and the real skid count (cartons) unless
      // ROUTING_BUILD_COUNT_SKIDS=off (lib/routing-build-rules.mts).
      ...buildFreightFields(s, opts.rules),
      signalSources: s.signalSources || null, addr2: s.addr2 || null,
      scheduledFrom: s.scheduledFrom || null, scheduledTo: s.scheduledTo || null,
      timeConstraint: s.timeConstraint || null,
      // "Only green on a 53′" reads the panel's green when the browser sent it
      // (ROUTING_BUILD_GREEN_MATCHES_PANEL); restrictions and red marks apply regardless.
      equipmentReqs: equipmentReqsFrom(note, { tractorOnlyGreen: opts.tractorOnlyGreen, panelGreen: !!opts.panelGreen?.has(String(s.stopNbr)) }),
      // "Whether or not it's a tractor friendly stop": the clock rule never reads an
      // eligibility mark (pinned by test), so a green stop and a red stop with the same
      // hours get the same window.
      timeRestriction: timeOn ? stopTimeRestriction({ stop: s, note, date, defaultSlots }) : null,
      businessName: s.businessName || null,
    });
  }
  return { stops: out, boardById: byId as Map<string, any>, notPlaced };
}

async function resolveTrucks(profileIds: string[]): Promise<SolverTruck[]> {
  const trucks: SolverTruck[] = [];
  for (const id of profileIds) {
    const p = (await getTruckProfile(id)) as TruckProfile | null;
    if (p) trucks.push(profileToSolverTruck(p));
  }
  return trucks;
}

// One read of the routing switches for the whole build (lib/routing-switches-store.mts): a build
// never uses one position of a switch in one place and another in the next.
export default function handler(req: Request): Promise<Response> {
  return inRoutingSwitchRequest(() => buildHandler(req));
}

async function buildHandler(req: Request): Promise<Response> {
  const json = (b: any, s = 202) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return json({ ok: false, error: 'FIREBASE_SA not set' }, 200);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const jobId = body?.jobId;
  if (!jobId) return json({ ok: false, error: 'jobId required' }, 400);
  if (!isRoutingJobId(jobId)) return json({ ok: false, error: 'bad jobId' }, 400);

  const job = await getJob(jobId);
  if (!job) return json({ ok: false, error: 'job not found' }, 404);

  // GATED AT dispatcher, AFTER the job doc is known to exist and BEFORE any stop read,
  // Google matrix call or Anthropic call — so a refusal costs nothing and still has a doc to
  // land in. Netlify already answered this caller 202 and discarded our status
  // (lib/background-gate.mts), so the refusal is written onto routing_jobs/{jobId} as a
  // terminal 'error'. That is exactly where the client is looking: App.jsx opens an
  // onSnapshot on this doc the moment it fires the build and renders job.error, so a refused
  // build says "not signed in" instead of spinning on 'queued' for ever.
  const gate = await requireUserForBackground(req, 'routing-build-background', {
    role: 'dispatcher',
    record: async (refusal) => {
      await updateJob(jobId, { status: 'error', error: refusal.message, finished_at: refusal.at });
    },
  });
  if (!gate.ok) return gate.response;

  // P0 FIX: AWAIT the work to completion. This is a *-background function — the
  // platform already returned 202 to the client; the handler is allowed to run
  // for minutes. Previously the work ran in an un-awaited IIFE and the handler
  // returned immediately, so the runtime could freeze/recycle the instance before
  // the job was written → status stuck at 'running' forever (the hang). Now every
  // path ends at 'done' or 'error'.
  try {
    await updateJob(jobId, { status: 'running', stage: 'resolve', started_at: new Date().toISOString() });
    const r = job.request || {};
    const tenant = r.tenant || 'davis';
    const date = r.date;
    const tractorOnlyGreen = r.tractorOnlyGreen === true;
    // Eligibility rules (box_only / green override / tractorOnlyGreen) are applied in
    // equipmentReqsFor, which runs via resolveStops. The direct r.stops path is a caching
    // shortcut the client does not currently use (it always sends selectedStopIds); a
    // future caller that pre-resolves r.stops must bake the eligibility reqs in itself,
    // since this path bypasses equipmentReqsFor.
    // THE BUILD'S CAPACITY AND GREEN RULES (lib/routing-build-rules.mts), each its own switch.
    const rules = buildRules();
    const panelGreen = rules.greenMatchesPanel && Array.isArray(r.panelGreenStopIds)
      ? new Set<string>(r.panelGreenStopIds.slice(0, 2000).map((x: any) => String(x))) : undefined;
    let boardById = new Map<string, any>();
    let stops: PipelineStopInput[];
    let notPlaced: Array<{ stopId: string; reasons: string[] }> = [];
    if (Array.isArray(r.stops) && r.stops.length) stops = r.stops;
    else ({ stops, boardById, notPlaced } = await resolveStops(tenant, date, r.selectedStopIds || [], { tractorOnlyGreen, panelGreen, rules }));
    let trucks = Array.isArray(r.trucks) && r.trucks.length ? r.trucks : await resolveTrucks(r.truckProfileIds || []);
    // A picked load that already carries stops is offered only the room it has LEFT.
    let existing: Record<string, any> = {};
    if (rules.countsExisting && Array.isArray(r.trucks) && r.trucks.length && r.existingByTruck && typeof r.existingByTruck === 'object') {
      ({ trucks, existing } = trucksWithRoomLeft(trucks, r.existingByTruck, boardById, rules, (r.selectedStopIds || []).map(String)));
    }

    if (!stops.length) { await updateJob(jobId, { status: 'error', error: notPlaced.length ? `no mappable stops selected (${notPlaced.length} not on the board or without a map pin)` : 'no mappable stops selected', finished_at: new Date().toISOString() }); return json({ ok: true, jobId, accepted: true }); }
    if (!trucks.length) { await updateJob(jobId, { status: 'error', error: 'no truck profiles selected', finished_at: new Date().toISOString() }); return json({ ok: true, jobId, accepted: true }); }

    await updateJob(jobId, { stage: 'build' });
    // Cheap by default (Appendix B): haversine unless the build explicitly opts
    // into 'google'. resolveMatrix honors the mode; absent → haversine.
    const matrixMode = r.matrixMode === 'google' ? 'google' : 'haversine';
    // Appointment windows are ADVISORY by default (flag, don't spill). Kill switch
    // back to strict via the request or an env (ROUTING_WINDOWS=strict).
    const windowMode = (r.windowMode === 'strict' || process.env.ROUTING_WINDOWS === 'strict') ? 'strict' : 'advisory';

    // P1 FIX: the Opus model is OPT-IN, default OFF — exactly parallel to the
    // Google matrix opt-in. The deps are passed ONLY when the build explicitly
    // asks for it AND the key exists; otherwise the pipeline runs its fully
    // deterministic paths (deterministic intent, deterministic geometry with NO
    // per-stop model calls, deterministic explanation). A default build makes
    // ZERO model calls.
    const aiOn = r.aiAssist === true && isAnthropicEnabled();
    // P3 FIX: even when on, hard-cap per-stop geometry model calls.
    let geoCalls = 0;
    const cappedGeometryAssist = aiOn
      ? async (stop: any) => { if (geoCalls >= GEO_ASSIST_CAP) return null; geoCalls++; return geometryAssistModel(stop); }
      : undefined;

    const pipelineReq: PipelineRequest = {
      stops, trucks,
      depot: r.depot || { lat: DEPOT.lat, lng: DEPOT.lng },
      intentText: r.intent || r.intentText || '',
      strategy: r.strategy || 'MIN_DISTANCE',
      objectiveWeights: r.objectiveWeights,
      date, departHHMM: r.departHHMM, serviceMin: r.serviceMin,
      matrixMode, windowMode,
      // Full trucks give up the end of their run, never a stop in the middle
      // (ROUTING_BUILD_LEAVE_OFF_ENDS, lib/routing-assign-ends.mts).
      leaveOffEnds: rules.leaveOffEnds,
      // A truck with room takes a whole group of the orders left off when it is worth the trip
      // (ROUTING_BUILD_FILL_TRUCKS, lib/routing-assign-ends.mts step 6).
      fillTrucks: rules.fillTrucks,
    };
    // P4 FIX: overall watchdog. If the pipeline somehow overruns, reject with a
    // clear, client-actionable message so the UI stops polling.
    const plan = await withDeadline(
      runPipeline(pipelineReq, {
        buildMatrix: async (depot, pts) => resolveMatrix(depot, pts, matrixMode),
        parseIntent: aiOn ? parseIntentModel : undefined,
        geometryAssist: cappedGeometryAssist,
        explain: aiOn ? explainModel : undefined,
      }),
      BUILD_DEADLINE_MS,
      'build timed out — try fewer stops',
    );

    await updateJob(jobId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      // aiRequested lets the result panel tell "never asked" apart from "asked, and the site
      // has no ANTHROPIC_API_KEY" — the second is a configuration problem, and it used to read
      // as the same "off".
      result: {
        // A load that already carried freight reports its true load against its whole profile.
        ...withExistingFreight({ ...plan, unassigned: [...(plan.unassigned || []), ...notPlaced] }, existing, trucks), aiConfigured: aiOn, aiRequested: r.aiAssist === true,
        // Which of the Build's rules ran, read back from the build itself — never from the switch
        // settings in someone's memory — and what each load already carried.
        buildRules: { ...rules, panelGreenStops: panelGreen ? panelGreen.size : null, existing },
      },
    });
  } catch (e: any) {
    console.error('routing-build:', e?.message);
    await updateJob(jobId, { status: 'error', error: e?.message || 'build failed', finished_at: new Date().toISOString() });
  }

  return json({ ok: true, jobId, accepted: true });
}
