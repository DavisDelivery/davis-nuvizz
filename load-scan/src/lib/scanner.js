// scanner.js — dual-engine barcode capture, rewritten from the Davis-wms
// public/index.html camera path (vanilla, single file) into something a React
// component can own and tear down cleanly.
//
// ── ENGINE CHOICE BY CAPABILITY ──────────────────────────────────────────────
//   native  BarcodeDetector / ML Kit. Android Chrome, desktop Chrome.
//   quagga  iOS Safari has NO BarcodeDetector, so it gets Quagga2 off the CDN.
//
// ── BUG FIXED ON PORT ────────────────────────────────────────────────────────
// The WMS capability gate reads:
//     if (fmts && fmts.includes('code_128')) nativeOK = true;
// That checks the wrong symbology. The PRO barcode is Code 39, so a device with
// Code 128 but no Code 39 support would take the native path and then never read
// a PRO. Both formats are required here.
//
// ── BEHAVIOUR CHANGE ON PORT ─────────────────────────────────────────────────
// The WMS takes the FIRST valid PRO in a frame and breaks out of the loop. This
// app needs both barcodes off one label, so every barcode in the frame is
// collected and handed to the pair buffer. Quagga's decoder also moves from
// `multiple: false` to `multiple: true` for the same reason.
//
// ── PRESERVED FROM THE SOURCE (hard-won, not incidental) ─────────────────────
//   - Android focusMode 'continuous' plus a modest zoom via applyConstraints.
//     The source comment names this as the actual reason close labels would not
//     focus-lock.
//   - Quagga confidence gating: avgError < 0.15 accept; 0.15-0.35 require two
//     consecutive identical reads; > 0.35 discard.

import { createPairBuffer } from './scan-logic.js';

const QUAGGA_CDN = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';

/**
 * A pair is ONE LABEL — the same rule the gun learned in v0.32. Quagga is
 * deliberately multiple:false, so on an iPhone the two barcodes of one label
 * ALWAYS arrive on separate frames; the buffer marries them in either order
 * inside this window. A PRO whose piece id never decodes is still a piece (the
 * WMS rule that made this app scan at all) — but it books when the window
 * closes, not on the first PRO frame. The instant booking minted PHANTOMS: the
 * PRO decodes a beat before the OG, the phantom books, the green flash ends the
 * aim, and the OG that lands anyway books as a second piece. Two scans read
 * 3/3 on DASAN USA; eleven read 10/11 on GEM SHOPPING. Matches the gun's
 * window, so both entry routes pair identically.
 */
export const CAMERA_PAIR_WINDOW_MS = 2500;
/** How often the window is checked when no further barcode ever decodes. */
const CAMERA_TICK_MS = 400;

const NATIVE_DETECT_INTERVAL = 60; // ms, ~16 fps — lets autofocus settle
const NATIVE_ZOOM_TARGET = 1.8;

/** Both symbologies must be supported, not just one. */
export async function detectNativeSupport() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    return !!fmts && fmts.includes('code_128') && fmts.includes('code_39');
  } catch {
    return false;
  }
}

function loadQuagga() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Quagga) return Promise.resolve(window.Quagga);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QUAGGA_CDN;
    s.async = true;
    s.onload = () => (window.Quagga ? resolve(window.Quagga) : reject(new Error('Quagga did not register')));
    s.onerror = () => reject(new Error('Quagga failed to load — no signal at the dock?'));
    document.head.appendChild(s);
  });
}

/**
 * Start scanning.
 *
 * @param videoEl     <video> for the native path
 * @param containerEl <div> Quagga renders into
 * @param onPair      ({pro, og, engine}) for each complete piece
 * @param onPartial   ({pro, og}) so the UI can say "hold steady, need the OG"
 * @param onStatus    (string) human-readable engine/state line
 * @param onRaw       (string[]) EVERY value the decoder returned, classified or
 *                    not. The dock has no console, so without this "the scanner
 *                    doesn't work" cannot be told apart from "it read something
 *                    the rules rejected".
 * @returns { stop, engine }
 */
