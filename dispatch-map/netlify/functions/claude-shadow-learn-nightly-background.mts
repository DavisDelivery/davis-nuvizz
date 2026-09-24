// claude-shadow-learn-nightly-background.mts — THE SHADOW LEARNS LAST NIGHT'S SEALED DAY.
//
// Scheduled at 08:30 UTC: 4:30 AM EDT / 3:30 AM EST. That is after the warehouse seals the
// previous day (nuvizz-history-snapshot-background, 06:00 UTC) and after the learned engine's own
// nightly run (07:30 UTC), so the day it reads is final. One UTC slot is enough here: the seal is
// the only thing it must follow, and a day that seals late is picked up the next night, because
// learning takes every sealed day not yet learned, not "yesterday".
//
// Same work as "Learn now" (POST {action:"learn"} on claude-shadow.mts, which runs it within a time
// budget); this run has no budget and finishes every day not yet learned. ZERO NuVizz and model calls.
// Refuses, and records why, when CLAUDE_SHADOW is off or the site reads a mirror database.
import { lockEgress } from './lib/claude-shadow/egress.mts';
import { runLearn } from './lib/claude-shadow/learn.mts';

export default async (): Promise<Response> => {
  lockEgress();
  const out = await runLearn({ trigger: 'nightly' });
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '30 8 * * *',
};
