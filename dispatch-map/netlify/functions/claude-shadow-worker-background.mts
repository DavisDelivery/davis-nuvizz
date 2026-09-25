// claude-shadow-worker-background.mts — THE CLAUDE ROUTER'S WORKER: runs queued backtests, a few rounds a tick.
//
// Every three minutes. A tick with nothing queued reads one small collection and exits. A tick with
// a job takes the OLDEST unfinished one and advances it: it builds the day once (stored, so a
// resumed run shows Claude the same day), then runs model rounds while there is time to finish one
// (a round is only started in the first four minutes of the fifteen a background function gets),
// checkpointing every round. The next tick carries on; a run of eight rounds spans a few ticks.
//
// WHY A SCHEDULE AND NOT A BUTTON THAT CALLS THIS DIRECTLY: a shadow background function cannot be
// auth-gated (the repo's gate writes outside claude_shadow_*, which the isolation guard and the
// egress lock both refuse), and an ungated function anyone can POST is a way to spend the API key.
// So the Shadow tab QUEUES work through its own gated endpoint, and only this schedule runs it.
//
// Refuses — and runs nothing — when CLAUDE_SHADOW is off, the API key is missing, Firestore is not
// usable, or the site reads a mirror database (UAT copies production's key; it must not spend it).
// ZERO NuVizz calls. The only host it reaches besides Firestore is api.anthropic.com.
import { lockEgress } from './lib/claude-shadow/egress.mts';
import { workerTick } from './lib/claude-shadow/backtest.mts';

export default async (): Promise<Response> => {
  lockEgress();
  const out = await workerTick();
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '*/3 * * * *',
};