export async function startScanner({ videoEl, containerEl, onPair, onPartial, onStatus, onRaw, onOrphan }) {
  const useNative = await detectNativeSupport();

  // Which engine is live, for the scan rows an expiry emits. Set before each
  // engine starts, so a fallback re-labels it.
  let engineLabel = useNative ? 'native' : 'quagga';

  const buffer = createPairBuffer({
    windowMs: CAMERA_PAIR_WINDOW_MS,
    onAbandon: (half) => {
      // A PRO that outlived the window with no piece id IS a piece — the WMS
      // rule, kept. It goes down the same path as any camera piece, where the
      // no-OG gates decide: mint a NOOG id, or refuse loudly if this PRO is
      // already accounted for.
      if (half.kind === 'pro' && half.reason === 'expired') {
        onPair?.({ pro: half.value, og: null, engine: engineLabel });
        return;
      }
      // A half superseded by a DIFFERENT label mid-pair is worth a word — the
      // gun says the same. A lone piece-id glimpse that quietly expires is
      // camera panning noise, and stays silent.
      if (half.reason === 'superseded') onOrphan?.(half);
    },
  });

  const emit = (values, engine) => {
    engineLabel = engine;
    onRaw?.(values);
    const hit = buffer.push(values);
    if (hit) onPair?.({ ...hit, engine });
    else onPartial?.(buffer.state());
  };

  // The window must close on the CLOCK, not only on the next decode: a PRO
  // whose OG never reads has to book its fallback even if nothing else ever
  // decodes — the loader may already be walking away.
  const tick = setInterval(() => {
    buffer.tick();
    onPartial?.(buffer.state());
  }, CAMERA_TICK_MS);

  const wrap = (stop) => () => {
    clearInterval(tick);
    // A pending half is NOT discarded on the way out. The loader scanned that
    // label — closing the camera (or switching to the gun) must not silently
    // eat it. Forcing the window closed books a lone PRO through the normal
    // fallback gates and announces a lone piece-id like any other expiry.
    buffer.tick(Date.now() + CAMERA_PAIR_WINDOW_MS + 1);
    buffer.reset();
    stop();
  };

  try {
    if (useNative) {
      try {
        engineLabel = 'native';
        const stop = await startNative({ videoEl, emit, onStatus });
        return { stop: wrap(stop), engine: 'native' };
      } catch (e) {
        console.error('[scanner] native path failed, falling back', e);
        // fall through — a broken native path should not leave the driver with no scanner
      }
    }
    engineLabel = 'quagga';
    const stop = await startQuagga({ containerEl, emit, onStatus });
    return { stop: wrap(stop), engine: 'quagga' };
  } catch (e) {
    clearInterval(tick);
    throw e;
  }
}

// ── Native (BarcodeDetector) ─────────────────────────────────────────────────

async function startNative({ videoEl, emit, onStatus }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', '');
  videoEl.playsInline = true;
  videoEl.muted = true;
  await videoEl.play();

  // Android autofocus + slight zoom — the real reason close labels wouldn't lock.
  let zoomApplied = null;
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (caps.zoom && typeof caps.zoom.max === 'number') {
      zoomApplied = Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, NATIVE_ZOOM_TARGET));
      adv.push({ zoom: zoomApplied });
    }
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch {
    /* capability probing is best-effort; scanning still works without it */
  }

  onStatus?.(`native detector${zoomApplied ? ` · zoom ${zoomApplied.toFixed(1)}x` : ''}`);

  const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39'] });
  let running = true;
  let busy = false;
  let lastAt = 0;
  let interval = null;

  const frame = async () => {
    if (!running) return;
    const now = performance.now();
    if (!busy && videoEl.readyState >= 2 && now - lastAt >= NATIVE_DETECT_INTERVAL) {
      busy = true;
      lastAt = now;
      try {
        const codes = await detector.detect(videoEl);
        // EVERY barcode in the frame, not just the first — this is the port's
        // behaviour change and the reason one gesture can capture a whole piece.
        if (codes.length) emit(codes.map((c) => c.rawValue), 'native');
      } catch {
        /* a dropped frame is normal; keep looping */
      }
      busy = false;
    }
    if (!running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) videoEl.requestVideoFrameCallback(frame);
  };

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) videoEl.requestVideoFrameCallback(frame);
  else interval = setInterval(frame, 150);

  return () => {
    running = false;
    if (interval) clearInterval(interval);
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* already gone */
    }
    videoEl.srcObject = null;
  };
}

