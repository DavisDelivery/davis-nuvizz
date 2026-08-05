// roster.js — who on the board the app can actually identify, and finding a
// credential among fifty of them.
//
// This restates the resolution rule from aliases.mts on the client, so keep the
// two together. A board name is identified only when EXACTLY ONE **active**
// credential claims it. Three ways that fails, and they need different fixes:
//
//   claimed by nobody          -> create a driver, or attach the name to one
//   claimed only by INACTIVE   -> reactivate, or move the name to a live driver
//   claimed by two or more     -> resolves to NEITHER; take the name off one
//
// The inactive case is the one that hid a real fault: login filters to active
// credentials before resolving, and load-manifest 403s an inactive one, so a
// name held only by a deactivated account gets NOTHING while looking claimed.
// Counting it as identified put a green tick over a driver who would be handed
// an empty truck. Two claimants is the mirror image — easy to mistake for fine.

export function partitionBoardRows(rows) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const list = Array.isArray(rows) ? rows : [];
  const active = (r) => arr(r?.claimedBy).length;
  const inactive = (r) => arr(r?.inactiveClaimedBy).length;

  return {
    identified: list.filter((r) => active(r) === 1),
    ambiguous: list.filter((r) => active(r) > 1),
    // No live claimant. Split by whether a dead one explains it, because the
    // remedy differs and "create a driver" is wrong for the inactive case.
    inactiveOnly: list.filter((r) => active(r) === 0 && inactive(r) > 0),
    unidentified: list.filter((r) => active(r) === 0 && inactive(r) === 0),
  };
}

/**
 * What can this person actually TYPE to sign in?
 *
 * There is no "login name" field. Sign-in matches the typed text against the
 * display name AND every alias, and resolves only when EXACTLY ONE active
 * credential claims it — see resolveLoginIdentifier in aliases.mts. So a
 * credential's usable sign-in names are a derived set, and nothing on the
 * screen used to show it: a dispatcher could not tell a driver what to type,
 * and could not see that one of the names was dead.
 *
 * Anything claimed by two active credentials resolves to NEITHER, so it is
 * listed separately as broken rather than quietly dropped — the driver will try
 * it, it will fail, and that is worth showing before 5am.
 *
 * Normalization matches normalizeDriverAlias byte for byte: trim, collapse
 * internal whitespace, uppercase. Keep the two together.
 */
const up = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

export function loginNamesFor(cred, allCreds) {
  // A deactivated credential cannot sign in under ANY name — login filters to
  // active credentials before it resolves anything. Reporting per-name results
  // for it is noise at best and, when a live driver holds one of the same
  // spellings, an outright lie about who that name signs in as.
  if (cred?.active === false) return { works: [], broken: [], inactive: true };

  const live = (Array.isArray(allCreds) ? allCreds : []).filter((c) => c?.active !== false);
  const isMe = (c) => String(c?.driverNumber) === String(cred?.driverNumber);

  // Every string that would identify SOMEBODY, and who it lands on.
  const claimants = (name) =>
    live.filter(
      (c) =>
        up(c?.displayName) === name ||
        (Array.isArray(c?.nuvizzAliases) ? c.nuvizzAliases : []).some((a) => up(a) === name),
    );

  const mine = [up(cred?.displayName), ...(Array.isArray(cred?.nuvizzAliases) ? cred.nuvizzAliases : []).map(up)]
    .filter(Boolean);

  const works = [];
  const broken = [];
  for (const name of [...new Set(mine)]) {
    const who = claimants(name);
    // One claimant is not enough — it has to be THIS credential. A name that
    // resolves to exactly one OTHER driver is worse than a dead one: typing it
    // signs the wrong person in.
    if (who.length === 1 && isMe(who[0])) {
      works.push(name);
    } else {
      broken.push({
        name,
        claimedBy: who.map((c) => String(c.driverNumber)),
        signsInAsSomeoneElse: who.length === 1 && !isMe(who[0]) ? String(who[0].displayName || who[0].driverNumber) : null,
      });
    }
  }
  return { works: works.sort((a, b) => a.length - b.length || a.localeCompare(b)), broken, inactive: false };
}

/**
 * Board names still going spare — the ones to offer when setting a driver up.
 *
 * A person usually appears under SEVERAL spellings ("BRENT BOYD" and "BRENT"),
 * and a credential only works for the spellings it holds. The dispatcher cannot
 * know the full set from memory, so the editor offers what is actually on the
 * board rather than asking them to type it.
 *
 * "Spare" means no ACTIVE credential claims it — same rule as identification,
 * because an inactive claimant resolves to nothing and must not reserve a name.
 * Those are still offered, flagged, since a name stuck on a deactivated account
 * is exactly the one a dispatcher needs to move.
 *
 * Sorted by stop count: the spelling carrying the most freight matters most.
 */
export function availableAliases(rows, alreadyHave = []) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const up = (s) => String(s ?? '').trim().toUpperCase();
  const mine = new Set(arr(alreadyHave).map(up));

  return arr(rows)
    .filter((r) => arr(r?.claimedBy).length === 0)
    .filter((r) => up(r?.alias) && !mine.has(up(r?.alias)))
    .map((r) => ({
      alias: r.alias,
      stops: Number(r?.stops || 0),
      heldByInactive: arr(r?.inactiveClaimedBy),
    }))
    .sort((a, b) => b.stops - a.stops || a.alias.localeCompare(b.alias));
}

/** Everything that still needs a human, newest problem first. */
export function boardNeedsAttention(rows) {
  const p = partitionBoardRows(rows);
  return p.ambiguous.length + p.inactiveOnly.length + p.unidentified.length;
}

/**
 * Find a credential among ~50 by number, name, or any of its aliases.
 *
 * Matching the ALIASES matters as much as the name: the dispatcher usually
 * arrives here holding a spelling off the board, not the person's display name.
 */
export function filterCredentials(creds, query) {
  const q = String(query ?? '').trim().toUpperCase();
  const list = Array.isArray(creds) ? creds : [];
  if (!q) return list;
  return list.filter((c) => {
    const hay = [
      String(c?.driverNumber ?? ''),
      String(c?.displayName ?? ''),
      ...(Array.isArray(c?.nuvizzAliases) ? c.nuvizzAliases : []),
    ]
      .join(' ')
      .toUpperCase();
    return hay.includes(q);
  });
}
