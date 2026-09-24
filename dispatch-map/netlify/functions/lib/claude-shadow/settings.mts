// lib/claude-shadow/settings.mts — READING AND SAVING THE SHADOW'S CAPACITY SETTINGS.
//
// Reads  claude_shadow_settings/davis (the ratio), claude_shadow_caps (one document per cap),
//        claude_shadow_learned/davis__capacity (to see which ratio the numbers were built at).
// Writes only through store.mts, so only claude_shadow_*:
//        claude_shadow_caps/{driver|route}__{id}   set or deleted, one per cap a change names
//        claude_shadow_settings/davis              loosePerSkid + when + who, field-masked
//        claude_shadow_settings_log/{at}__{n}      one create-only row per accepted change
//        claude_shadow_learned/davis__capacity     rebuilt when the numbers are not at the saved ratio
//
// NEVER REPORT AN INTENT AS AN OUTCOME. Each cap in a save is reported separately — saved, failed,
// or unknown — and a write that throws is READ BACK before it is called failed: a timeout can land.
// The rebuild is judged from the stored model, not from "the ratio changed in this request", so a
// save after a failed rebuild tries again instead of reporting "no change".
import { getDoc, listDocs } from '../firestore.mts';
import { shadowSet, shadowPatch, shadowDelete, shadowCreate } from './store.mts';
import { SETTINGS_PATH, CAPACITY_PATH } from './learn-core.mts';
import { rebuildModel, loosePerSkidFrom } from './learn.mts';
import {
  validateSettingsChange, capDocPath, capsFromDocs, CAPS_COLLECTION, SETTINGS_LOG_COLLECTION, type CapChange,
} from './settings-core.mts';

export interface SettingsDeps {
  getDoc: (path: string) => Promise<any | null>;
  listDocs: (path: string, opts?: { mask?: string[] }) => Promise<any[]>;
  shadowSet: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowPatch: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowDelete: (path: string) => Promise<void>;
  shadowCreate: (path: string, data: Record<string, any>) => Promise<boolean>;
  rebuild: (settings?: any) => Promise<any>;
  now: () => Date;
}
const LIVE: SettingsDeps = {
  getDoc, listDocs, shadowSet, shadowPatch, shadowDelete, shadowCreate,
  rebuild: (settings?: any) => rebuildModel(undefined, settings),
  now: () => new Date(),
};

/** The settings as stored. `error` set means they could NOT be read — not that there are none. */
export async function readSettings(deps: SettingsDeps = LIVE) {
  try {
    const [settings, capDocs] = await Promise.all([deps.getDoc(SETTINGS_PATH), deps.listDocs(CAPS_COLLECTION)]);
    return { settings: settings || null, caps: capsFromDocs(capDocs), error: null as string | null };
  } catch (e: any) {
    return { settings: null, caps: null, error: String(e?.message || e) };
  }
}

type Outcome = 'saved' | 'failed' | 'unknown' | 'unchanged';

export async function saveSettings(change: any, by: string | null, deps: SettingsDeps = LIVE) {
  const v = validateSettingsChange(change);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors } };

  const before = await readSettings(deps);
  if (before.error) return { status: 502, body: { ok: false, error: `could not read the current settings, so nothing was saved: ${before.error}` } };

  const at = deps.now().toISOString();
  const results: { kind: string; name: string; cap: number | null; outcome: Outcome; error?: string }[] = [];
  const log: any[] = [];

  // Write, and when the write throws, READ IT BACK: the answer that timed out may have landed.
  const settle = async (write: () => Promise<any>, landed: () => Promise<boolean | null>): Promise<{ outcome: Outcome; error?: string }> => {
    try { await write(); return { outcome: 'saved' }; }
    catch (e: any) {
      const err = String(e?.message || e);
      const seen = await landed().catch(() => null);
      if (seen === true) return { outcome: 'saved' };
      if (seen === false) return { outcome: 'failed', error: err };
      return { outcome: 'unknown', error: `${err} — and the read-back failed too, so whether it landed is not known; reload to check` };
    }
  };

  for (const c of v.normalized.caps as CapChange[]) {
    const bucket = c.kind === 'driver' ? before.caps!.drivers : before.caps!.routes;
    const was = bucket[c.key]?.cap ?? null;
    if (c.cap === was) { results.push({ kind: c.kind, name: c.name, cap: c.cap, outcome: 'unchanged' }); continue; }
    const path = capDocPath(c.kind, c.key);
    const r = c.cap == null
      ? await settle(() => deps.shadowDelete(path), async () => (await deps.getDoc(path)) === null)
      : await settle(() => deps.shadowSet(path, { kind: c.kind, key: c.key, name: c.name, cap: c.cap, at, by }), async () => (await deps.getDoc(path))?.at === at);
    results.push({ kind: c.kind, name: c.name, cap: c.cap, ...r });
    if (r.outcome === 'saved') log.push({ at, by, kind: c.kind, key: c.key, name: c.name, before: was, after: c.cap });
  }

  let ratio: { outcome: Outcome; value: number | null; error?: string } | null = null;
  if ('loosePerSkid' in v.normalized) {
    const value = v.normalized.loosePerSkid ?? null;
    const was = before.settings?.loosePerSkid ?? null;
    if (value === was) ratio = { outcome: 'unchanged', value };
    else {
      const r = await settle(
        () => deps.shadowPatch(SETTINGS_PATH, { loosePerSkid: value, loosePerSkidAt: at, loosePerSkidBy: by }),
        async () => (await deps.getDoc(SETTINGS_PATH))?.loosePerSkidAt === at,
      );
      ratio = { value, ...r };
      if (r.outcome === 'saved') log.push({ at, by, kind: 'ratio', key: 'loosePerSkid', name: 'loose pieces per skid spot', before: was, after: value });
    }
  }

  // The record of who changed what. Create-only, one row per change; a failure here is reported,
  // and does not undo a save that landed.
  let logError: string | null = null;
  for (let i = 0; i < log.length; i++) {
    try { await deps.shadowCreate(`${SETTINGS_LOG_COLLECTION}/${at}__${i}`, log[i]); }
    catch (e: any) { logError = `the change log was not fully written: ${String(e?.message || e)}`; }
  }

  // ARE THE NUMBERS AT THE SAVED RATIO? Judged from what is stored, so a save after a failed
  // rebuild retries it rather than reporting nothing to do.
  let rebuilt = false, rebuildError: string | null = null;
  try {
    const [settingsNow, model] = await Promise.all([deps.getDoc(SETTINGS_PATH), deps.getDoc(CAPACITY_PATH)]);
    if (model && loosePerSkidFrom(settingsNow).value !== model.loosePerSkid) { await deps.rebuild(settingsNow); rebuilt = true; }
  } catch (e: any) {
    rebuildError = `the learned numbers are not at the saved ratio yet: ${String(e?.message || e)} — Learn now or tonight's run rebuilds them`;
  }

  const allSaved = results.every((r) => r.outcome === 'saved' || r.outcome === 'unchanged') && (!ratio || ratio.outcome === 'saved' || ratio.outcome === 'unchanged');
  return { status: allSaved ? 200 : 502, body: { ok: allSaved, at, results, ratio, rebuilt, rebuildError, logError } };
}
