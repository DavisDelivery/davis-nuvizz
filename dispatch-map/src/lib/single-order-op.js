// single-order-op.js — the idempotency key Single New Order sends a create under, and what the
// form says when the server answers.
//
// ONE KEY PER REQUEST, NOT PER FORM. The key exists so a retry after a lost answer is replayed
// by the server's op ledger (nuvizz-write.mts: a succeeded key answers idempotent: true with the
// earlier result) instead of creating the order twice. It was renewed only on a confirmed
// success, so after a lost answer the NEXT order typed into the form went out under the lost
// one's key: when that create had in fact landed, the server replayed ITS result, the new order
// was never created, and the form announced "✓ Order created" for it (review A2-S9-10).

/**
 * PURE: the key for this submit. `prev` is { id, sent } — the key the last unconfirmed submit
 * went out under and the request it carried (sent: null when nothing has gone out under it).
 * The same request again keeps the key; any other request gets a new one from `mint`.
 */
export function singleOrderOpId(prev, request, mint) {
  const sent = JSON.stringify(request);
  if (prev?.id && (prev.sent == null || prev.sent === sent)) return { id: prev.id, sent };
  return { id: mint(), sent };
}

/**
 * PURE: the line for a confirmed new order. A replay (`idempotent`) is the server saying an
 * EARLIER try of this same request already created it — said as that, never as a fresh create.
 */
export function singleOrderCreatedMsg(nbr, { idempotent = false } = {}) {
  return idempotent
    ? `✓ Order ${nbr} was already created by an earlier try whose answer was lost — nothing new was sent. It's UNPLANNED; plan it onto a load in Routing.`
    : `✓ Order created — ${nbr}. It's now UNPLANNED; plan it onto a load in Routing.`;
}
