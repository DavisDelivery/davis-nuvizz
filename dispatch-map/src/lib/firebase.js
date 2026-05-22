// Firebase init — reuses the davismarginiq project per project brief.
// Firestore only; auth removed in v0.3.0 to match Glory Bound Dispatch / MarginIQ
// pattern (no login). The Firestore rule for customer_notes is open
// (`allow read, write: if true;`) so unauth'd writes from this client work.

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

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
export const db = app ? getFirestore(app) : null;
