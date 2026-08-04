// wedge.js — keyboard-wedge capture for hardware scanners.
//
// A Zebra MC3400 or a DS3678-ER paired to a tablet delivers a barcode as a
// burst of KEYSTROKES ending in Enter (DataWedge's default suffix; Tab is the
// other common one), not as camera frames. This is the capture layer and ONLY
// the capture layer: a committed string feeds the exact same classify → pair →
// evaluateScan path the camera uses. Nothing in the matching logic knows or
// cares that the barcode arrived as keystrokes.
//
// Pure accumulator — no DOM here, so the commit rules are testable without a
// gun in hand. The App owns the hidden focused input and forwards
// KeyboardEvent.key values in.

export const WEDGE_COMMIT_KEYS = ['Enter', 'Tab'];

/**
 * A gun fires the two label barcodes as two separate trigger pulls, seconds
 * apart — much slower than a camera frame. The pair window has to cover a
 * human re-aiming between the PRO and the OG, while still expiring a lone
 * half-scan before the operator walks to the next pallet.
 */
export const WEDGE_PAIR_WINDOW_MS = 8000;

/** Longer than any real barcode we accept; a runaway buffer is discarded, not trusted. */
export const WEDGE_MAX_LENGTH = 64;

/**
 * Accumulate keystrokes into barcode strings.
 *
 * `key(k)` takes a KeyboardEvent.key value. Printable characters accumulate; a
 * commit key emits the trimmed buffer through onScan and clears it; everything
 * else (Shift, arrows, F-keys) is ignored. Returns true when the key was
 * consumed, so the caller knows to preventDefault.
 */
export function createWedgeAccumulator({ onScan, maxLength = WEDGE_MAX_LENGTH } = {}) {
  let buf = '';
  return {
    key(k) {
      if (WEDGE_COMMIT_KEYS.includes(k)) {
        const value = buf.trim();
        buf = '';
        if (value) onScan?.(value);
        return true;
      }
      if (typeof k === 'string' && k.length === 1) {
        buf += k;
        if (buf.length > maxLength) buf = ''; // not a barcode of ours — drop it
        return true;
      }
      return false;
    },
    /** What has accumulated but not committed — diagnostics only. */
    value: () => buf,
    reset() {
      buf = '';
    },
  };
}
