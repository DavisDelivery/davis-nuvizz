// src/lib/map-satellite-control.js
//
// THE SATELLITE TOGGLE'S LOOK AND WORDS, IN ONE PLACE (PURE).
//
// Chad: "Want satellite view button taken out of menu and put on actual map near this
// button", pointing at the dispatch Map's Recenter crosshair. It had been a row in a filter
// panel that has to be opened, scrolled and closed again — for a control a dispatcher flips
// constantly to read a dock, a yard or a gate — and the PHONE filter sheet never carried the
// row at all, so on a phone there was no way to turn satellite on from that screen.
//
// It now lives ON the map on both screens, and the two are built completely differently:
// the dispatch Map hands Google a plain DOM button so it stacks with the crosshair at
// RIGHT_BOTTOM, while Routing renders a React button in its own tool rail. That is two
// implementations of one control, which is exactly how the wording and the on/off treatment
// drift apart. The spec lives here so they cannot.
//
// It is also the only way this is testable at all: the dispatch Map's button is created
// inside the Google Maps init, so it does not exist unless the Maps API loads — which it
// never does in CI, where there is no key. A spec that is pure is a spec that can be run.

/** The brand blue used for the "on" state — kept here so the two callers cannot disagree. */
export const SATELLITE_ON_BG = '#1e5b92';
export const SATELLITE_OFF_BG = '#ffffff';
export const SATELLITE_ON_STROKE = '#ffffff';
export const SATELLITE_OFF_STROKE = '#5f6368';

/**
 * PURE. Everything the control should render/announce for a given state.
 *
 * The label says WHICH WAY IT WILL GO, not just where it is. "Satellite view" on a lit
 * button is ambiguous — a dispatcher cannot tell whether it is describing the current base
 * or the one a press would bring — and a toggle whose position cannot be read is not a
 * toggle (the same rule the repo applies to the NuVizz breaker and the Beta/Live pill).
 *
 * @param {boolean} on
 * @returns {{on: boolean, label: string, ariaPressed: 'true'|'false', background: string,
 *            stroke: string, svg: string}}
 */
export function satelliteControlSpec(on) {
  const lit = !!on;
  return {
    on: lit,
    label: lit ? 'Satellite view on — switch to the road map' : 'Satellite view off — switch to satellite',
    ariaPressed: lit ? 'true' : 'false',
    background: lit ? SATELLITE_ON_BG : SATELLITE_OFF_BG,
    stroke: lit ? SATELLITE_ON_STROKE : SATELLITE_OFF_STROKE,
    svg: globeSvg(lit ? SATELLITE_ON_STROKE : SATELLITE_OFF_STROKE),
  };
}

/** The globe glyph, stroked in `stroke`. Matches the lucide Globe the Routing rail uses, so
 *  the two screens draw the same mark. */
export function globeSvg(stroke) {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}

/**
 * Paint an existing DOM button from the spec. Split from creation because the dispatch Map's
 * button is created ONCE (Google keeps it for the life of the map) and repainted on every
 * state change — so the create path and the update path must apply the identical treatment.
 * Tolerates a null element so a caller never has to guard.
 */
export function paintSatelliteControl(el, on) {
  if (!el) return null;
  const spec = satelliteControlSpec(on);
  el.title = spec.label;
  el.setAttribute('aria-label', spec.label);
  el.setAttribute('aria-pressed', spec.ariaPressed);
  el.style.background = spec.background;
  el.innerHTML = spec.svg;
  return spec;
}

/** The button's own chrome, matching the Recenter crosshair it sits beside (Google's own
 *  control styling: 40px, 2px radius, the same shadow). Kept beside the spec so the pair
 *  cannot drift apart visually. */
export const SATELLITE_BUTTON_CSS = 'border:none;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,0.3);width:40px;height:40px;margin:0 10px 10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;';
