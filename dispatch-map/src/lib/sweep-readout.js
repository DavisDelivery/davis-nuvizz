// sweep-readout.js
//
// "SO WHY DIDN'T HE GET ONE?" — the sentence the Alert recipients panel could not say.
//
// On 2026-09-10 Chad added a number to the flag texts, got two texts himself, and the person
// he added got none. Nothing was broken: the number went on the OVERNIGHT list, and the sweep
// that sent those two texts fired at 6:00:50a — fifty seconds past the 6:00a cutoff where the
// overnight list is dropped ("after that he's no longer routing"). The panel showed both lists
// correctly and still could not answer the question, because a list of numbers describes who
// is SIGNED UP and the question is about what HAPPENED.
//
// This turns the evening sweep's own status document into that sentence. Pure, so the wording
// is testable and the card stays dumb.
//
// IT NEVER INVENTS THE HALF IT DOES NOT HAVE. A status document written before the sweep
// started recording `nightRode` says nothing about the overnight list rather than guessing
// from the clock — the guess would be right most nights and wrong on exactly the night
// somebody is looking, which is the worst possible ratio.

/** "6:00a" from ET minutes past midnight. Null for anything that is not a real minute. */
export function etClock(min) {
  if (!Number.isFinite(min)) return null;
  const mm = ((Math.round(min) % 1440) + 1440) % 1440;
  const h12 = ((Math.floor(mm / 60) + 11) % 12) + 1;
  return `${h12}:${String(mm % 60).padStart(2, '0')}${mm < 720 ? 'a' : 'p'}`;
}

/**
 * PURE. One line about the last evening sweep, or null when there is nothing honest to say.
 *
 * `tone` is 'plain' unless something is worth an eye: a send that failed, or texts switched
 * off while flags were found. The overnight cutoff is NOT a warning — it is the rule working,
 * and colouring it red would train somebody to ignore the colour.
 */
export function sweepReadout(sweep) {
  if (!sweep || typeof sweep !== 'object') return null;
  const clock = etClock(sweep.etMin);
  if (!clock) return null;

  const sent = Number(sweep.sent) || 0;
  const failed = Number(sweep.failed) || 0;
  const nOn = Number(sweep.recipients) || 0;

  const who = `${nOn} number${nOn === 1 ? '' : 's'}`;
  const parts = sent
    ? [`Last sweep ${clock} — ${sent} text${sent === 1 ? '' : 's'} to ${who}.`]
    : [`Last sweep ${clock} — no flags to text; ${who} on the list.`];

  // THE HALF THAT ANSWERS THE QUESTION, and only when the document actually carries it.
  if (typeof sweep.nightRode === 'boolean' && Number.isFinite(sweep.nightCount) && sweep.nightCount > 0) {
    parts.push(sweep.nightRode
      ? `The overnight list (${sweep.nightCount}) was on this sweep.`
      : `The overnight list (${sweep.nightCount}) was NOT — it is dropped at 6:00a.`);
  }

  if (failed) parts.push(`${failed} send${failed === 1 ? '' : 's'} failed.`);
  if (sweep.smsEnabled === false) parts.push('Texting is not configured on this deploy.');
  else if (sweep.textsSilenced) parts.push('Texts are switched off here on purpose.');

  return {
    line: parts.join(' '),
    tone: failed || sweep.smsEnabled === false ? 'warn' : 'plain',
    // True when a number on the overnight list was excluded from THIS sweep — the exact case
    // that sent somebody looking for a bug. The card uses it to point at the standing list.
    cutOff: sweep.nightRode === false && Number(sweep.nightCount) > 0,
  };
}