// ── Quagga2 (iOS Safari) ─────────────────────────────────────────────────────

async function startQuagga({ containerEl, emit, onStatus }) {
  const Quagga = await loadQuagga();
  containerEl.innerHTML = '';

  await new Promise((resolve, reject) => {
    Quagga.init(
      {
        inputStream: {
          name: 'Live',
          type: 'LiveStream',
          target: containerEl,
          constraints: {
            facingMode: 'environment',
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            aspectRatio: { ideal: 16 / 9 },
            focusMode: 'continuous',
            advanced: [{ focusMode: 'continuous' }, { focusMode: 'auto' }],
          },
          // WHOLE FRAME. This was { top: '15%', bottom: '15%' }, which threw
          // away the top and bottom bands of every frame — and on a Uline label
          // held close the OG barcode sits right at the top edge, so it could
          // never be decoded and the pair never completed. The driver saw
          // "point at a label" while pointing straight at one.
          //
          // The cost is CPU on a frame with nothing in it. That is the right
          // trade: a missed decode is a truck loaded wrong.
          area: { top: '0%', right: '0%', left: '0%', bottom: '0%' },
        },
        locator: { patchSize: 'medium', halfSample: true },
        numOfWorkers: navigator.hardwareConcurrency || 4,
        // multiple:false, matching the WMS scanner that works on these phones.
        // We no longer need both barcodes in one frame, and Quagga2's multiple
        // mode is markedly less reliable on a close-held label.
        decoder: { readers: ['code_128_reader', 'code_39_reader'], multiple: false },
        locate: true,
        frequency: 20,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  Quagga.start();
  onStatus?.('Quagga2 · iOS path');

  const qVid = containerEl.querySelector('video');
  if (qVid) qVid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;z-index:1;';
  containerEl.querySelectorAll('canvas').forEach((c) => {
    c.style.display = 'none';
  });

  // Confidence gating, preserved from the source: clean reads go straight
  // through, borderline reads must repeat, noisy reads are discarded.
  const pending = new Map(); // code -> consecutive count

  const gate = (code, decodedCodes) => {
    const errors = (decodedCodes || []).map((d) => d.error).filter((e) => e !== undefined);
    const avgError = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    if (avgError < 0.15) {
      pending.delete(code);
      return true;
    }
    if (avgError < 0.35) {
      const n = (pending.get(code) || 0) + 1;
      pending.set(code, n);
      if (n >= 2) {
        pending.delete(code);
        return true;
      }
      return false;
    }
    return false; // > 0.35 is too noisy to trust
  };

  const handler = (result) => {
    // With multiple: true Quagga2 reports result.barcodes; keep the single-result
    // shape working too, so a version change degrades instead of breaking.
    const list = Array.isArray(result?.barcodes) ? result.barcodes : result?.codeResult ? [result] : [];
    const accepted = [];
    for (const r of list) {
      const code = r?.codeResult?.code;
      if (!code) continue;
      if (gate(code, r.codeResult.decodedCodes)) accepted.push(code);
    }
    if (accepted.length) emit(accepted, 'quagga');
  };

  Quagga.onDetected(handler);

  return () => {
    try {
      Quagga.offDetected(handler);
    } catch {
      /* older builds lack offDetected */
    }
    try {
      Quagga.stop();
    } catch {
      /* already stopped */
    }
    containerEl.innerHTML = '';
  };
}
