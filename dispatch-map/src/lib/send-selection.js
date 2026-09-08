// src/lib/send-selection.js
//
// PURE: what ONE press of the Compare header's "→ LOAD (N)" button does with the map selection.
//
// Chad, Tue Sep 8: "i put 2 routes in the panel that i wanted to add stops to then i went and
// selected the stops i wanted it to put on the route and then when i clicked the button to add
// stops it didn't put them on the route."
//
// WHAT WAS HAPPENING. A stop still PLANNED on a load that is NOT open in Compare cannot simply be
// added to the target: the Save is declarative over the loads in the payload, so without the
// SOURCE load in the Save the stop would be double-planned. The old handler therefore opened the
// source card, kept the stops selected, put nothing on the target, and asked — in a four-second
// toast at the bottom of the map — to press Send AGAIN. On a desktop with cards open the Setup
// panel's message line is not on screen at all, so a dispatcher who missed the toast saw a third
// card appear and nothing move. And the toast said "Opened X" whether or not X actually opened.
//
// THE RULE NOW: one press does the whole move. The source load's card is opened in the same
// press (so the Save can release the stop) and the stops move onto the target immediately. A
// source that cannot open — Compare full, two loads sharing its name, no NuVizz identity — keeps
// its stops selected and is named with the real reason. Nothing is claimed that did not happen.
//
// Everything effectful is injected (how a card is built, who holds a stop, who else is staging
// it, which co-located orders ride along), so the rule is testable on plain data.

/**
 * @typedef {{ key: string, name?: string|null, loadNbr?: string|null, order: string[] }} Card
 *
 * @param {object} p
 * @param {string[]} p.ids            selected stop numbers
 * @param {string} p.targetKey        the card the button belongs to
 * @param {Card[]} p.cards            the open Compare cards, in order
 * @param {number} p.max              the card cap (WB_MAX)
 * @param {(id: string) => string} p.holderOf   the route that still holds the stop on the board ('' when unplanned)
 * @param {(id: string) => string|null} [p.claimedBy]  who is staging it on another device, if anyone
 * @param {(holder: string, cards: Card[]) => ({ card: Card } | { refusal: string } | { already: true })} [p.openCard]
 *        builds a fresh card for a holder load, or says why it cannot
 * @param {(id: string) => Array<{ id: string, label: string }>} [p.twinsOf]
 *        co-located unplanned orders that should ride along with this stop
 * @param {(key: string) => string} [p.displayName]
 * @returns {null | { cards: Card[], moved: string[], held: string[], opened: string[], refusals: string[],
 *   twins: string[], skippedClaimed: string[], changed: boolean, message: string }}
 */
export function planSendSelection({ ids, targetKey, cards, max, holderOf, claimedBy = null, openCard = null, twinsOf = null, displayName = null }) {
  const key = targetKey == null ? '' : String(targetKey);
  const wanted = [...new Set((ids || []).map((v) => String(v ?? '')).filter(Boolean))];
  const open = Array.isArray(cards) ? cards : [];
  if (!key || !wanted.length || !open.some((r) => String(r.key) === key)) return null;
  const name = (k) => (displayName ? (displayName(k) || String(k)) : String(k));
  const holder = (id) => String((holderOf && holderOf(id)) || '');
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : Infinity;

  // Another device is staging it → leave it alone (both Saves would fight; the later one wins).
  const skippedClaimed = [];
  const claimedNames = new Map();
  let live = wanted.filter((id) => {
    const who = claimedBy ? claimedBy(id) : null;
    if (!who) return true;
    skippedClaimed.push(id); claimedNames.set(id, String(who));
    return false;
  });

  let next = [...open];
  const identities = () => {
    const set = new Set();
    for (const r of next) for (const v of [r.key, r.name, r.loadNbr]) if (v != null && String(v) !== '') set.add(String(v));
    return set;
  };

  // Every holder load that is not open gets its card opened NOW, so the move can stage on both
  // sides in this press. Cap and refusals are recorded by name, never invented.
  const opened = [];
  const refusals = [];
  const holdersSeen = new Set();
  for (const id of live) {
    const h = holder(id);
    if (!h || holdersSeen.has(h)) continue;
    holdersSeen.add(h);
    if (identities().has(h)) continue;
    if (next.length >= cap) { refusals.push(`${name(h)} needs a free card — Compare is full (${cap}/${cap}); close one, then Send again`); continue; }
    if (!openCard) { refusals.push(`${name(h)} is not open in Compare`); continue; }
    const r = openCard(h, next) || {};
    if (r.card) { next.push(r.card); opened.push(name(h)); continue; }
    if (r.already) continue;
    refusals.push(r.refusal ? String(r.refusal) : `${name(h)} could not be opened in Compare`);
  }

  const canStage = identities();
  const stageable = live.filter((id) => { const h = holder(id); return !h || canStage.has(h); });
  const held = live.filter((id) => { const h = holder(id); return h && !canStage.has(h); });

  // Same-address twins ride along (two orders at one dock render as one pin; the click grabs
  // only the top one). Loudly, and removable from the card if the split was intentional.
  const twins = [];
  const twinLabels = [];
  if (twinsOf) {
    const have = new Set(stageable);
    for (const id of stageable) {
      for (const t of twinsOf(id) || []) {
        const tid = String(t?.id ?? '');
        if (!tid || have.has(tid)) continue;
        have.add(tid); twins.push(tid); twinLabels.push(t?.label ? String(t.label) : tid);
      }
    }
  }

  const add = [...stageable, ...twins];
  const addSet = new Set(add);
  let changed = next.length !== open.length;
  if (add.length) {
    next = next.map((r) => {
      if (String(r.key) === key) {
        const have = new Set((r.order || []).map(String));
        const more = add.filter((id) => !have.has(id));
        if (!more.length) return r;
        changed = true;
        return { ...r, order: [...r.order, ...more], strategy: 'manual' };
      }
      if ((r.order || []).some((id) => addSet.has(String(id)))) {
        changed = true;
        return { ...r, order: r.order.filter((id) => !addSet.has(String(id))), strategy: 'manual' };
      }
      return r;
    });
  }

  // One sentence, in the order a dispatcher reads it: what moved, what was opened to allow it,
  // what did not move and why, what else came along.
  const parts = [];
  if (stageable.length) {
    let s = `Sent ${stageable.length} stop${stageable.length === 1 ? '' : 's'} → ${name(key)}`;
    if (opened.length) s += ` (opened ${opened.join(', ')} in Compare so the Save can release ${opened.length === 1 ? 'it' : 'them'})`;
    parts.push(s);
  }
  if (held.length) parts.push(`${held.length} stop${held.length === 1 ? '' : 's'} NOT moved — ${[...new Set(refusals)].join('; ')}`);
  if (skippedClaimed.length) parts.push(`skipped ${skippedClaimed.length} being staged by ${claimedNames.get(skippedClaimed[0])} on another device`);
  if (twins.length) parts.push(`⚠ also added ${twins.length} co-located order${twins.length === 1 ? '' : 's'} the selection missed: ${twinLabels.slice(0, 3).join(', ')}${twinLabels.length > 3 ? '…' : ''} — remove from the card if you meant to split`);
  if (!parts.length) parts.push(`Nothing sent to ${name(key)}`);

  return { cards: next, moved: stageable, held, opened, refusals, twins, skippedClaimed, changed, message: parts.join(' · ') };
}
