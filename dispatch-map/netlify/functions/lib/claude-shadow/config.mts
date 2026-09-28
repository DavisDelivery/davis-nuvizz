// lib/claude-shadow/config.mts — THE CLAUDE SHADOW PLANNER'S SWITCHES, IN ONE PLACE.
//
// The shadow planner is a comparison, not a dispatcher: Claude plans tomorrow's loads beside
// the router, the plan is stored under its own prefix, and nothing it produces is ever sent,
// saved or staged. Everything it owns in Firestore lives under SHADOW_PREFIX, and the write
// gateway (store.mts) refuses any path that does not.
//
// Two switches, both readable back from GET /.netlify/functions/claude-shadow so their
// position is never a guess:
//
//   CLAUDE_SHADOW        the kill switch. House shape (nearMatchEnabled, attEnabled): ON by
//                        default, an explicit off-word (off/0/false/no) turns it off, and
//                        anything malformed leaves it ON — a typo must never be the reason a
//                        feature went quiet, because a quiet feature looks like a working one.
//                        Off means ZERO model calls from every shadow job and button.
//   CLAUDE_SHADOW_MODEL  the model id. Default claude-opus-5-5. A value that is not shaped
//                        like a Claude model id falls back to the default rather than being
//                        sent to the API, and the source is reported so the fallback is seen.
//
// Deliberately NOT ANTHROPIC_MODEL: that one drives the Build job's intent/explain calls
// (anthropic-routing.mts), and moving the shadow's model must never move the router's.

export const SHADOW_PREFIX = 'claude_shadow_';
export const DEFAULT_SHADOW_MODEL = 'claude-opus-5-5';

const OFF_WORDS = ['off', '0', 'false', 'no'];

export function claudeShadowEnabled(env: Record<string, any> = process.env): boolean {
  const v = String(env?.CLAUDE_SHADOW ?? '').trim().toLowerCase();
  return !OFF_WORDS.includes(v);
}

export interface ModelChoice { model: string; source: 'env' | 'default'; rejected: string | null }

const MODEL_ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function shadowModel(env: Record<string, any> = process.env): ModelChoice {
  const raw = String(env?.CLAUDE_SHADOW_MODEL ?? '').trim();
  if (raw === '') return { model: DEFAULT_SHADOW_MODEL, source: 'default', rejected: null };
  if (MODEL_ID_RE.test(raw)) return { model: raw, source: 'env', rejected: null };
  return { model: DEFAULT_SHADOW_MODEL, source: 'default', rejected: raw };
}

export function anthropicKeyConfigured(env: Record<string, any> = process.env): boolean {
  return String(env?.ANTHROPIC_API_KEY ?? '').trim() !== '';
}

// HARD CAPS (v1.75.0). Chad, 2026-09-26: "i like hard caps on even the learned behavior and a ui to
// adjust them all against their learned behaviors." With this ON, a backtest holds a truck to its cap
// and its weight limit, full stop: a learned skid cap is held down to the class ceiling unless a
// person set that driver's or route's cap, and where dispatch loaded past a cap or a limit the load
// reads as OVER on dispatch's side instead of the cap quietly rising to meet it. OFF puts the old
// rule back (caps and limits raised to what dispatch loaded, no ceilings). House shape: default ON,
// an explicit off-word turns it off, anything else leaves it ON — a typo must never silently
// soften every cap.
export function hardCapsEnabled(env: Record<string, any> = process.env): boolean {
  const v = String(env?.SHADOW_HARD_CAPS ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

// THE BACKTEST'S ROOM CHECK (audit 2026-09-27, shadow-backend-5). A backtest may leave off only a
// no-tractor stop dispatch ran on a tractor — and the briefing tells Claude it may do so only when no
// box truck has ROOM for it, "and the evaluator refuses any other". The evaluator never checked the
// room, so a box-only stop could be dropped beside a half-empty box truck and its miles read as
// Claude's saving. With this ON the evaluator holds the backtest to the rule its briefing states (the
// same roomFor a plan uses). House shape: default ON, an explicit off-word turns it off (the drop is
// accepted with any reason again, as before), anything else leaves it ON.
export function btRoomCheckEnabled(env: Record<string, any> = process.env): boolean {
  const v = String(env?.SHADOW_BT_ROOM_CHECK ?? '').trim().toLowerCase();
  return !OFF_WORDS.includes(v);
}
