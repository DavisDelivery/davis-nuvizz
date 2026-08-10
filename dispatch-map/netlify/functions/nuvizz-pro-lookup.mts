// nuvizz-pro-lookup.mts
//
// On-demand single-PRO lookup for the mobile "search past PROs" button. The
// client searches its saved 20-stop history locally first; only when a typed
// PRO isn't found there (and the dispatcher explicitly clicked the lookup) does
// it call this — so it's a deliberate, one-off NuVizz call, not background
// traffic. Business-name searches never reach here (handled fully client-side).
import { lookupStopByPro, getCreds } from './lib/nuvizz-scan.mts';
import { writeStopNotes } from './lib/firestore.mts';
import { setCallTrigger } from './lib/nuvizz-request.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  setCallTrigger('on-demand'); // dispatcher-initiated PRO lookup → attribute as on-demand
  const pro = new URL(req.url).searchParams.get('pro') || '';
  if (!pro.trim()) return new Response(JSON.stringify({ ok: false, reason: 'missing pro' }), { status: 400, headers: cors });
  try {
    const res = await lookupStopByPro(pro);

  // PERSIST THE NOTES WE JUST PAID FOR. This call already cost a /stop/info and
  // its answer carries the stop's CURRENT notes; folding them into the open card
  // and dropping them on close is why board notes stayed frozen at whatever the
  // one first-sight enrichment captured. Writing them back costs no extra NuVizz
  // call and repairs the stop for everyone, not just this tab.
  // Best-effort and note-fields-only: a failure here must never turn a good
  // lookup into an error, and nothing outside the note fields is touched (the
  // scan owns the rest of the doc).
  if (res?.ok && res.stop) {
    try {
      const at = new Date().toISOString();
      const day = String((res.stop as any).boardDate || (res.stop as any).scheduledDate || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        await writeStopNotes(getCreds().companyCode, day, String((res.stop as any).stopNbr || pro), res.stop, at);
      }
    } catch { /* notes write-back is never allowed to fail the lookup */ }
  }
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : 404, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'lookup failed' }), { status: 500, headers: cors });
  }
};
