// src/lib/write-error.js — making a NuVizz write refusal READABLE (PURE).
//
// Chad, Sep 10 2026, on a ＋ New route that failed: "Route Creation still not working from
// our system go to devloper api from nuvizz and figure out what you are doing wrong."
//
// What the screen actually showed him was this, and nothing else:
//
//   ✗ Steven Adjenty: createRoute: Internal Server Error: {"reasons":[{"description":
//   "<DeliverItLoadResponse xmlns=\"http://schemas.nuvizzards.com/schemas/di/
//   response\">\n<DocumentID>UNKNOWN</DocumentID>\n<Status
//   >99</Status>\n<Errors class=\"java.util.ArrayList\">
//
// Every character of that is envelope. NuVizz's own account of what it objected to is in the
// <Errors> list, which is the NEXT thing in the string — and it never arrived, because
// firstError() cut the message at 300 characters (fixed in the same change as this file).
// Even untruncated it would have been three layers of wrapping around one sentence: an HTTP
// envelope, around a JSON `reasons` array, around a JSON-escaped XML document.
//
// THE LOGISTICS TEST THIS FILE HAS TO PASS. A dispatcher at 6am with a truck waiting is not
// going to read a java.util.ArrayList. They need one line telling them whether this is theirs
// to fix (a bad address, an order already on another load) or ours. So: lead with the
// vendor's own words, keep the envelope for the write log, and NEVER silently drop text —
// a clip that doesn't say it clipped is what cost the whole of Sep 9.
//
// PURE and framework-free so it can be tested directly; the screen only renders what it returns.

/** Vendor text arrives double-encoded: the XML was JSON-escaped, and (on this tenant) the
 *  escapes survive into the string we display. Turn \\uXXXX / \\n / \\t / \\" back into
 *  characters so the XML can be read at all. Never throws; a value that isn't a string
 *  comes back as ''. */
export function decodeVendorText(raw) {
  let s = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  if (!s) return '';
  // \uXXXX first — it is what hides the angle brackets, and decoding it can reveal \n.
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : m;
  });
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unentity = (s) => String(s).replace(/&(?:lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] || m);

/** Every non-empty leaf text node inside `xml`, in document order. Deliberately tolerant:
 *  this repo has never seen the inside of a NuVizz <Errors> list, and the element names are
 *  not in the shipped OpenAPI document (grep: it does not mention DeliverItLoadResponse at
 *  all). So we do not guess at <Error>/<Message>/<Description> — we take whatever text the
 *  list actually contains. Guessing a tag name would silently show nothing on the day it
 *  matters, which is the failure mode this whole file exists to end. */
function leafTexts(xml) {
  const out = [];
  const re = /<([A-Za-z_][\w.:-]*)\b[^>]*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = unentity(m[2]).trim();
    if (text) out.push({ tag: m[1], text });
  }
  return out;
}

/**
 * PURE. Pull the readable complaint out of a NuVizz rejection, however it is wrapped.
 * Returns null when there is nothing vendor-shaped to find — the caller then shows the
 * original text unchanged rather than an empty box.
 *
 * { documentId, status, errors: string[], headline } where `headline` is the one line worth
 * putting in front of a dispatcher. `errors` is every text node inside the <Errors> list.
 */
export function summarizeVendorError(raw) {
  const text = decodeVendorText(raw);
  if (!text || !/<\s*DeliverIt\w*Response/i.test(text)) return null;
  const tagText = (name) => {
    const m = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, 'i').exec(text);
    return m ? unentity(m[1]).trim() : null;
  };
  const documentId = tagText('DocumentID');
  const status = tagText('Status');
  // Everything from <Errors …> to its close (or to the end, if the text was cut short).
  const block = /<Errors\b[^>]*>([\s\S]*?)(?:<\/Errors>|$)/i.exec(text);
  const errors = block
    ? leafTexts(block[1]).map((n) => (/^(?:message|description|errorLiteral|msg|reason|text)$/i.test(n.tag) ? n.text : `${n.tag}: ${n.text}`))
    : [];
  // De-dupe: a Java error list often repeats the same sentence per offending element, and
  // fourteen identical lines is not fourteen problems.
  const unique = [...new Set(errors)];
  const headline = unique.length
    ? unique.slice(0, 3).join(' · ') + (unique.length > 3 ? ` (+${unique.length - 3} more)` : '')
    : (block
      // The list was there and we could read nothing out of it — say exactly that, because
      // "no errors" and "errors we could not parse" are opposite instructions to the reader.
      ? `NuVizz rejected it and its error list could not be read${status ? ` (Status ${status})` : ''} — the full text is in the write log`
      : null);
  if (!headline) return null;
  return { documentId, status, errors: unique, headline };
}

