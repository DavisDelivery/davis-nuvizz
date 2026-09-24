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
