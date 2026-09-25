// lib/google-maps-loader.js — THE ONE WAY THE CLAUDE SHADOW SCREEN MAY LOAD GOOGLE MAPS.
//
// Chad, 2026-09-25, asked for "an interactive map to see Claude's vs my own dispatch" and, offered
// a plain drawn map or real streets, chose "Google streets". The shadow screen's isolation guard
// (scripts/check-shadow-isolation.mjs, rule 5) lets that screen load nothing from outside the app —
// so this file is the single, reviewed exception: it is the only module the shadow screen may
// import that loads a third-party script, the only one that may import @googlemaps/js-api-loader,
// and the guard pins its text by hash so any change to it is a change someone re-reads.
//
// It loads exactly what the dispatch map already loads: the same key, the same version, so the
// @googlemaps loader's one-instance rule is satisfied whichever screen asks first.
import { Loader } from '@googlemaps/js-api-loader';

const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
let pending = null;

/** Resolves to the google namespace. A failed load is not cached, so a retry can succeed. */
export function loadGoogleMaps() {
  if (!KEY) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'));
  if (!pending) {
    pending = new Loader({ apiKey: KEY, version: 'weekly' }).load().catch((e) => { pending = null; throw e; });
  }
  return pending;
}