/** The maximum a toast should carry. Long enough for a real vendor sentence, short enough
 *  to read on a phone at the dock. */
export const TOAST_MAX = 400;

/**
 * PURE. What to actually show: the vendor's own complaint when we can find it, else the raw
 * text — clipped, and SAYING SO when it clips, with where the rest lives.
 *
 * The marker is the load-bearing part. The Sep 9/10 error looked complete on screen; nothing
 * indicated 300 characters had been cut, so the missing half was never looked for.
 */
export function clipForToast(raw, max = TOAST_MAX, { plain = PLAIN_ERRORS_ON } = {}) {
  const original = raw == null ? '' : String(raw);
  if (plain) {
    const said = plainWriteError(original, { on: true });
    if (said.length <= max) return said;
    return `${said.slice(0, max)}… (cut short — the full message is in the write log)`;
  }
  const summary = summarizeVendorError(original);
  const shown = summary ? `NuVizz refused it — ${summary.headline}` : original;
  if (shown.length <= max) return shown;
  return `${shown.slice(0, max)}… [cut — full text in the write log: nuvizz-write-log?op=newRoute&status=failed]`;
}

// ── PLAIN SENTENCES (v1.98.7) ───────────────────────────────────────────────
//
// Chad, 2026-09-30: "Can you make it simple sentence when there is an error that looks less like
// code". What reached the screen was the server's own diagnostic: a "commitBoard(rwb):" prefix,
// load numbers in brackets, and words like "declarative RWB save", "partialUpdate" and
// "fetchUpdatedJson". The full text still lands in the write log for whoever debugs it; the
// dispatcher gets what happened and what to do next.
//
// EVERY RULE IS A REAL MESSAGE. Each one was written from a failed write in the write log
// (September 2026: 104 failed writes, zero NuVizz calls to read), and the tests carry those
// messages word for word. A message no rule knows keeps its own words with only the code-looking
// prefix taken off: a guessed translation of an error nobody has seen is worse than the original.
//
// NOTHING IS CLAIMED THAT THE MESSAGE DOES NOT SAY. "Not saved" appears only where the server's
// guard refuses before anything is sent. "No route preview" fails at the step that sets the stop
// order, after orders may already have been added, so it says the ORDER was not saved — never
// that nothing changed.
//
// THE WAY BACK: VITE_PLAIN_ERRORS=off puts back the server's words everywhere (house shape:
// default on, an off-word turns it off, anything malformed leaves it on). Build-time: a redeploy.

