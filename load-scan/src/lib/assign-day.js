// assign-day.js — which day the Assign tab is handing out, and which trucks it may offer.
//
// An assignment is saved under a shift day, and the loader's phone reads it back
// under the shift day. The trucks offered for tapping must therefore be the board
// read FOR THAT SAME DAY. AssignScreen used to keep a private shift day while
// listing the Activity panel's board for another date, so a dispatcher could hand
// out Tuesday's trucks into Wednesday's doc and nobody's phone would ever see it.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param activity  the scan-activity answer in hand ({ date, loads }), or null
 * @param date      the Activity panel's chosen day ('' when the box was cleared)
 * @returns {{ shiftDay: string, loads: object[] | null }}
 *   loads is null while the board in hand is for a different day — nothing may be
 *   tapped until the right day's trucks arrive.
 */
export function assignView(activity, date) {
  const shiftDay = DAY.test(String(date || '')) ? String(date) : String(activity?.date || '');
  const matches = !!activity && !!shiftDay && String(activity.date || '') === shiftDay;
  return { shiftDay, loads: matches ? activity.loads || [] : null };
}
