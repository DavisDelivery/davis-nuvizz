// router-settings-core.js — WHAT A ROUTER SETTINGS SAVE SENDS: the rule, pure.
//
// The form (BacktestPanel.jsx RouterSettings) is filled when it OPENS, so a poll does not wipe typing.
// The server patches exactly the fields it is sent. So a save sends ONLY THE FIELDS THIS PERSON CHANGED
// since the form opened: an untouched field must never put back a value someone else saved in the
// meantime — the per-day $ cap above all (audit 2026-09-27). The capacity editor on the same screen
// keeps the same rule ("ONLY BOXES YOU TOUCHED are sent").

export const ROUTER_FIELDS = ['capRule', 'effort', 'maxRounds', 'maxUsd', 'costPerMile', 'costPerDriveHour', 'lbsBox', 'lbsTractor'];
// A rate left blank is "no rate"; a weight limit left blank goes back to the default (the engine's truck profile).
const BLANK_IS_NULL = new Set(['costPerMile', 'costPerDriveHour', 'lbsBox', 'lbsTractor']);
const text = (v) => String(v ?? '').trim();

/** The change to send: each field whose value differs from the one the form opened with, and nothing else. */
export function routerChange(opened, form) {
  const change = {};
  for (const k of ROUTER_FIELDS) {
    if (text(form?.[k]) === text(opened?.[k])) continue;
    change[k] = BLANK_IS_NULL.has(k) && text(form?.[k]) === '' ? null : form[k];
  }
  return change;
}
