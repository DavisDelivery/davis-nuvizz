// Firebase init — reuses the davismarginiq project per project brief.
// Firestore only; auth removed in v0.3.0 to match Glory Bound Dispatch / MarginIQ
// pattern (no login). The Firestore rule for customer_notes is open
// (`allow read, write: if true;`) so unauth'd writes from this client work.

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { mirrorMisconfigured, MIRROR_MISCONFIGURED_MESSAGE } from './mirror-site.js';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = !!(cfg.apiKey && cfg.projectId);

export const app = firebaseConfigured ? initializeApp(cfg) : null;
// VITE_FIRESTORE_DATABASE selects a NAMED Firestore database (the UAT prod-mirror
// sets uat-mirror so client-side writes — customer_notes etc. — never touch the
// production default database). Unset = the default database, unchanged.
const dbName = (import.meta.env.VITE_FIRESTORE_DATABASE || '').trim();

// A UAT BUILD THAT RESOLVES THE PRODUCTION DATABASE IS A MISCONFIGURATION, AND IT MUST FAIL
// LOUD. The server already refuses this (firestore.mts, uatMisconfigured); the browser did not,
// and the browser writes real things — customer notes, receiving hours, closed days, vehicle
// eligibility, truck profiles, board-date overrides. One missing build-time variable on the UAT
// site sent every one of those to the live board, and the app looked completely normal while it
// happened. Keyed on the HOSTNAME because that is the one fact about a deploy nobody can forget
// to set. See src/lib/mirror-site.js.
export const mirrorMisconfig = mirrorMisconfigured(
  typeof window === 'undefined' ? '' : window.location.hostname,
  dbName,
);
if (mirrorMisconfig) console.error('[firebase] ' + MIRROR_MISCONFIGURED_MESSAGE);

// `null` rather than a live handle: every caller already guards on `db` (Firestore is optional
// in this app), so refusing the handle turns a silent production write into a visible dead
// control, which is the safe direction and the one the operator can report.
export const db = (app && !mirrorMisconfig) ? (dbName ? getFirestore(app, dbName) : getFirestore(app)) : null;
