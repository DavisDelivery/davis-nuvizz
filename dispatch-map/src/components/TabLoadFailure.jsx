// src/components/TabLoadFailure.jsx — what a tab shows when its lazily loaded code did not arrive.
//
// TWO TABS FETCH THEIR CODE THE FIRST TIME THEY OPEN: Routing → Shadow (Chad, 2026-09-27, "12 yes"
// to loading the Shadow's code only when its tab opens) and Quote (its console, lazy since it was
// embedded). Each is a React.lazy import, and the app has NO error boundary — so an import that
// REJECTS throws into render and React unmounts the WHOLE app: a white page, with whatever screen
// was behind it. So each import carries a .catch that hands React.lazy this screen instead: the
// line, a Reload button, and what the browser said. When the code loads, the .catch never runs
// and none of this exists.
//
// An import rejects when the file could not be FETCHED (a dropped connection, or a file the site
// no longer has) AND when the file arrived but its code failed — which reloading the same build
// does not fix. So the error is logged, and what the browser said is printed under the button
// (src/lib/load-failure.js): a phone or an iPad has no console anyone can open, and a screenshot
// is what carries it.
//
// WHO THE SCREENSHOT GOES TO is the app's existing phrase for a failure nobody on the screen can
// fix: Chad (PasswordScreens.jsx: "Reload the page; tell Chad if it happens again."; App.jsx's
// SignInRequiredScreen; AccountScreen.jsx; LoginScreen.jsx).
//
// NEVER THROWS. It runs inside the import's .catch; a throw there would reject the lazy import
// after all, and the white page is back.
import React from 'react';
import { loadFailureDetail, TAB_LOAD_FAILURE_TAIL } from '../lib/load-failure.js';

/**
 * The module React.lazy renders when a tab's code did not load: `{ default: <failure screen> }`.
 * Logs the error it was given first, so DevTools has it too.
 *
 * @param {string} tab  the tab's name as its button reads ("Shadow", "Quote")
 * @param {unknown} err  whatever the import() rejected with
 */
export function tabLoadFailed(tab, err) {
  const name = typeof tab === 'string' ? tab.trim() : '';
  try {
    console.error(`[${name ? name.toLowerCase() : 'tab'}] ${name ? `the ${name} tab` : 'a tab'} failed to load`, err);
  } catch {
    // A console that throws must not take the screen down with it.
  }
  const detail = loadFailureDetail(err);
  const line = `${name ? `The ${name} tab` : 'This tab'} ${TAB_LOAD_FAILURE_TAIL}`;
  return {
    default: function TabLoadFailure() {
      return (
        <div className="p-6 text-sm text-slate-700">
          <p>{line}</p>
          <button onClick={() => window.location.reload()} className="mt-3 min-h-[44px] px-3 rounded border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50">Reload</button>
          <p className="mt-3 text-xs text-slate-500 break-words">If a reload does not fix it, send Chad a screenshot of this screen. What the browser said: {detail}</p>
        </div>
      );
    },
  };
}
