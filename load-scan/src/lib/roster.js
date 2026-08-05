// roster.js — who on the board the app can actually identify.
//
// This restates the resolution rule from aliases.mts on the client, so keep the
// two together: EXACTLY ONE credential claiming a name is identified. Zero is
// not, and — the part that is easy to get wrong — neither is TWO. Two claimants
// resolve to NEITHER driver (resolveDriverForAlias returns 'ambiguous'), so
// counting a twice-claimed name as identified would hide two broken drivers
// behind a green tick, which is the exact failure this screen exists to surface.

export function partitionBoardRows(rows) {
  const claims = (r) => (Array.isArray(r?.claimedBy) ? r.claimedBy : []).length;
  const list = Array.isArray(rows) ? rows : [];
  return {
    identified: list.filter((r) => claims(r) === 1),
    unidentified: list.filter((r) => claims(r) === 0),
    ambiguous: list.filter((r) => claims(r) > 1),
  };
}