export function plainErrorsEnabled(env) {
  const v = String(env?.VITE_PLAIN_ERRORS ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The switch as this build reads it. Vite injects import.meta.env at build time; in Node (the
 *  unit suite) it is absent and the switch reads on, as the house shape says. */
export const PLAIN_ERRORS_ON = (() => {
  try { return plainErrorsEnabled(import.meta.env); } catch { return true; }
})();

const OP_PREFIX = /^\s*(?:commitBoard(?:\((?:rwb|import)\))?|commitLoad|createRoute|newRoute|setStopAddress|setStopDate|setStopContact|addStopNote|cancelOrder|createStop)\s*:\s*/i;
const LOAD_NBR = String.raw`[A-Z][A-Z0-9]*\d{6,}`;
/** A route as the server labels it: "NAME (DAVIS000204479)", or the bare number (loadLabel). */
const LABEL = String.raw`(?:[^()]+? \(${LOAD_NBR}\)|${LOAD_NBR})`;

function stripPrefix(s) {
  let t = String(s ?? '').trim();
  while (OP_PREFIX.test(t)) t = t.replace(OP_PREFIX, '');
  return t;
}
function nameOf(label) {
  const m = new RegExp(String.raw`^(.+?) \((${LOAD_NBR})\)$`).exec(String(label).trim());
  return m ? m[1] : String(label).trim();
}
/** Two routes as a person tells them apart: by name, unless the names are the same (BUFORD on two
 *  different days), when the load numbers are the only difference and stay in. */
function pairNames(a, b) {
  const na = nameOf(a); const nb = nameOf(b);
  return na === nb ? [String(a).trim(), String(b).trim()] : [na, nb];
}
function asSentence(s) {
  const t = String(s ?? '').trim();
  if (!t) return t;
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}
const things = (n) => (n === '1' ? 'one other thing' : `${n} other things`);
/** "documents: LOST to|BOL|03||pdf||01 | to.reference: \"A\" → \"B\"" → "the BOL document, reference". */
function fieldWords(details) {
  const parts = String(details || '').replace(/\s*\(\+\d+ more\)\s*$/, '').split(' | ').map((p) => p.trim()).filter(Boolean);
  const words = parts.map((p) => {
    const lost = /^[\w.]+: LOST (.+)$/.exec(p);
    if (lost) {
      const kinds = [...new Set(lost[1].split(' · ').map((id) => String(id).split('|')[1] || '').filter(Boolean))];
      return kinds.length ? `the ${kinds.join(' and ')} document${kinds.length > 1 ? 's' : ''}` : 'a document';
    }
    const path = /^([\w.]+):/.exec(p);
    return path ? path[1].split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : p;
  });
  return [...new Set(words)].join(', ');
}
/** An inner error quoted inside another, as its own plain sentence(s) without a leading "Not saved." */
function innerPlain(raw) {
  return plainSentence(raw).replace(/^(?:Not saved|Nothing was saved)\.\s*/, '');
}
/** Just the first sentence of an inner error, without its full stop — to sit in brackets. */
function firstClause(raw) {
  const t = innerPlain(raw);
  const cut = t.search(/[.!?](?:\s|$)/);
  return (cut >= 0 ? t.slice(0, cut) : t).trim();
}

const RULES = [
  // A stop NuVizz holds on the load that the card is not sequencing — named since v1.98.4.
  [new RegExp(String.raw`^load has a non-DO stop in a delivery slot that this card is not sequencing — (.+?)\. Nothing was sent: .*$`, 's'), (m) => (
    m[1].includes('; ') || /\(\+\d+ more\)$/.test(m[1])
      ? `Not saved. NuVizz has stops on this route that aren't on your card: ${m[1]}. Add them to the card if they belong on this route, or take them off the route in the portal, then Save again.`
      : `Not saved. NuVizz has a stop on this route that isn't on your card: ${m[1]}. Add it to the card if it belongs on this route, or take it off the route in the portal, then Save again.`)],
  // The same guard before it named the stop, and the older Save path that still does not.
  [/^load has a non-DO stop in a delivery slot(?: that this card is not sequencing)? — reorder skipped \(verify in portal\)$/,
    () => "Not saved. NuVizz has a stop on this route that isn't on your card, so the stop order could not be changed. Find it on the route in the NuVizz portal."],
  // Orders on the load that the screen has not caught up with.
  [new RegExp(String.raw`^load (${LOAD_NBR}) has (\d+) stop\(s\) the board isn't showing \(([^)]*)\) — a declarative RWB save would unplan them\. Refresh and retry\.?$`), (m) => (
    m[2] === '1'
      ? `Not saved. NuVizz has an order on this route that your screen isn't showing yet (${m[3]}). Saving now would take it off the truck — refresh, then Save again.`
      : `Not saved. NuVizz has ${m[2]} orders on this route that your screen isn't showing yet (${m[3]}). Saving now would take them off the truck — refresh, then Save again.`)],
  // An order another route still holds.
  [new RegExp(String.raw`^stop (\S+) couldn't be added to (${LABEL}) — NuVizz (?:still )?holds it on (${LABEL})\. (.*)$`, 's'), (m) => {
    const [to, from] = pairNames(m[2], m[3]);
    return /is part of this Save/.test(m[4])
      ? `Order ${m[1]} is still on ${from} in NuVizz, so it couldn't go on ${to}. ${from} is in this same Save, so NuVizz may still be catching up — wait a few seconds, refresh, and Save again.`
      : `Order ${m[1]} is already on ${from}, so it couldn't go on ${to}. Open ${from} in Compare and move it from there, or take it off ${from} in the portal.`;
  }],
  [new RegExp(String.raw`^stop (\S+) is ALREADY PLANNED on (${LABEL}) \(our board may be showing it stale-unplanned\) — .*$`, 's'),
    (m) => `Order ${m[1]} is already on ${nameOf(m[2])} — your screen may be out of date. Open ${nameOf(m[2])} in Compare to move it, or refresh and check again.`],
  // A route that failed because an order it was taking comes from a route that failed first.
  [new RegExp(String.raw`^stop (\S+) is on (${LABEL}), which FAILED this Save \((.*)\) — it could not be moved to (${LABEL}), and nothing was written for .*$`, 's'), (m) => {
    const [src, dst] = pairNames(m[2], m[4]);
    return `${dst} was not saved. Order ${m[1]} comes from ${src}, and ${src} couldn't be saved: ${innerPlain(m[3])} Fix ${src} first, then Save again.`;
  }],
  // Another route failed, so the all-or-nothing Save wrote nothing — or an earlier route's order had already gone in.
  [/^aborted — another load in this Save failed \((.*)\)\.( A resequence step had ALREADY persisted| The multi-load save is all-or-nothing, so nothing was written)[^]*$/s, (m) => (
    /ALREADY persisted/.test(m[2])
      ? `Not all of this Save went through. Another route in it failed (${firstClause(m[1])}), after an earlier route's stop order had already been saved. Check the routes in the portal, then Save again.`
      : `Nothing was saved, because another route in this Save failed (${firstClause(m[1])}). A Save goes through all together or not at all, so Save again once that route is fixed.`)],
  // The step that sets the stop order got no preview back. Orders may already have been added.
  [/^fetchUpdatedJson returned no route preview$/,
    () => "NuVizz didn't send back the updated route, so the stop order was not saved. Refresh and check the route, then Save again."],
  // Added, but not on the route yet.
  [new RegExp(String.raw`^(?:(\d+) stops \(([^)]*)\)|stop (\S+)) did not appear on (${LABEL}) after the add — the stop record (reads ON this load already|reads UNPLANNED right now)[^]*$`, 's'), (m) => {
    const who = m[1] ? `${m[1]} orders (${m[2]})` : `Order ${m[3]}`;
    const verb = m[1] ? "haven't" : "hasn't";
    const first = m[1] ? 'the first one' : 'it';
    const route = nameOf(m[4]);
    return /^reads ON/.test(m[5])
      ? `${who} ${verb} shown up on ${route} yet, but NuVizz's own record already has ${first} on ${route}, so NuVizz is still catching up. Nothing was planned twice. Wait a few seconds, then Save again.`
      : `${who} ${verb} shown up on ${route} yet. NuVizz still has ${first} as unplanned, so it is probably still working on it. Nothing was planned twice. Wait a few seconds, then Save again.`;
  }],
  // NuVizz took the Save; the check afterwards could not read it back.
  [/^post-save verify read failed \((.*)\) — NuVizz took the save; refresh and re-Save to confirm$/s, (m) => (
    /circuit breaker/i.test(m[1])
      ? "NuVizz took the Save, but the app couldn't read it back to check it — NuVizz calls are paused for a moment. Refresh in a minute, then Save again to confirm."
      : "NuVizz took the Save, but the app couldn't read it back to check it. Refresh, then Save again to confirm.")],
  // The emptied route NuVizz would not cancel.
  [new RegExp(String.raw`^(\d+) stop\(s\) moved to (.+?), but NuVizz refused to cancel the now-emptied (${LABEL}): (.*?)\. It still holds ([^.]*)\. (.*)$`, 's'), (m) => {
    const src = nameOf(m[3]);
    const dests = m[2].split(', ').map(nameOf).join(', ');
    const left = m[5] && m[5] !== 'no deliveries' ? ` ${src} still has ${m[5].includes(',') ? 'orders' : 'order'} ${m[5]}.` : '';
    return /vehicle\s*type/i.test(m[4])
      ? `The orders moved to ${dests}, but NuVizz wouldn't cancel the ${src} route because its Vehicle Type is turned off.${left} Turn the Vehicle Type back on or change it (or cancel ${src}) in the portal, then Save again.`
      : `The orders moved to ${dests}, but NuVizz wouldn't cancel the ${src} route (NuVizz said: "${m[4]}").${left} Cancel ${src} in the portal, then refresh.`;
  }],
  [new RegExp(String.raw`^(\d+) of (\d+) stop\(s\) landed on (${LABEL}); stop (\S+) is still on (${LABEL}), whose cancel was refused[^]*$`, 's'), (m) => {
    const [to, from] = pairNames(m[3], m[5]);
    return `${m[1]} of ${m[2]} orders moved to ${to}. Order ${m[4]} is still on ${from}, because NuVizz wouldn't cancel ${from}. Sort out ${from} in the portal, then move ${m[4]} and Save again — nothing on ${to} was lost.`;
  }],
  // ＋ New route's own guards and the portal create (v1.98.5) — each refuses before anything is made,
  // except where the words say the route WAS made.
  [new RegExp(String.raw`^order (\S+) is ALREADY PLANNED on (${LABEL}|.+?) — remove it from this card, or open .* in Compare to move it\. Nothing was created\.?$`, 's'),
    (m) => `Nothing was created: order ${m[1]} is already on ${nameOf(m[2])}. Take it off this card, or open ${nameOf(m[2])} in Compare to move it.`],
  [/^order (\S+) is already (.+?) — finished work cannot ride a new route\. Remove it and re-Save\. Nothing was created\.?$/s,
    (m) => `Nothing was created: order ${m[1]} is already ${m[2].toLowerCase()}, and finished orders can't go on a new route. Take it off the card, then Save again.`],
  [/^the route needs at least one order — NuVizz will not create an empty one \(reason 903\)\. Drag orders onto the card, then Save\.?$/,
    () => 'Nothing was created: a new route needs at least one order. Drag orders onto the card, then Save.'],
  [/^order (\S+) appears twice on the card — remove the duplicate and re-Save\.?$/,
    (m) => `Order ${m[1]} is on the card twice. Remove one, then Save again.`],
  [/^NuVizz already has a route named (.+?) — open it from the Routes panel instead of creating it again, or pick another name — nothing was created\.?$/s,
    (m) => `Nothing was created: NuVizz already has a route named ${m[1]}. Open it from the Routes panel, or pick another name.`],
  [/^route (.+?) WAS created in NuVizz \((\S+)\), but its (\d+) order\(s\) did not attach — (.*?)\. Close this card and open .* from the Routes panel to add them; do NOT create it again\.?$/s,
    (m) => `The route ${m[1]} was created in NuVizz (${m[2]}), but its orders didn't go on it (${firstClause(m[4])}). Close this card and open ${m[1]} from the Routes panel to add them — don't create it again.`],
  [/^NuVizz accepted the route but (\S+) is not readable yet — it may still land\. Refresh in a moment before creating it again \(do NOT re-create with the same name\)\.?$/,
    () => "NuVizz took the route, but it can't be read back yet — it may still show up. Refresh in a moment, and don't create it again with the same name."],
  [/^route creation through the Route Workbench is switched on \(NUVIZZ_ROUTE_CREATE_RWB\) but its portal sign-in is not ready .* — nothing was created$/s,
    () => "Nothing was created: new routes are set to go through the NuVizz portal, but the portal sign-in isn't set up on this server."],
  // The address, and the notes that ride the same write.
  [/^the address changed to (.+?) AND partialUpdate changed (\d+) other field\(s\) on the order\. (.+?)\. Check (\S+) in the portal[^]*$/s,
    (m) => `The address changed to ${m[1]}, but NuVizz also changed ${things(m[2])} on the order (${fieldWords(m[3])}). Check order ${m[4]} in the portal.`],
  [/^the address did NOT change \((\S+) still reads (.+?)\) AND partialUpdate changed (\d+) other field\(s\) on the order\. (.+?)\. Check (\S+) in the portal[^]*$/s,
    (m) => `The address did not change — order ${m[1]} still reads ${m[2]} — and NuVizz changed ${things(m[3])} on the order (${fieldWords(m[4])}). Check order ${m[5]} in the portal.`],
  [/^NuVizz accepted the write but (\S+) still reads (.+?), not (.+?) — the address did NOT change\.( The dispatcher note DID land)?[^]*$/s,
    (m) => `NuVizz didn't change the address — order ${m[1]} still reads ${m[2]}.${m[4] ? ' The note did go on the order, so take it off in the portal.' : ''} Check it in the portal before trying again.`],
  [/^the note (landed|did NOT land) BUT partialUpdate changed (\d+) other field\(s\) on the order\.( AN ADDRESS ON THE ORDER MOVED[^.]*\.)? (.+?)\. Check (\S+) in the portal( — do not use notes again until this is investigated)?\.?$/s,
    (m) => `${m[1] === 'landed' ? 'The note was added' : "The note didn't go on"}, but NuVizz also changed ${things(m[2])} on the order (${fieldWords(m[4])}).${m[3] ? ' An address on the order moved — check its addresses before it ships.' : ''} Check order ${m[5]} in the portal${m[6] ? ", and don't add more notes until this is looked into" : ''}.`],
  [/^the (?:change|note) was accepted but the read-back failed \((.*?)\) — check (?:(\S+) |the order )in the portal[^]*$/s,
    (m) => `NuVizz took the change, but the app couldn't read the order back to check it. Check ${m[2] ? `order ${m[2]}` : 'the order'} in the portal before trying again.`],
  // NuVizz's own refusal of an order already moving (seen as "is in Transit,can not be updated. (code 906)").
  [/^Stop (\S+) is in Transit,\s*can not be updated\.?(?:\s*\(code \d+\))?\.?$/i,
    (m) => `Order ${m[1]} is already in transit, so NuVizz won't let it be changed.`],
  // The read that comes before every single-order write failed, so nothing was sent.
  [/^could not read (?:stop|order) (\S+) \((.*?)\) — nothing was (written|cancelled|created)\.?$/s,
    (m) => `Nothing was ${m[3] === 'written' ? 'changed' : m[3]}: the app couldn't read order ${m[1]} from NuVizz. Refresh, then try again.`],
  // The connection itself.
  [/^fetch failed$/i, () => "The app couldn't reach NuVizz (a network problem). Check the route in the portal before trying again."],
  [/^(?:Failed to fetch|Load failed|network error|NetworkError when attempting to fetch resource\.?)$/i,
    () => "The connection dropped before the answer came back, so the app can't tell whether this went through. Check it before trying again."],
];

function plainSentence(raw) {
  const original = String(raw ?? '');
  const vendor = summarizeVendorError(original);
  if (vendor) {
    const creating = /^\s*(?:createRoute|newRoute)\s*:/i.test(original);
    if (/Cannot invoke|is null|NullPointer|Exception/i.test(vendor.headline)) {
      return creating ? 'NuVizz hit an internal error and refused to create the route.' : 'NuVizz hit an internal error and refused the change.';
    }
    return asSentence(`NuVizz refused it: ${vendor.headline}`);
  }
  const t = stripPrefix(original);
  for (const [re, fmt] of RULES) {
    const m = re.exec(t);
    if (m) return fmt(m);
  }
  return asSentence(t.replace(/\bstop\(s\)/g, 'stops'));
}

/**
 * PURE. A write error as the plain sentence(s) a dispatcher reads (see the section header).
 * Off (VITE_PLAIN_ERRORS=off) or empty, it hands the text back exactly as it came.
 */
export function plainWriteError(raw, { on = PLAIN_ERRORS_ON } = {}) {
  const original = raw == null ? '' : String(raw);
  if (!on || !original.trim()) return original;
  return plainSentence(original);
}
