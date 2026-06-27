// Dispatch Map — Davis Delivery Service
// Single-file React app per build brief. Helpers (firebase init, match-key normalizer)
// live in src/lib/ since they're pure utilities, not React.
//
// Milestones live here:
//   M1: read-only map fed by /.netlify/functions/nuvizz-pull-today-stops
//   M2: customer_notes Firestore layer + edit form + colored markers + filter panel
//   M3: diagnostics page (STUB ONLY — see <DiagnosticsScreen/>)
//   M4: live Motive driver overlay (toggle)
//   M5: route polylines — not implemented this session, see HANDOFF.md

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Loader as GoogleMapsLoader } from '@googlemaps/js-api-loader';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import {
  MapPin, RefreshCw, X, Filter, Truck, Save, Plus, Trash2,
  Activity, ChevronDown, ChevronUp, Eye, EyeOff,
  Search, Tag, Tags, ArrowLeft, Gauge, Clock, MapPinned,
  Info, Settings, LayoutList, Sparkles, MessageSquare, Square, Lasso, AlertTriangle, Ban, Send, Package,
  FileCheck, ExternalLink, Image as ImageIcon, Printer, FileText,
} from 'lucide-react';
import {
  collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp,
  query, orderBy, limit, updateDoc, deleteDoc,
} from 'firebase/firestore';

import { db } from './lib/firebase.js';
import { normalizeMatchKey } from './lib/matchKey.js';
import { addressLooksOff, suggestAddressFix } from './lib/address-fix.js';
import { haversineMiles, naiveEtaMinutes, formatEtaClockTime } from './lib/distance.js';
import { todayInET, isTodayET, formatDateForDisplay, formatDateLong } from './lib/date-util.js';
import { pointInPolygon, latLngInBounds, boxFromCorners, formatReceivingHours, lineItemDims, moveItem, recomputeRoute, resequence, fmtTime12, DEFAULT_SERVICE_SEC } from './lib/routing-select.js';
import { formatDateTime, tsToMillis, loadSummary, buildLoadAutoName } from './lib/routing-loads.js';
import { scanStop, scanStopFull } from './lib/signal-scanner';
import { applyScannerResults } from './lib/customer-notes-writer';
import { aiParse, aiChat, applyFilterSpec, summarizeSpec, buildTrimmedStops } from './lib/ai-search.js';
import ChatPanel, { ChatLauncher, MessagesLauncher } from './components/ChatPanel.jsx';
import MessagesPanel from './components/MessagesPanel.jsx';

// Vite's tree-shaker considers function-only imports from .ts files to be
// pure; it eliminates them even though they're called from useAutoScanner's
// useEffect (which only fires after notesReady + stops load). Exposing the
// entry points on window keeps the import chain observed so the bundle
// retains the scanner + writer. Doubles as a QA hook —
// window.__DD_SCANNER__.scanStop(...) lets QA test patterns in DevTools.
if (typeof window !== 'undefined') {
  window.__DD_SCANNER__ = { scanStop, scanStopFull, applyScannerResults };
}

// ---------- constants ----------

const APP_VERSION = '0.29.49';

// No auth — see firebase.js. customer_notes writes are stamped with this
// hardcoded identity until we wire up a real per-user signal (out of scope
// for v0.3.0; Glory Bound Dispatch / MarginIQ don't track this either).
const NOTES_UPDATED_BY = 'dispatcher';
// eslint-disable-next-line no-undef
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
// eslint-disable-next-line no-undef
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
// eslint-disable-next-line no-undef
const BUILD_CONTEXT = typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev';
// Short commit for the build badge: the real 7-char hash on a Netlify build, or
// 'local' in dev (the vite fallback is 'dev'). Never blank / 'undefined'.
const BUILD_SHORT = BUILD_COMMIT && BUILD_COMMIT !== 'dev' ? BUILD_COMMIT.slice(0, 7) : 'local';

// Beta version history — shown when the dispatcher taps the build badge, so it's
// easy to keep up with what changed. Newest first; APP_VERSION (top) is highlighted.
// Keep this curated + short (one line each); append a row on each release.
const VERSION_LOG = [
  ['0.29.49', 'Print Manifest pagination: the first printed page is now the summary plus the first delivery ticket, and every page after that is exactly one delivery ticket (a ticket is never split across two pages). Verified against a real print-to-PDF.'],
  ['0.29.48', 'Each route now has a "Print Manifest" button (in the route detail panel, on both the map and mobile): it prints the whole route as one job — a summary cover page (route name, origin, requested window, stop count, driver, and the freight totals: weight · loose · pallets · total pieces) followed by every stop\'s Delivery Ticket in route-delivery order, one per page. Recreates the NuVizz driver manifest, generated entirely from the order data we already have — no extra NuVizz call.'],
  ['0.29.47', 'Empty loads now show on the Loads tab: a load that\'s been created for the day but has no orders assigned yet (e.g. Monday\'s loads waiting to be filled) appears with a "No orders yet" status badge, pulled from the day\'s load roster. Also: orders pulled on Sunday but requested for Tuesday now correctly board on Tuesday, never Monday; and the weekend scan window is extended (Friday scans run until 11 PM, Sunday scans resume at 7 PM) now that API call volume is low.'],
  ['0.29.46', 'Mobile Stops list rows now show more at a glance: the street address, the driver, skids + loose pieces, and a Scheduled/Delivered (or Arrived/Out-for-delivery/Exception) status badge — on top of the business name, city, and PRO that were already there.'],
  ['0.29.45', 'Delivery Tickets now print in portrait (Letter) instead of landscape.'],
  ['0.29.44', 'Loose pieces (NuVizz "volume") now shows as its own column in the data tables: the bottom Stops/Loads grid and the Routing tab\'s selected-stops tables all get a "Loose" column next to Skids/Pallets, so you can see skids, loose pieces, and total pieces at a glance. (The stop detail card already showed loose under Items.)'],
  ['0.29.43', 'The "Delivery Ticket" button now opens the actual NuVizz Delivery Ticket (the per-stop manifest — sequence + Drop Off/Pick Up, Ship-To, requested window, the weight/loose/pallets/total-pieces summary, the PO line-item table, every special-instruction comment with who/when, signature + driver-comment lines, and the Next-Stop ETA) instead of the Bill of Lading. Generated from the order data we already have — no extra NuVizz call. Plus: the PRO number at the top of the stop card is bigger, and the Items list moved up directly under the address.'],
  ['0.29.42', 'Renamed the "Bill of Lading" button on the stop card to "Delivery Ticket" (the document it opens is unchanged — the same NuVizz-matched printable).'],
  ['0.29.41', 'Three things: (1) Printable Bill of Lading — every order now has a "Bill of Lading" button on its stop card that opens a print-ready BOL that copies NuVizz\'s exactly (Davis logo, header, Ship-To/Buyer, special instructions, line items with class/weight, skid/loose/total-piece totals, signature line). Built from the order data we already have — no extra NuVizz call. (2) Routing screen freight now uses the corrected mapping everywhere — skids, loose pieces, total pieces, and truck-capacity (max skids) math all read the right NuVizz fields, so routes no longer over-fill. (3) The Davis Delivery Service logo now appears throughout the app (top header, version panel, and the BOL).'],
  ['0.29.40', 'Stop card: (1) Freight labels corrected — NuVizz mislabels its fields, so the Items breakdown now reads them as their real meaning: the field NuVizz calls "cartons" is shown as PALLETS, "volume" as LOOSE pieces, and "pallets" as TOTAL pieces (pallets + loose). A stop now reads e.g. "1 pallet · 2 loose pcs · 3 total pieces". (2) Proof-of-delivery photos and documents (BOL) now open in an in-app viewer WITH a Close button — before, tapping one filled the screen with no way back inside the installed app. (3) The "Refresh from NuVizz" button is now a clean full-width button instead of floating to the right.'],
  ['0.29.39', 'Stop card fixes: (1) the status badge now updates when you Refresh or open the timeline — a delivered order the board still shows as "Scheduled" flips to "Delivered" once its real status comes back from NuVizz (the header badge was stuck on the stale board value). (2) Loose pieces: NuVizz\'s "volume" field — how Davis records loose pieces — is now pulled in and shown in the Items section (Skids / cartons / loose pcs). (3) The "View delivery photo" button (added last version) lives in the Proof of delivery section of the stop card.'],
  ['0.29.38', 'Delivery photos: opening a delivered order now shows a "View delivery photo" button under Proof of delivery — it pulls the driver\'s captured photo on demand (the photo from the DOCUMENT CAPTURE timeline events). NuVizz exposes these capture photos in a separate place from the signed POD, which is why the proof-of-delivery section used to come up empty; the card now reads both. Plus: closing a stop from the map (left list or the detail panel) zooms the map back out to where it was before you opened the order.'],
  ['0.29.37', 'Routing (beta) now IS the dispatch Map: the map shows the exact same rich markers — status colors, priority-flag colors, AM/PM tags, "address looks off" flags, equipment / receiving-hours restriction icons, and DNS pins — instead of plain gray dots. Selected stops pop orange and routed stops become numbered route-colored pins. Added the same collapsible Stops/Loads data grid along the bottom; tap a row to frame it and add it to the route, or tap a load to select all of its stops.'],
  ['0.29.36', 'Routing (beta) map now matches the dispatch Map: same satellite imagery + road labels (hybrid) and the same vector map style, instead of the plain green roadmap base.'],
  ['0.29.35', 'Historical PRO lookup: tap the NuVizz result to open a full stop card — a centered window over the map with all of the order\'s detail (address + Street View / Maps / web links, status & activity timeline, line items, delivery photos, route/driver). Uses the data the lookup already pulled, so no extra NuVizz call.'],
  ['0.29.34', 'Fix: make the load-ID anchor actually work. The load-roster request sent the date filter as an object; the NuVizz openapi endpoint requires it as a JSON string and was rejecting the call (HTTP 400) — so the anchor silently did nothing. Verified live: the corrected request returns the day\'s loads with their unique IDs. With NUVIZZ_LOAD_ANCHOR=on, the next scan drops yesterday\'s stops that were being carried onto today.'],
  ['0.29.33', 'Scan: optional load-ID anchor (off by default, NUVIZZ_LOAD_ANCHOR=on). Recurring routes (e.g. "BEN 2") reuse the same NAME daily but each day\'s instance has its own unique load ID; the scan can now pull the day\'s authoritative load roster and drop any board stop whose load ID belongs to a prior day — a second, identity-based guard against yesterday\'s stops bleeding onto today. Best-effort: a load-list hiccup leaves the board untouched.'],
  ['0.29.32', 'Fix: today\'s board no longer doubles with yesterday\'s completed stops. The list-discovery scan was stamping every stop from its multi-day window onto the queried day, so prior-day DELIVERED / unable-to-deliver stops bled onto today (≈700 extra). Those finished stops now stay on their own day; today shows only today\'s work plus genuinely-open carryover.'],
  ['0.29.31', 'Proof-of-delivery photos are now viewable: a delivered order\'s stop card shows a thumbnail gallery of the driver\'s delivery photos (tap to open full size). Pulled securely server-side from NuVizz. The activity timeline also now shows each event\'s GPS location as a tappable map link.'],
  ['0.29.30', 'Stop notes + activity timeline now load ON DEMAND when you open an order (no background backfill) — open a stop, or tap "Refresh from NuVizz", to fill in its full notes and timeline. New orders get their full notes automatically on first sync.'],
  ['0.29.29', 'Stop card upgrade: opening an order now shows its FULL NuVizz notes (every comment — order instructions, pre-visit, billing — with who added it and when), a "Refresh from NuVizz" button that re-pulls the order on demand, and a collapsible Activity Timeline (Stop Planned / Departure / Dispatched / Updated, with the By: and From:). Plus fixes: rolled-over undelivered orders now stay on TODAY\'s route instead of dropping off, and the map route lines no longer crisscross.'],
  ['0.29.28', 'Loads: added a % delivered figure on each load in the Loads list and on the load detail header (green at 100%). The load detail now also shows each stop\'s address under the business name.'],
  ['0.29.27', 'Mobile: swapped the "Drivers" tab for "Loads". The bottom-nav and bottom-sheet tab now lists the day\'s loads (route/load #, driver, delivered-of-total, pallets, weight); tapping a load opens its route detail. Live driver pins on the map are unchanged.'],
  ['0.29.26', 'Messages on mobile: the texting window now sizes to the visible screen, so the keyboard no longer hides the message box and Send button — you can actually type and send a text on a phone. Same fix keeps the conversation above the keyboard in every view.'],
  ['0.29.25', 'Messages, rebuilt (iOS-style). The texting window is now a real messaging app: a searchable conversation list with avatars, names, role tags and unread dots; a "New message" button that opens a CONTACT PICKER split into Drivers / Contractors / Customers / Team (drivers + contractors come from the employee roster via a new /messaging-roster endpoint) plus Recent and "text any typed number"; and a conversation view with iMessage-style bubbles, grouped time stamps, a pill composer, instant (optimistic) send and tap-to-retry on failures. You can now START a text to anyone, not just reply to people who texted first.'],
  ['0.29.24', 'Cleaner buttons: the floating message-bubble icon (desktop + mobile) now opens TEXTING, and the AI assistant moved to a "?" button next to it. On mobile the texting window is full-screen (iOS-style) with notch/home-bar safe spacing; on desktop it stays a side drawer over the map. The message button shows an unread badge.'],
  ['0.29.23', 'Texting — two-way conversations. Messages now opens as a window OVER the map (no more leaving the screen; fixes the blank-screen bug). It shows full back-and-forth threads per customer/driver — your sent texts and their replies together — with an inline reply box. Inbound replies are matched to a customer (from saved contacts) or driver (from MarginIQ) by phone, and driver threads are tagged. New: "Text drivers" from the box/lasso selection texts the drivers of the selected stops at once.'],
  ['0.29.22', 'Fix: a previously-undelivered order rolled back to unplanned and re-added to today\'s load now shows on the driver\'s route. The scan was dropping any load member whose own delivery date wasn\'t today; for a load that started today we now keep all its members (rolled-in older orders included), so a stop like Paulsen Foods on Rasko\'s load appears. No extra NuVizz calls — that stop was already in the load data we fetch. Genuine multi-day carryover loads are unaffected.'],
  ['0.29.21', 'Texting Stage 2 — text drivers. The driver panel now has a "Text driver" button; the driver\'s mobile number is pulled from their MarginIQ employee card (matched by name) on the server, so numbers stay private. Works on desktop + mobile.'],
  ['0.29.20', 'Texting Stage 3 — inbound replies. New "Messages" tab shows customer text replies (newest first, matched to a customer name by phone when known), with a Reply button and an unread badge. Replies arrive via a SimpleTexting webhook into the app.'],
  ['0.29.19', 'Texting fix: the "Text customer" button now always shows in a stop\'s detail (desktop + mobile) even when no phone is on file — you can type/confirm the number right in the compose box. Previously it was hidden whenever a stop had no saved number, so it looked missing on mobile.'],
  ['0.29.18', 'Texting is now active — the SimpleTexting account is connected, so the "Text customer" and "Text selected" buttons send real messages from our number.'],
  ['0.29.17', 'Texting (SMS) via SimpleTexting — Stage 1 (outbound). New "Text customer" button in stop detail and "Text selected" in the box/lasso selection toolbar; both open a compose box and send via our number. Customer number = notes contact, falling back to the NuVizz scan contact. Server send endpoint has a daily send cap. Requires SIMPLETEXTING_API_KEY (and optional SIMPLETEXTING_FROM) env vars. Next stages: text drivers + inbound replies inbox.'],
  ['0.29.16', 'New per-customer "Email customer service when scheduled" toggle in notes. When the scan finds an opted-in customer on a day\'s board, it emails CS once (the first time that customer appears that day, deduped) from our no-reply account via Resend. Requires RESEND_API_KEY + RESEND_FROM + NOTIFY_CS_TO env vars to be set.'],
  ['0.29.15', 'DNS "Drivers not allowed" picker now lists the FULL driver roster from Motive (the fleet app), so you can bar ANY driver — not just ones on today\'s board or currently on the live map. New read-only /motive-drivers endpoint (server-cached ~1h); merged with today\'s board drivers and de-duped.'],
  ['0.29.14', 'DNS "Drivers not allowed" picker now always has drivers to choose from: it lists every driver assigned to the current board\'s loads (from the scan), not just the live Motive feed — which only loaded when "Show drivers (live)" was on for today. Fixed the misleading "Open the Drivers tab" hint too.'],
  ['0.29.13', 'Desktop: the "Search past PROs / customer history" button is now in the left sidebar (under the search box) — previously it existed only on mobile. Opens the same saved-delivery-history lookup as an overlay, prefilled with whatever is already typed in the live search.'],
  ['0.29.12', 'Fix: planned orders no longer show as "Unplanned". NuVizz keeps a stop at status-10 even after it has been put on a load (planned but not yet dispatched); the order/unplanned scan was re-tagging those load-assigned stops as unplanned, overwriting the load scan. The unplanned descent now excludes any stop that already carries a load number, so planned-but-not-started orders stay planned.'],
  ['0.29.11', 'Unplanned stop pins recolored to thistle (light purple) per dispatch request.'],
  ['0.29.10', 'Map pins: planned and unplanned stops now render at the same smaller size (only search-matched / AM-PM-tagged pins are enlarged for emphasis), and unplanned stops are tinted mint instead of blue so they read distinctly on satellite.'],
  ['0.29.9', 'NuVizz scan politeness + learning (addresses their "1000+ calls in a single minute" notice). (1) Probe concurrency is throttled (was firing ~30 load lookups in parallel = a burst) and is now env-tunable, so a scan SPREADS its calls over time instead of hammering NuVizz at once. (2) New scan-discovery monitoring records, every scan, how many loads were found, how many were NEW vs the prior day, and the largest gap between load numbers — surfaced as a learned summary (avg/max new-loads/day, worst gap, recommended look-ahead) so we can safely switch to a no-daily-seed incremental scan next, tuned from real data instead of guesses.'],
  ['0.29.8', 'Weekend call savings + a clearer call counter. (1) The nightly history-warehouse snapshot now skips Saturday & Sunday — it was archiving empty non-working days at full cost (~1,200 NuVizz calls each), which is why calls showed on a weekend even with the live scan off. Friday and Monday are still archived; on-demand backfill is unchanged. (2) The "calls today" counter now follows a normal midnight-to-midnight Eastern day instead of UTC, so after-midnight-UTC jobs (the ~2am ET snapshot) count on the right local day and a truly quiet day reads 0.'],
  ['0.29.7', 'Two additions: (1) Tap a customer in the historical search to open their full detail + notes editor. (2) New "DNS — do not send" control: a red/white DNS badge that shows everywhere the customer appears (map pin = red pin with ✕, stop list, stop detail, and historical search), plus a do-not-send toggle and a multi-select of which drivers are not allowed to that customer (from the app driver list). Saved per customer alongside the other notes.'],
  ['0.29.6', 'Historical customer search now matches a word ANYWHERE in the name, not just the start — searching “locksmith” now finds “SOLID LOCKSMITH” (before, only “solid…” worked). Multi-word searches must match all words. (Built on per-customer name word-tokens; still reads only our saved history, no NuVizz call.)'],
  ['0.29.5', 'Historical customer/PRO search now actually finds everyone. It used to read only a sparse local cache (built just for customers with special receiving rules, off the live board — empty on weekends), so a customer like a locksmith we delivered Friday wouldn’t show up. It now searches our own saved delivery-history warehouse (every delivery, every day → each customer’s last 20 PROs), so business-name and PRO searches find any customer we’ve delivered to — and still WITHOUT calling NuVizz (it reads our own data; only an unknown PRO triggers the explicit one-call lookup).'],
  ['0.29.4', 'Fixes the mobile screen "shifting" — the app sliding partly off the left edge with a white gap on the right (seen when opening the past-PRO search). On iOS, focusing a field can scroll the VISIBLE viewport sideways inside the slightly-wider layout viewport; the app shell stayed anchored to the layout edge and slid off-screen. The shell is now pinned to the visible viewport’s actual position, so it always stays squared to the screen no matter what the keyboard/focus does.'],
  ['0.29.3', 'New "Search past PROs / customer history" button on the mobile Stops tab. Tap it to look up a historical PRO or a customer by business name against the saved 20-stop history we keep per customer — no API calls for that. Searching a business name pulls up that customer’s last 20 PROs (with dates); searching a PRO number finds it across saved history. Business-name searches never call NuVizz. Only when you type a PRO that ISN’T in saved history do you get an explicit "Look up PRO in NuVizz (1 API call)" button — a single, deliberate, on-demand call you choose to make; nothing happens automatically.'],
  ['0.29.2', 'Mobile search no longer auto-calls AI: typing in the search box now just filters the loaded stops locally (live), and AI search is a separate, explicit action (the AI button) — pressing Enter dismisses the keyboard instead of firing AI. Also fixed the version (vX.Y.Z) menu being clipped/hidden behind the header.'],
  ['0.29.1', 'Fixes the right edge of the mobile app getting clipped (the last tab, the AI button, etc. cut off). On iOS the layout viewport can be a few pixels wider than the visible screen, and width:100% resolved to that wider value — pushing right-edge controls off the visible area. The app shell is now pinned to the live visible (visualViewport) width, so every control stays on-screen.'],
  ['0.29.0', 'Mobile is now a real full-screen app with a bottom tab bar (Map · Stops · Filters · Drivers), not a stack of half-height sheets over the map. Every view — the stops list + search, filters, drivers, stop detail + full editor, route detail, driver snapshot — fills the screen under a persistent header, so there’s no wasted empty space, nothing overlaps the map, and nothing hangs off the edge. The search works correctly: it stays at the top with the keyboard up so you can see what you’re typing, with results below; the tab bar stays put. Same features and data as desktop (full parity) — just laid out as a proper mobile app.'],
  ['0.28.3', 'Fixes the blank screen when you tap the search field on mobile. The page body was scrollable (a side effect of the overflow-x guard computing overflow-y to “auto”), so iOS scrolled the whole app up to the focused field, blanking everything above the keyboard. The app shell is now locked to the viewport (no page scroll/bounce); only the inner panels (sheets, lists) scroll. Verified across every mobile screen in Safari’s engine — map, Stops/Filters/Drivers drawers, stop detail + editor, route detail, driver snapshot.'],
  ['0.28.2', 'Mobile bottom sheets now fit their content — no more giant band of empty white space under a sparse stop. The sheet measures its content and sizes to min(content, ~⅔ screen): short stops open compact, while a long one (the full editor) caps at the screen fraction and scrolls with the Save bar pinned. Also hardened the Route row so the “View full route” button wraps instead of clipping. (Verified in Safari’s engine at multiple phone heights — both the content-fit and the cap-and-scroll cases.)'],
  ['0.28.1', 'Fixes the mobile right-edge clipping (status pill, filter rows, day buttons, item quantities, Save button all running off-screen). Root cause: iOS Safari was auto-inflating the small text beyond its set size, widening every row — now pinned with text-size-adjust:100% so the layout renders at the intended size. Also: the items list wraps cleanly (SKU/SEQ stacks under the product, quantity stays put), and focusing a field in the stop sheet now scrolls it into view above the keyboard so you can see what you’re typing. (Verified by rendering the real sheet in Safari’s engine at phone widths.)'],
  ['0.28.0', 'Mobile stop detail rebuilt for full desktop parity. The desktop sidebar and the mobile sheet now render the SAME shared components (one address/window/items/route block + one complete notes editor), so every edit option on desktop is on mobile and the two can never drift again. The mobile stop sheet is now a single scroll with one inline “Edit” that reveals the full editor — priority flag, AM/PM window, per-day receiving hours (with copy-to-weekdays), appointment required + notes, liftgate, equipment restrictions, dock type/notes, and contacts — instead of options split across tabs. Plus a mobile design-system sweep: Filters toggles no longer get pushed off the right edge, the header no longer clips under the notch, the date chip/status pill can’t overlap, long text wraps, modals/chat are keyboard-aware, and the stop sheet opens at a content-appropriate height (less empty space).'],
  ['0.27.37', 'Mobile formatting fixes: (1) the app header no longer tucks under the notch/Dynamic Island — it now grows by the safe-area inset (and viewport-fit=cover is enabled so all safe-area padding actually applies). (2) Focusing the search field no longer clips the bottom sheet under the header — the sheet is now sized to the keyboard-aware visible viewport instead of a fixed vh. (3) The date chip and the status pill now share one row so they can never overlap on a narrow phone. (4) A global guard prevents any stray over-wide element from pushing the FAB / right-aligned PRO badges off the right edge. (5) Long addresses wrap instead of widening the stop drawer.'],
  ['0.27.36', 'Scan-cost: weekend blackout (no scheduled scans Fri 10pm–Sun 8pm ET; manual still works) and a trimmed, env-tunable unplanned high-water buffer (200→150). Backend only — no UI change.'],
  ['0.27.35', 'Route order now matches NuVizz exactly. Routes are sequenced by NuVizz’s own stop-sequence number (the Route Workbench order) instead of a fallback that could scramble stops — most importantly for routes that haven’t started yet (no ETAs computed), which previously fell back to NuVizz’s raw array order and looked random. The numbered map pins AND the route detail list now use that same sequence value, so co-located orders at one stop share its number, exactly like the Workbench.'],
  ['0.27.34', 'Route view now matches NuVizz: opening a route (a) frames/centers the map on that route’s stops (and restores your prior view on close), and (b) numbers the stops on the MAP in delivery sequence (planned-ETA order) — green=delivered / blue=scheduled numbered pins, with the rest of the board dimmed — mirroring NuVizz’s numbered route pins + numbered list.'],
  ['0.27.33', 'Three fixes: (1) deselecting a stop now zooms/pans back out to the board view it had before you clicked in (was staying at building zoom). (2) The Loads table now lists the full board’s loads regardless of stop filters — "Unplanned only" no longer empties it. (3) Lean scan now gap-sweeps the load range DURING THE DAY, so loads you populate by routing mid-morning (route shells that gain stops after the overnight scan) are picked up promptly instead of lingering as stale "unplanned" — fixes routed orders still showing unplanned.'],
  ['0.27.32', 'Filters: new "Potential address issues" checkbox (shows stops the mis-split detector flags) and an "Any equipment restriction" checkbox (complements the specific-restriction dropdown, which it supersedes when on). Address detector broadened: it now flags a stop whose addr1 doesn’t start with a house number while addr2 does — e.g. a dock descriptor "MGE1 NON INVENTORY DOCK DR 178" with the real street "652 BROADWAY AVE" in addr2 (previously missed because addr1 contained digits). Normal addresses (addr1 starting with the house number) are never flagged.'],
  ['0.27.31', 'Auto-flag "CLOSED ON FRIDAYS/MONDAYS" (the Uline instruction format) — the closed-day scanner now also matches the optional "ON" and the plural "S", so e.g. "CLOSED ON FRIDAYS" auto-sets a red Closed-Fri badge on import (all 7 days). Address-fix is also more robust: if the Google Geocoding API is unavailable (REQUEST_DENIED), the corrected addr1/addr2 split is still saved and you can drag the pin via "Correct pin location" instead of losing the fix.'],
  ['0.27.30', 'Mobile status pill is now collapsible (like desktop) — collapses to just the stops count, and the expanded view now also shows the NuVizz call counter (today’s calls / ceiling + mode) alongside total pallets and the load/unplanned feed update times. Shares the collapse state with desktop.'],
  ['0.27.29', 'Address mis-split detection + one-click fix. NuVizz often puts the street in addr2 with a suite/dock/contact in addr1 (e.g. "BLDG 200" / "4310 INDUSTRIAL ACCESS RD"), so the geocoder lands on the wrong spot. Such stops now show an amber "!" pin and a "Address may be mis-split" banner on the stop card with "Fix & move pin" (one-click: swaps the lines, re-geocodes the clean street, saves the corrected address + pin) and "Edit…" (the modal, now with a suite/addr2 field, pre-filled with the suggestion). Detection is conservative and self-clears once corrected. Also adds a new "?" priority flag (indigo pin with a "?") alongside red/yellow/green.'],
  ['0.27.28', 'Bottom table: every column in both the Stops and Loads views is now sortable — click a header to cycle asc → desc (chevron shows the active column). Stops and Loads keep independent sort state. Numeric columns (Stop #, Pallets, Weight, stop count) sort numerically; the Loads Status column sorts by % delivered'],
  ['0.27.27', 'Bottom table: new Stops | Loads tab toggle. The Loads view groups the current board by loadNbr — one row per load with driver, stop count, a per-status breakdown, and pallet/weight totals. Click a load to open its route drawer and frame the map on that load’s stops'],
  ['0.27.26', 'Map fix: clicking a stop pin now recenters and zooms to STOP_ZOOM (18), matching the list/search behavior — the map-marker click handler was setting the selected stop without panning/zooming'],
  ['0.27.25', 'Incremental-scan Phase 6 (default OFF, flag NUVIZZ_TERMINAL_SKIP): terminal-stop skip cache — stops confirmed delivered (status 90/91) are immutable, so their stopNbr→expectedDate is persisted in Firestore (nuvizz_stop_terminal) and the unplanned /stop/info descent synthesizes them from cache instead of re-probing. Heuristics preserved exactly (synthesized probe carries the stored expected date); targets /stop/info, the dominant remaining call source'],
  ['0.27.24', 'Triple-check hardening (audit follow-ups): undelivered report counts code-less deliveries (deliveredDTTM/normalizedStatus) as delivered, and same-day deliveries on the window edge are surfaced as "indeterminate" (+ readErrors) instead of silently assumed on-time; lean history skips a HALTED (ceiling/kill-switch) index and re-scans; regression tests added for the call-counter merge shape and the day-scoped circuit-breaker expiry'],
  ['0.27.23', 'Incremental-scan Phase 5: undelivered / delivered-late / aged-out report + 91(manual)-vs-90(system) completion breakdown, derived from the multi-day history warehouse with zero NuVizz calls (read-only /nuvizz-undelivered-report endpoint)'],
  ['0.27.22', 'Phase 4 fix (audit): lean history path no longer references undefined scan result (would have thrown with the flag on); counts/timestamp derived from the index, and an empty index falls back to a fresh scan'],
  ['0.27.21', 'Incremental-scan Phase 4 (when lean is on): the daily history snapshot is built from the accumulated Firestore stop-index instead of a fresh NuVizz scan (~690 calls → ~0); late deliveries reconciled by the Phase 5 straggler watch'],
  ['0.27.20', 'Incremental-scan Phase 3 hardening (audit): the lean order descent now bounds on an UNPLANNED-only high-water (a high planned stop can no longer ratchet the floor past new orders) + wider safety buffer — closes an order-loss path before enabling'],
  ['0.27.19', 'Incremental-scan Phase 3 (behind NUVIZZ_LEAN_DISCOVERY, default OFF): unplanned/order descent only probes NEW stop numbers above the persisted high-water on warm cycles; writeStops preserves older still-unplanned orders so the lean descent never prunes them'],
  ['0.27.18', 'Incremental-scan Phase 2 hardening (independent audit): lean scans no longer calibrate the fallback window, and cold-start now uses the proven wide-window probe instead of a forward seed that could miss a day with non-contiguous load numbers'],
  ['0.27.17', 'Incremental-scan Phase 2 safety: lean (terminal-skip) load scans now PRESERVE already-delivered stops instead of pruning them (writeStops partialLoads) — closes a data-loss path before lean discovery can be enabled'],
  ['0.27.16', 'Incremental-scan Phase 2 (behind NUVIZZ_LEAN_DISCOVERY=on, default OFF): probe only known-active loads + forward buffer + periodic gap sweep instead of the ±600 window; terminal-skip; wide window stays the cold-start fallback'],
  ['0.27.15', 'Incremental-scan: routing window corrected to OVERNIGHT 20:00–07:00 ET (when routes are built) — shadow buffers tuned (+50 overnight / +10 daytime)'],
  ['0.27.14', 'Incremental-scan Phase 1 (shadow): records a per-day scan_state roster and logs what lean load-discovery WOULD probe vs the current wide window — no scan behavior change yet'],
  ['0.27.13', 'NuVizz call counter now accumulates (was stuck at 1/day) with a per-route breakdown; daily-ceiling breaker is day-scoped + has a monitor/enforce mode (default monitor); today’s call volume shown in the status card'],
  ['0.27.12', 'Priority flag now drives the marker color in ALL cases — a flagged stop shows the flag color even when it renders a receiving-hours/restriction icon (the icon is recolored to the flag hue)'],
  ['0.27.11', 'AM/PM pin takes the priority-flag color when a flag is set (e.g. red flag → red AM pin); pin tag text stays legible on light flags'],
  ['0.27.10', 'Unplanned pins are now bright blue for satellite contrast; customer-notes editor no longer loses in-progress edits when a background note write lands mid-edit'],
  ['0.27.9', 'Unplanned pins are now solid slate (was hollow white — better contrast on satellite) and a touch smaller'],
  ['0.27.8', 'Customer notes: AM/PM "Delivery window" tag — tagged stops show an AM/PM pin on the map'],
  ['0.27.7', 'Order detail: "Find business" now opens a general Google search (name+address); removed the redundant Maps-search button (the "Google Maps" link still opens the map)'],
  ['0.27.6', 'Edit address: correct a mis-entered address — it re-geocodes and moves the pin for that customer (also restores the mobile pin-correct button)'],
  ['0.27.5', 'Order detail: added a "Find business" search link (business name + address)'],
  ['0.27.4', 'Order detail: "Find business" button (Maps search by name+address) + collapsible per-order items list (SKU/qty/weight/oversize)'],
  ['0.27.3', 'Date picker no longer shows the date twice; status card stacks its details and is collapsible to reclaim map space'],
  ['0.27.2', '“Scan now” runs the async scanner + polls (a busy date exceeded the 26s sync cap), so it never times out'],
  ['0.27.1', '“Scan now” refreshes just the viewed date (loads + orders) so it can’t time out'],
  ['0.27.0', 'Scan scheduler: elapsed-time cadence (fires on schedule despite cron jitter) + tomorrow’s orders scanned 10am–midnight + structured [scan] logs + daily-limit banner'],
  ['0.26.0', 'NuVizz scan schedule (ET time-of-day gating ~14k/day) + working manual Scan-now + split load/order timestamps'],
  ['0.25.25', 'Map auto-refreshes from the DB index every 2 min (silent, visible-only) so a long-open tab stays current'],
  ['0.25.24', 'Default delivery pins use a brighter blue (#4285F4) so they read on satellite'],
  ['0.25.23', 'AI results: populate Stops list/table reliably, orange found-pins, cleaner chat formatting'],
  ['0.25.22', 'Clicking a customer zooms to building level (~18) instead of neighborhood level'],
  ['0.25.21', 'Bottom stops table is drag-resizable (grab the top handle); height persists'],
  ['0.25.20', 'Correct a stop’s pin location — drag + save a per-customer override that persists for future loads'],
  ['0.25.19', 'Map controls match the requested set: compass + 2D/3D tilt, zoom, pegman, custom recenter crosshair'],
  ['0.25.18', 'Bottom stops table: search box + status filter (Un-Planned/Planned/In-Transit/Completed/Cancelled)'],
  ['0.25.17', 'HOTFIX: app blank-screen crash — mapFilters referenced before declaration (carry-over fetch TDZ)'],
  ['0.25.16', 'Declutter map controls: drop the on-screen keypad + pegman/scale; keep zoom/rotate(spin)/type/fullscreen + Ctrl-drag 3D'],
  ['0.25.15', 'Compact map controls — icon-only Box/Lasso; Filters collapses to a label-width pill that expands on click'],
  ['0.25.14', 'Collapsible NuVizz-style stops data grid at the bottom of the dispatch map'],
  ['0.25.13', 'Carry-over unplanned (prior-day open orders) toggle + fix box/lasso selection (projection now ready)'],
  ['0.25.12', 'Box + lasso multi-select on the map — highlights and filters the selected stops'],
  ['0.25.11', 'Total pallets count (sum of NuVizz carton field) shown below the stop count'],
  ['0.25.10', 'Distinct route-line colors for every driver (golden-angle hue spread, no more repeats)'],
  ['0.25.9', 'Fix "Unplanned only" (use isPlanned, not driver-assigned) + rename driver toggle to "Show drivers (live)"'],
  ['0.25.8', 'Smaller plain (non-restriction) stop pins to cut map clutter'],
  ['0.25.7', '"Unplanned only" filter — show only unplanned deliveries (off = all); replaces "Show unplanned"'],
  ['0.25.6', 'Full Google Map controls (type/rotate/pegman/fullscreen/zoom) + 3D tilt-rotate via vector Map ID'],
  ['0.25.5', 'Click a stop in the list to center the map on it + Google Maps link alongside Street View on the stop card'],
  ['0.25.4', 'Stop card NuVizz instructions: strip SPL-INSTR-TEXT prefix + hide boilerplate DO NOT BREAKDOWN SKID'],
  ['0.25.3', '"Has receiving hours" filter matches raw NuVizz instructions directly (finds stops the scanner missed)'],
  ['0.25.2', 'Scheduled scan covers today + next business day (was today-only), so tomorrow’s board stays fresh'],
  ['0.25.1', 'Scanner load-number estimate: business-day anchor + self-calibration (fixes the scheduled scan missing a full day of loads)'],
  ['0.25.0', 'Single source of truth (staged): sole NuVizz scanner writes the canonical fleet index + shared daily-ceiling call counter & circuit breaker'],
  ['0.24.9', 'NuVizz call-volume fix: today-only refresh, */15 cron, narrower scan window'],
  ['0.24.8', 'Add NUVIZZ_SCANS_ENABLED kill switch for the scheduled stop-index scan'],
  ['0.24.7', 'Satellite view toggle + Street View link on stop card + raw NuVizz instructions on stop card'],
  ['0.24.6', 'Driver labels: drop misleading "No route assigned" (routes come from NuVizz, not Motive)'],
  ['0.24.5', 'Receiving-hours scan: strip SPL-INSTR-TEXT line prefixes so split RECEIVING HOURS + range parse'],
  ['0.24.4', 'Filter: "Has receiving hours" toggle — show every stop with receiving hours set'],
  ['0.24.3', 'Receiving hours: scan "RH"/"RECEIVING HOURS" Uline formats + chat reads raw order instructions'],
  ['0.24.2', 'AI chat: 12-hour AM/PM times + reads free-text dock/appointment notes for receiving hours'],
  ['0.24.1', 'Tractor Trailer Friendly — green positive equipment kind (manual; suppressed when No T/T set)'],
  ['0.24.0', 'AI Order Search — natural-language search box + chat panel over the loaded board'],
  ['0.23.1', 'Phase 3 growth-guard fix — no phantom spill / no criss-cross on dense builds'],
  ['0.23.0', 'Geographic truck assignment (no two-truck criss-cross) + green stop markers'],
  ['0.22.0', 'Strategy ordering fixed — placeholder windows no longer clobber Min-distance/Closest'],
  ['0.21.0', 'Appointment windows are advisory (flag, don’t spill)'],
  ['0.20.0', 'Build badge on the routing screen'],
  ['0.19.0', 'Drag-lasso, clickable PRO popups, per-load re-sequence, discard plan'],
  ['0.18.0', 'Shared live Loads — save / open / rename / dispatch across devices'],
  ['0.17.1', 'Route by skid count (deck length no longer blocks)'],
  ['0.17.0', 'Manual route reorder — drag + numbered stops, live map sync'],
  ['0.16.1', 'Build reliability — killed the hang, near-instant builds'],
  ['0.16.0', 'Desktop dispatch console (Setup · map · Stops/Loads/Result)'],
  ['0.15.0', 'Touch selection + per-stop intelligence + selected-stops list'],
  ['0.14.0', 'Routing (beta) tab + cheap-by-default engine'],
];

const BUFORD = { lat: 33.9719, lng: -84.0008 };
const BRAND = '#1e5b92';

const FLAG_COLORS = {
  red: '#dc2626',
  yellow: '#eab308',
  green: '#16a34a',
  question: '#6366f1',   // "?" flag — dispatcher-set "uncertain / look into this"
};
// Priority-flag values offered in the pickers (null = none).
const FLAG_OPTIONS = ['red', 'yellow', 'green', 'question'];
const ADDRESS_OFF_TINT = '#d97706';   // amber pin for an auto-detected mis-split address
const RESTRICTION_TINT = '#7c3aed';        // has restriction notes but no priority flag
const UNFLAGGED_TINT = '#4285F4';          // default delivery pin — bright blue, reads on satellite
const DRIVER_TINT = '#0f172a';             // M4 Motive driver pins

// M5.1 — stop execution-status visuals. Status is a SEPARATE channel from the
// note-flag pin colors (rule #3): SCHEDULED keeps the existing flag color, and
// every other state carries a distinguishing shape/glyph so it reads even where
// a status hue is close to a flag hue. `color: null` → fall back to flagColor.
//   glyph: null=white dot · 'check'=delivered · 'bang'=exception · 'arrow'=en route
const STATUS_META = {
  UNPLANNED:   { label: 'Unplanned',        color: '#6d28d9', hollow: false, glyph: null,    badge: '#6d28d9' },
  SCHEDULED:   { label: 'Scheduled',        color: null,      hollow: false, glyph: null,    badge: '#1e5b92' },
  OUT_FOR_DEL: { label: 'Out for delivery', color: '#2563eb', hollow: false, glyph: 'arrow', badge: '#2563eb' },
  ARRIVED:     { label: 'Arrived',          color: '#d97706', hollow: false, glyph: null,    badge: '#d97706' },
  DELIVERED:   { label: 'Delivered',        color: '#15803d', hollow: false, glyph: 'check', badge: '#15803d' },
  EXCEPTION:   { label: 'Exception',        color: '#dc2626', hollow: false, glyph: 'bang',  badge: '#dc2626' },
};

// Mirrors classifyStopStatus() in netlify/functions/lib/nuvizz-scan.mts so the
// client works on Firestore-cached docs scanned before this field existed.
// Prefers the server-computed normalizedStatus when present.
// M5.3 — NuVizz's authoritative route stop sequence (stop.to.seq), surfaced as
// `routeSeq` by the scanner. This is the exact Route Workbench order (1..N over
// physical stops; co-located orders share a number) and it's present even before
// a route starts / before ETAs are computed. Falls back to the raw field for
// Firestore docs cached before `routeSeq` existed.
function routeSeqOf(s) {
  if (typeof s?.routeSeq === 'number') return s.routeSeq;
  const t = s?.raw?.stop?.to?.seq;
  const f = s?.raw?.stop?.from?.seq;
  if (typeof t === 'number') return t;
  if (typeof f === 'number') return f;
  return null;
}

// M5.2/M5.3 — canonical "delivery order" comparator. Mirrors the polyline sort so
// the route detail list lines up 1:1 with what the line draws on the map. Primary
// key is NuVizz's own sequence number (routeSeq); plannedEtaDTTM only breaks ties
// between co-located orders that share a sequence, then loadStopSeq/stopNbr.
function compareByPlannedEta(a, b) {
  const as = routeSeqOf(a), bs = routeSeqOf(b);
  if (as != null && bs != null && as !== bs) return as - bs;
  if (as != null && bs == null) return -1;
  if (as == null && bs != null) return 1;
  const ae = a?.plannedEtaDTTM || a?.raw?.stopExecutionInfo?.to?.plannedEtaDTTM || null;
  const be = b?.plannedEtaDTTM || b?.raw?.stopExecutionInfo?.to?.plannedEtaDTTM || null;
  if (ae && be && ae !== be) return ae.localeCompare(be);
  if (ae && !be) return -1;
  if (!ae && be) return 1;
  const seqDiff = (a?.loadStopSeq ?? 0) - (b?.loadStopSeq ?? 0);
  if (seqDiff !== 0) return seqDiff;
  return String(a?.stopNbr || '').localeCompare(String(b?.stopNbr || ''));
}

// When NuVizz's real route sequence is available the polyline follows the true delivery
// order. But the live LIST feed carries NEITHER a route sequence NOR distinct per-stop ETAs
// (only a generic arrival window), so for un-enriched stops compareByPlannedEta collapses to
// stop-number order and the line crisscrosses. Detect that and fall back to a nearest-neighbor
// geographic chain so the line reads like a route, not a web. Best-effort only — enriching a
// stop via /stop/info restores NuVizz's authoritative routeSeq and the exact order returns.
function hasRealRouteSequence(stops) {
  const seqs = stops.map(routeSeqOf).filter((x) => x != null);
  if (seqs.length >= 2) return true;
  const etas = [...new Set(stops.map((s) => s?.plannedEtaDTTM).filter(Boolean))];
  return etas.length >= 2;
}
function nearestNeighborOrder(stops) {
  const pts = stops.filter((s) => s.lat != null && s.lng != null);
  const rest = stops.filter((s) => s.lat == null || s.lng == null);
  if (pts.length < 3) return [...stops];
  // Start from the most north-west stop for a stable, repeatable path, then always hop to
  // the closest unvisited stop (squared lat/lng distance — fine at metro scale).
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].lat - pts[i].lng > pts[start].lat - pts[start].lng) start = i;
  }
  const used = new Array(pts.length).fill(false);
  used[start] = true;
  const order = [pts[start]];
  let curr = start;
  for (let k = 1; k < pts.length; k++) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (used[j]) continue;
      const dlat = pts[curr].lat - pts[j].lat, dlng = pts[curr].lng - pts[j].lng;
      const d = dlat * dlat + dlng * dlng;
      if (d < bestD) { bestD = d; best = j; }
    }
    used[best] = true; order.push(pts[best]); curr = best;
  }
  return [...order, ...rest];
}
// True route order when NuVizz gives us a sequence; otherwise a geographic best-effort so
// the line doesn't crisscross. Used for the polyline AND the route detail list so they match.
function orderRouteStops(stops) {
  return hasRealRouteSequence(stops) ? [...stops].sort(compareByPlannedEta) : nearestNeighborOrder(stops);
}

function execArrivalTs(exec) {
  return exec.to?.arrivalDTTM || exec.to?.arrivalDttm || exec.arrivalDTTM || exec.arrivalDttm || exec.arrivedDttm || null;
}
function execDeliveredTs(exec) {
  return exec.to?.confirmedDTTM || exec.receiveDTTM || exec.confirmedDTTM || exec.completionDTTM || exec.completedDttm || exec.completionDttm || exec.confirmDTTM || exec.to?.completionDTTM || null;
}
// Mirrors classifyStopStatus() in netlify/functions/lib/nuvizz-scan.mts. Prefers
// the server-computed normalizedStatus when present. v0.11.8: bare status 50 with
// NO real exception signal + an arrivalDTTM is reclassified ARRIVED (parent-app
// normalize.js:80-89 precedent — driver-on-site paperwork issue, not a failure).
function classifyStopStatus(stop) {
  if (stop?.normalizedStatus && STATUS_META[stop.normalizedStatus]) return stop.normalizedStatus;
  const code = String(stop?.status ?? '').trim();
  const exec = (stop?.raw && stop.raw.stopExecutionInfo) || {};
  const arrival = stop?.arrivalDTTM || execArrivalTs(exec);
  const delivered = stop?.deliveredDTTM || execDeliveredTs(exec);
  const realException =
    exec.exceptionPresent === true ||
    (Array.isArray(exec.exceptions) && exec.exceptions.length > 0) ||
    !!(exec.cancellation && exec.cancellation.cancelDTTM);
  if (code === '90' || code === '91' || delivered) return 'DELIVERED';
  if (code === '80') return 'EXCEPTION';
  if (realException) return 'EXCEPTION';
  if (arrival) return 'ARRIVED';
  if (code === '40') return 'OUT_FOR_DEL';
  if (!stop?.isPlanned) return 'UNPLANNED';
  return 'SCHEDULED';
}

const EQUIPMENT_OPTIONS = [
  { value: 'no_tractor_trailer', label: 'No tractor trailer' },
  { value: 'uline_straight_truck', label: 'Uline: straight truck (advisory)' },
  { value: '26ft_max', label: '26ft max' },
  { value: 'no_53ft', label: 'No 53ft' },
  { value: 'box_truck_only', label: 'Box truck only' },
  { value: 'no_overhead_clearance', label: 'Low overhead clearance' },
  // Positive kind — set MANUALLY by the dispatcher (never auto-scanned). Renders
  // green to read as "this stop CAN take a tractor trailer".
  { value: 'tractor_trailer_friendly', label: 'Tractor trailer friendly' },
];

const DOCK_TYPES = [
  { value: 'dock_high', label: 'Dock high' },
  { value: 'ground', label: 'Ground level' },
  { value: 'either', label: 'Either works' },
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MOCK_MODE = import.meta.env.VITE_USE_MOCK_NUVIZZ === 'true';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
// Optional vector Map ID. When set, Google renders a VECTOR map which supports
// interactive 3D tilt + rotation (hold ⌘/Ctrl and drag to spin around a point)
// and 3D buildings. Unset → raster map (still gets the rotate control + 45°
// aerial in Satellite where Google has imagery). Create one in Google Cloud
// Console → Maps → Map Management (rendering: Vector, tilt + rotation enabled).
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || undefined;

// M4.1 localStorage keys + sizing constants for the resizable left panel.
const LS_PANEL_WIDTH = 'dispatchMap.leftPanelWidth';
const LS_DRIVER_LABELS = 'dispatchMap.driverLabelsVisible';
const LS_SEARCH_HISTORY = 'dispatchMap.searchHistory';
const LS_LEGEND_EXPANDED = 'dispatchMap.legendExpanded';
const LS_TABLE_COLUMNS = 'dispatchMap.tableColumns';
// M4.4 — Filter toolbar persistence. mapFilters is the full toggle state object;
// toolbarCollapsed is just the open/closed UI state of the toolbar itself.
const LS_MAP_FILTERS = 'dispatchMap.mapFilters';
const LS_FILTER_TOOLBAR_COLLAPSED = 'dispatchMap.filterToolbarCollapsed';
// Status pill (stops/pallets/feed-age) open/closed UI state — collapsed shows
// just the stops count + controls to reclaim map space.
const LS_STATUS_PILL_COLLAPSED = 'dispatchMap.statusPillCollapsed';
// M4.5 — Mobile drawer last-active tab (Stops/Filters/Drivers). Drawer height
// intentionally NOT persisted — it always opens at the default size.
const LS_MOBILE_DRAWER_TAB = 'dispatchMap.mobileDrawerTab';
// M5 — Show Routes toggle persists; selectedDate intentionally does NOT
// (resets to today every load, per brief P2.2).
const LS_SHOW_ROUTES = 'dispatchMap.showRoutes';
const LS_ROUTE_LEGEND_EXPANDED = 'dispatchMap.routeLegendExpanded';
const LS_BOTTOM_TABLE_OPEN = 'dispatchMap.bottomTableOpen';
const LS_BOTTOM_TABLE_HEIGHT = 'dispatchMap.bottomTableHeight';

// M5 — Driver route polyline palette. 16 colors, distinct from brand colors
// (#1e5b92, #dc2626, #16a34a, #f59e0b, #6b7280) and from each other, all
// readable on Map + Satellite (no near-black). Assigned by stable djb2 hash of
// driverUserName % 16 — same driver → same color every session.
const ROUTE_PALETTE = [
  '#e11d48', '#7c3aed', '#0891b2', '#ca8a04',
  '#be123c', '#4338ca', '#0d9488', '#b45309',
  '#9333ea', '#2563eb', '#65a30d', '#c2410c',
  '#db2777', '#1d4ed8', '#15803d', '#a16207',
];

// djb2 string hash → stable palette index. Deterministic, no storage needed.
function routeColorFor(driverUserName) {
  const s = String(driverUserName || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return ROUTE_PALETTE[h % ROUTE_PALETTE.length];
}

// M5.3 — distinct route colors for ANY number of drivers. A fixed 16-color
// palette repeats + clusters hues once you have 20-40+ routes. Instead we spread
// hues around the wheel by the golden angle (137.508°) so successive drivers are
// maximally far apart in hue and the whole set stays evenly distributed, then
// nudge lightness/saturation in small bands so near-hue neighbors still differ.
// S/L tuned mid-range so lines read on both Map (light) and Satellite (dark).
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
const GOLDEN_ANGLE = 137.508;
function routeColorByIndex(i) {
  const hue = (i * GOLDEN_ANGLE) % 360;
  const l = 42 + (i % 3) * 7;    // 42 / 49 / 56
  const s = 68 + (i % 2) * 14;   // 68 / 82
  return hslToHex(hue, s, l);
}
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 240;
// Max width is computed at runtime as 60% of viewport — see useResizablePanel.
const MOBILE_BREAKPOINT = 768;
// Zoom level when auto-focusing a single stop/customer (building level).
const STOP_ZOOM = 18;
// How often the map silently re-reads the Firestore stop index (DB, not NuVizz)
// so a long-open tab stays current. The background cron scans NuVizz every ~5m.
const STOPS_REFRESH_MS = 120000; // 2 minutes

// Stops-table column visibility defaults. PRO and Flag are off by default —
// dispatchers turn them on via the Columns gear when they need PRO search or
// flag-only triage. Persisted to LS_TABLE_COLUMNS.
const DEFAULT_TABLE_COLUMNS = {
  flag: false,
  customer: true,
  city: true,
  pro: false,
  priority: true,
};

// M4.4 — Map filter toolbar. 5 toggles, persisted as a single object so adding
// a 6th later doesn't churn separate LS keys. Defaults match the brief:
// terminal/stem-out hidden = OFF (markers visible), unplanned/vehicles/clustering = ON.
const DEFAULT_MAP_FILTERS = {
  hideTerminal: false,
  hideStemOut: false,
  unplannedOnly: false,
  carryover: false,
  showVehicleLocation: true,
  showClustered: true,
};
const TABLE_COLUMN_DEFS = [
  { key: 'flag',     label: 'Flag' },
  { key: 'customer', label: 'Customer' },
  { key: 'city',     label: 'City' },
  { key: 'pro',      label: 'PRO' },
  { key: 'priority', label: 'Priority' },
];

// Restriction icon library — single source of truth used by:
//   1. The M4.1.5 14×14 badge (`glyph`, `bg`) — rendered inside the sidebar
//      restriction chips and the Legend per-icon list. White-on-colored-bg.
//   2. The M4.1.6 22×22 marker icon (`markerGlyph`, `accent`) — rendered as
//      the marker itself when a stop has restrictions (replacing the pin).
//      Monochrome `currentColor` so the parent <g style="color:..."> tints
//      both stroke and fill in one place.
// `prohibition: true` adds the diagonal slash in the marker rendering
// (slash is baked into the 14×14 glyph but applied programmatically for the
// 22×22 marker version). Aliases live in RESTRICTION_ALIASES below.
const RESTRICTION_ICONS = {
  no_tractor_trailer: {
    label: 'No tractor trailer',
    short: 'No T/T',
    bg: '#dc2626',
    accent: '#dc2626',
    glyph: '<rect x="2" y="6.5" width="7" height="3.5" fill="white"/><rect x="9" y="5" width="3" height="5" fill="white"/><circle cx="4" cy="10.5" r="1" fill="#dc2626"/><circle cx="10.5" cy="10.5" r="1" fill="#dc2626"/>',
    // 22x22: tractor (right) + trailer (left), 3 wheels. currentColor.
    markerGlyph: `
      <rect x="2" y="9" width="11" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="13" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="5" cy="17" r="1.7" fill="white"/>
      <circle cx="10" cy="17" r="1.7" fill="white"/>
      <circle cx="16" cy="17" r="1.7" fill="white"/>
      <circle cx="5" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="10" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
    prohibition: true,
  },
  // POSITIVE kind (manual-only). Green tractor-trailer with a check — signals the
  // stop CAN take a tractor trailer. NOT a prohibition (no slash). Mutually
  // exclusive with no_tractor_trailer (suppressed in getRestrictionBadgeKeys).
  tractor_trailer_friendly: {
    label: 'Tractor trailer friendly',
    short: 'T/T OK',
    bg: '#16a34a',
    accent: '#16a34a',
    glyph: '<rect x="1.5" y="6.5" width="6.5" height="3.5" fill="white"/><rect x="8" y="5" width="2.8" height="5" fill="white"/><circle cx="3.5" cy="10.5" r="0.9" fill="#16a34a"/><circle cx="9.5" cy="10.5" r="0.9" fill="#16a34a"/><path d="M9.3 4 L10.8 5.6 L13.2 2.6" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    // 22×22: tractor + trailer (currentColor) with a check mark above. No slash.
    markerGlyph: `
      <rect x="1" y="9" width="10" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="11" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="4" cy="17" r="1.6" fill="white"/>
      <circle cx="8.5" cy="17" r="1.6" fill="white"/>
      <circle cx="14" cy="17" r="1.6" fill="white"/>
      <circle cx="4" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="8.5" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="14" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <path d="M14 5.5 L16.5 8 L21 3" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  },
  // M2.1 — Uline SPL-INSTR-TEXT advisory: "STRAIGHT TRUCK ONLY" etc. detected
  // in orderInstructions. Same shape as no_tractor_trailer but amber to signal
  // "verify before relying" (Uline sometimes over-broadcasts this constraint).
  uline_straight_truck: {
    label: 'Uline: straight truck only (advisory)',
    short: 'ST only',
    bg: '#f59e0b',
    accent: '#f59e0b',
    glyph: '<rect x="2" y="6.5" width="7" height="3.5" fill="white"/><rect x="9" y="5" width="3" height="5" fill="white"/><circle cx="4" cy="10.5" r="1" fill="#f59e0b"/><circle cx="10.5" cy="10.5" r="1" fill="#f59e0b"/>',
    markerGlyph: `
      <rect x="2" y="9" width="11" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="13" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="5" cy="17" r="1.7" fill="white"/>
      <circle cx="10" cy="17" r="1.7" fill="white"/>
      <circle cx="16" cy="17" r="1.7" fill="white"/>
      <circle cx="5" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="10" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
    prohibition: true,
  },
  liftgate_required: {
    label: 'Liftgate required',
    short: 'Liftgate',
    bg: '#7c3aed',
    accent: '#1e5b92',
    glyph: '<path d="M2 11 L12 11" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M7 9 L7 3 M4.5 5.5 L7 3 L9.5 5.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
    // 22x22: platform bar at bottom + up-arrow.
    markerGlyph: `
      <line x1="2" y1="18" x2="20" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="11" y1="15" x2="11" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M5.5 9 L11 3.5 L16.5 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    `,
  },
  '26ft_max': {
    label: '26 ft max',
    short: '26ft max',
    bg: '#ea580c',
    accent: '#dc2626',
    label_text: '26',
    // 22x22: big "26" + tiny "FT MAX" caption below.
    markerGlyph: `
      <text x="11" y="14.5" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="800" fill="currentColor" text-anchor="middle">26</text>
      <text x="11" y="20" font-family="system-ui, -apple-system, sans-serif" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle">FT MAX</text>
    `,
  },
  no_53ft: {
    label: 'No 53 ft',
    short: 'No 53ft',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: '53',
    prohibition: true,
    // 22x22: big "53" — slash applied via prohibition.
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="800" fill="currentColor" text-anchor="middle">53</text>
    `,
  },
  appointment_required: {
    label: 'Appointment required',
    short: 'Appt',
    bg: '#0891b2',
    accent: '#f59e0b',
    glyph: '<circle cx="7" cy="7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/><path d="M7 4.5 L7 7 L8.8 8" stroke="white" stroke-width="1.3" stroke-linecap="round" fill="none"/>',
    // 22x22: clock face with hands at ~10 o'clock.
    markerGlyph: `
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="11" y1="11" x2="11" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="11" y1="11" x2="14.5" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    `,
  },
  box_truck_only: {
    label: 'Box truck only',
    short: 'Box only',
    bg: '#475569',
    accent: '#dc2626',
    glyph: '<rect x="3" y="6" width="6" height="4" fill="white"/><path d="M9 7 L9 10 L12 10 L12 8 L10.5 7 Z" fill="white"/><circle cx="4.5" cy="10.5" r="1" fill="#475569"/><circle cx="10.5" cy="10.5" r="1" fill="#475569"/>',
    // 22x22: box truck — large box body + smaller cab + 2 wheels.
    markerGlyph: `
      <rect x="2" y="8" width="11" height="7.5" rx="0.5" fill="currentColor"/>
      <path d="M13 9.5 L13 15.5 L19 15.5 L19 12 L16.5 9.5 Z" fill="currentColor"/>
      <circle cx="5.5" cy="17.5" r="1.7" fill="white"/>
      <circle cx="16" cy="17.5" r="1.7" fill="white"/>
      <circle cx="5.5" cy="17.5" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17.5" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
  },
  no_overhead_clearance: {
    label: 'Low overhead clearance',
    short: 'Low clear',
    bg: '#a16207',
    accent: '#a16207',
    glyph: '<path d="M2 11 L2 6 Q7 2 12 6 L12 11" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M5 11 L5 9 M9 11 L9 9" stroke="white" stroke-width="1.3"/>',
    // 22x22: bridge arch + truck silhouette under it.
    markerGlyph: `
      <path d="M2 17 L2 11 Q11 3 20 11 L20 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="6" y="13" width="9" height="4" rx="0.4" fill="currentColor"/>
      <circle cx="8" cy="17.5" r="1.3" fill="white"/>
      <circle cx="13" cy="17.5" r="1.3" fill="white"/>
    `,
  },
  // M4.4 — receiving hours present. Amber clock; not a prohibition. Synthesized
  // from customer_notes.receiving_hours having any non-empty per-day value,
  // OR from a scanner-detected hours range.
  receiving_hours: {
    label: 'Receiving hours',
    short: 'Hours',
    bg: '#f59e0b',
    accent: '#f59e0b',
    // 14×14 badge: clock face + hour/minute hands.
    glyph: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="white" stroke-width="1.3"/><path d="M7 4 L7 7 L9.5 8.5" stroke="white" stroke-width="1.3" stroke-linecap="round" fill="none"/>',
    // 22×22 marker: clock face with bold hands at ~8 o'clock.
    markerGlyph: `
      <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="11" y1="11" x2="11" y2="5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="11" y1="11" x2="15" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    `,
  },
  // M4.4 — closed Monday. Red circle + letter "M" + diagonal slash. Prohibition
  // flag handles the slash via the marker-rendering pipeline (renderMarkerGlyph).
  closed_monday: {
    label: 'Closed Monday',
    short: 'Closed Mon',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: 'M',
    prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">M</text>',
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">M</text>
    `,
  },
  // M4.4 — closed Friday. Same template as Monday, letter F.
  closed_friday: {
    label: 'Closed Friday',
    short: 'Closed Fri',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: 'F',
    prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">F</text>',
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">F</text>
    `,
  },
  // Other closed days — same template, brief listed them as low-priority cheap
  // additions. Letters Tu/W/Th/Sa/Su (2-char where needed for legibility).
  closed_tuesday:  { label: 'Closed Tuesday',  short: 'Closed Tue',  bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Tu</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Tu</text>',
  },
  closed_wednesday: { label: 'Closed Wednesday', short: 'Closed Wed', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">W</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">W</text>',
  },
  closed_thursday: { label: 'Closed Thursday', short: 'Closed Thu', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Th</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Th</text>',
  },
  closed_saturday: { label: 'Closed Saturday', short: 'Closed Sat', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Sa</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Sa</text>',
  },
  closed_sunday: { label: 'Closed Sunday', short: 'Closed Sun', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Su</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Su</text>',
  },
};
// Recognized aliases — straight_truck_only is sometimes used as a synonym
// for box_truck_only in TMS systems. tractor_trailer_friendly (a positive kind,
// set manually) accepts a few natural synonyms.
const RESTRICTION_ALIASES = {
  straight_truck_only: 'box_truck_only',
  tt_friendly: 'tractor_trailer_friendly',
  tractor_trailer_ok: 'tractor_trailer_friendly',
  semi_friendly: 'tractor_trailer_friendly',
};
const UNKNOWN_RESTRICTION = {
  label: 'Unknown restriction',
  short: 'Unknown',
  bg: '#eab308',
  accent: '#6b7280',
  // 14x14 badge fallback
  glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">!</text>',
  // 22x22 marker fallback
  markerGlyph: `
    <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">!</text>
  `,
};

// ---------- hooks ----------

// Sortable hook + matching <SortableTh/> — column sort state for any table.
// Click toggles asc → desc → null. Returns sorted array + UI helpers.
function useSortable(rows, defaultKey = null, defaultDir = 'asc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  const toggle = useCallback((key) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) { setSortDir('asc'); return key; }
      // same key: asc → desc → clear
      setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a?.[sortKey], bv = b?.[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggle };
}

function SortableTh({ label, k, sortKey, sortDir, onToggle, className = '' }) {
  const active = sortKey === k;
  return (
    <th
      onClick={() => onToggle(k)}
      className={`px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 cursor-pointer select-none hover:bg-slate-100 ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </span>
    </th>
  );
}

// Sort an array of rows by a column's `sortVal` accessor (cols whose `get`
// returns JSX can't be sorted on directly). `sort` = { key, dir }; null key =
// original order. Numbers compare numerically, everything else natural-string.
function sortRows(rows, cols, sort) {
  if (!sort || !sort.key) return rows;
  const col = cols.find((c) => c.k === sort.key);
  const val = (col && col.sortVal) || (() => null);
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  });
  if (sort.dir === 'desc') copy.reverse();
  return copy;
}

// Dense clickable header cell for the bottom data grid (matches its compact th
// style; keeps the chevron next to the label even for right-aligned columns).
function GridSortTh({ col, sort, onToggle }) {
  const active = sort.key === col.k;
  return (
    <th
      onClick={() => onToggle(col.k)}
      className="font-semibold text-slate-500 px-2 py-1.5 border-b border-slate-200 whitespace-nowrap cursor-pointer select-none hover:bg-slate-100"
      style={{ width: col.w, textAlign: col.align || 'left' }}
    >
      <span className="inline-flex items-center gap-1" style={{ flexDirection: col.align === 'right' ? 'row-reverse' : 'row' }}>
        {col.label}
        {active ? (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </span>
    </th>
  );
}

// Lazy-load Google Maps JS API. Returns google namespace once loaded.
function useGoogleMaps() {
  const [google, setGoogle] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!MAPS_KEY) {
      setError('VITE_GOOGLE_MAPS_API_KEY is not set');
      return;
    }
    let cancelled = false;
    const loader = new GoogleMapsLoader({ apiKey: MAPS_KEY, version: 'weekly' });
    loader.load().then((g) => {
      if (!cancelled) setGoogle(g);
    }).catch((e) => {
      if (!cancelled) setError(e.message || String(e));
    });
    return () => { cancelled = true; };
  }, []);
  return { google, error };
}

// Fetch JSON from a Netlify Function with one automatic retry on 5xx.
// Surfaces a useful error message on iOS Safari, which throws "The string did
// not match the expected pattern" if you call Response.json() on a non-JSON
// (e.g. empty 502) body. Checking resp.ok BEFORE parsing avoids that path and
// gives us a real HTTP-status error message in its place.
async function fetchJsonWithRetry(url, { retries = 1, backoffMs = 1500 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // cache:'no-store' — these are live ops endpoints; iOS Safari otherwise
      // serves a stale cached GET, so Refresh/auto-poll appear to "do nothing"
      // (e.g. a changed call-cap never showing up at the top).
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) {
        // Always-empty 502s from Netlify Functions when the upstream timed
        // out — surface the status, retry on 5xx.
        const bodyText = await resp.text().catch(() => '');
        const detail = bodyText ? ` — ${bodyText.slice(0, 120)}` : '';
        const msg = `HTTP ${resp.status}${detail}`;
        if (resp.status >= 500 && attempt < retries) {
          lastErr = new Error(msg);
          await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw new Error(msg);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      // Only retry transient (5xx) network errors; bail immediately on
      // explicit non-5xx errors (already thrown above).
      if (attempt < retries && /HTTP 5\d\d|Failed to fetch|Load failed|NetworkError/.test(e.message || '')) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchJsonWithRetry: unknown error');
}

// Pull stops for a given date (YYYY-MM-DD) from the proxy function.
function useStops(date, carryDays = 0) {
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [lastScannedAt, setLastScannedAt] = useState(null);
  const [lastLoadScanAt, setLastLoadScanAt] = useState(null);
  const [lastUnplannedScanAt, setLastUnplannedScanAt] = useState(null);
  const [scanState, setScanState] = useState(null);
  const [source, setSource] = useState(null);
  const [ops, setOps] = useState(null); // today's NuVizz call volume (Fix 5)

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      let params = MOCK_MODE ? '?mock=1' : (date ? `?date=${encodeURIComponent(date)}` : '');
      // carryDays>0 also pulls still-unplanned stops from the prior N days (orders
      // scheduled earlier that never got delivered) so they don't fall off the board.
      if (!MOCK_MODE && carryDays > 0) params += (params ? '&' : '?') + `carryDays=${carryDays}`;
      const url = '/.netlify/functions/nuvizz-pull-today-stops' + params;
      const data = await fetchJsonWithRetry(url);
      if (!data.ok) throw new Error(data.error || 'NuVizz function returned ok:false');
      // Attach the match key now so every consumer downstream can hit it.
      const decorated = (data.stops || []).map((s) => ({
        ...s,
        matchKey: normalizeMatchKey(s.businessName || '', s.addr1 || '', s.city || '', s.zip || ''),
      }));
      setStops(decorated);
      setSource(data.source || 'nuvizz');
      setLastScannedAt(data.lastScannedAt || null);
      setLastLoadScanAt(data.lastLoadScanAt || null);
      setLastUnplannedScanAt(data.lastUnplannedScanAt || null);
      setScanState(data.scanState || null);
      setOps(data.ops || null);
      setLastRefreshed(new Date());
    } catch (e) {
      if (!silent) setError(e.message); // a failed silent poll shouldn't surface an error banner
    } finally {
      if (!silent) setLoading(false);
    }
  }, [date, carryDays]);

  useEffect(() => { refresh(); }, [refresh]);

  // Keep a long-open tab current by silently re-reading the Firestore index
  // (the DB, NOT the NuVizz API — the cron handles scanning) on an interval.
  // Silent = no spinner/flicker; only while the tab is visible; also on refocus.
  useEffect(() => {
    if (MOCK_MODE) return;
    const tick = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh({ silent: true }); };
    const timer = setInterval(tick, STOPS_REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') refresh({ silent: true }); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  return { stops, loading, error, lastRefreshed, lastScannedAt, lastLoadScanAt, lastUnplannedScanAt, scanState, source, ops, refresh };
}
const CARRYOVER_DAYS = 7; // how many prior days of still-unplanned orders to fold in

// M2.1 — Auto-scan today's stops for SPL-INSTR-TEXT + addressLine2 signals
// and enrich customer_notes accordingly. Source-locked (see signal-scanner.ts):
//   addressLine2     → no_tractor_trailer  (Davis-curated, red)
//   orderInstructions → uline_straight_truck (Uline advisory, amber)
// Runs once per load+notes-ready combo; subsequent re-renders are no-ops.
function useAutoScanner(stops, notes, notesReady) {
  const lastSignatureRef = useRef(null);
  useEffect(() => {
    if (!db || !notesReady || !stops.length) return;
    // Skip if we've already scanned this stop set. Signature = stop count +
    // first/last pro, cheap and stable for a given session's load.
    const sig = `${stops.length}|${stops[0]?.pro || ''}|${stops[stops.length - 1]?.pro || ''}`;
    if (lastSignatureRef.current === sig) return;
    lastSignatureRef.current = sig;

    const scanned = stops
      .map((s) => {
        if (!s.matchKey) return null;
        const full = scanStopFull({
          signalSources: s.signalSources,
          addr2: s.addr2,
        });
        const hasAny = full.restrictions.length || full.hours || full.closedDays.length;
        if (!hasAny) return null;
        return {
          matchKey: s.matchKey,
          pro: s.pro,
          businessName: s.businessName,
          addr1: s.addr1,
          city: s.city,
          state: s.state,
          zip: s.zip,
          scanResults: full.restrictions,
          hoursResult: full.hours,
          closedDaysResult: full.closedDays,
        };
      })
      .filter(Boolean);

    if (!scanned.length) return;

    applyScannerResults(db, scanned, notes).then((res) => {
      if (res.errors.length) {
        console.warn('Scanner write errors:', res.errors.slice(0, 3));
      }
      console.log(`Auto-scanner: attempted ${res.attempted}, wrote ${res.written}, override-skips ${res.overrideSkips}, migrations ${res.legacyMigrations}`);
    }).catch((err) => {
      console.error('Auto-scanner failed:', err);
    });
  }, [stops, notes, notesReady]);
}

// Subscribe to ALL customer_notes docs and expose as a Map<match_key, note>.
// Two-step: live subscribe so edits in another tab/dispatcher appear instantly.
function useCustomerNotes() {
  const [notes, setNotes] = useState(new Map());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!db) { setReady(true); return; }
    const unsub = onSnapshot(collection(db, 'customer_notes'), (snap) => {
      const next = new Map();
      snap.forEach((d) => next.set(d.id, { id: d.id, ...d.data() }));
      setNotes(next);
      setReady(true);
    }, (err) => {
      console.error('customer_notes snapshot error', err);
      setReady(true);
    });
    return unsub;
  }, []);
  return { notes, ready };
}

// Subscribe to ALL SMS messages (both directions) written to sms_messages by the
// webhook (inbound) and send-sms (outbound). Newest first, capped. LS_SMS_SEEN
// tracks the last time the inbox was opened so we can show an unread badge.
const LS_SMS_SEEN = 'dispatchMap.smsInboxSeenAt';
function useSmsMessages() {
  const [messages, setMessages] = useState([]);
  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, 'sms_messages'), orderBy('at', 'desc'), limit(500));
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => console.error('sms_messages snapshot error', err));
    return unsub;
  }, []);
  return messages;
}

// --- M4.1 hooks ---

function safeReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

// Track viewport width so we can disable resize and switch the panel to a
// drawer on mobile. Cheap — one resize listener.
function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

// Track the *visible* viewport size (width + height) in CSS pixels. The shell is
// laid out with overflow-hidden (the page itself never scrolls), so on iOS Safari
// the static `100vh` extends behind the dynamic toolbars and hides the bottom of
// the app. We also pin the WIDTH: on iOS the layout viewport can be a few px WIDER
// than the visible (visual) viewport, and `width:100%`/`100vw` resolve to that
// wider layout width — which pushes right-edge controls (the last tab, the AI
// button) off the visible screen. Sizing the shell to the live visualViewport
// width keeps every control inside the visible area. Definite pixels (not dvh/vw)
// so the Google Maps container always resolves a real, non-zero size.
function useViewportSize() {
  const read = () => {
    if (typeof window === 'undefined') return { h: 0, w: 0, x: 0, y: 0 };
    const vv = window.visualViewport;
    return {
      h: (vv?.height || window.innerHeight || 0),
      w: (vv?.width || window.innerWidth || 0),
      // iOS can scroll the VISUAL viewport sideways inside the (wider) LAYOUT
      // viewport when an input is focused — e.g. the search field. offsetLeft/Top
      // is how far the visible area has shifted; we re-apply it so the shell
      // tracks the visible area instead of sliding off the left edge.
      x: (vv?.offsetLeft || 0),
      y: (vv?.offsetTop || 0),
    };
  };
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    // offsetLeft/Top change fires 'scroll' on visualViewport (not 'resize').
    window.visualViewport?.addEventListener('scroll', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  }, []);
  return size;
}

// Left-panel width with mouse-drag handler. Caller spreads handleProps onto
// the drag strip and reads width for the panel. Width is clamped to
// [PANEL_MIN_WIDTH, 60vw] on every change so URL/localStorage tampering can't
// hide the map.
function useResizablePanel(viewportWidth) {
  const maxWidth = Math.max(PANEL_MIN_WIDTH + 50, Math.round(viewportWidth * 0.6));
  const clamp = useCallback((px) => Math.max(PANEL_MIN_WIDTH, Math.min(maxWidth, px)), [maxWidth]);

  const [width, setWidthState] = useState(() => {
    const stored = safeReadJSON(LS_PANEL_WIDTH, null);
    const initial = typeof stored === 'number' ? stored : PANEL_DEFAULT_WIDTH;
    return Math.max(PANEL_MIN_WIDTH, Math.min(initial, Math.round((typeof window === 'undefined' ? 1280 : window.innerWidth) * 0.6)));
  });

  // Re-clamp whenever the max drops (window narrowed).
  useEffect(() => {
    setWidthState((w) => Math.min(w, maxWidth));
  }, [maxWidth]);

  const isDraggingRef = useRef(false);
  const lastWriteRef = useRef(width);

  const setWidth = useCallback((next) => {
    const clamped = clamp(next);
    setWidthState(clamped);
  }, [clamp]);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let raf = null;
    const onMove = (ev) => {
      if (raf) return; // ~1 frame debounce
      raf = requestAnimationFrame(() => {
        raf = null;
        const next = ev.clientX;
        setWidth(next);
      });
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      // Persist on release only — no localStorage thrash mid-drag.
      const w = clamp(lastWriteRef.current);
      safeWriteJSON(LS_PANEL_WIDTH, w);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [clamp, setWidth]);

  const onDoubleClick = useCallback(() => {
    setWidth(PANEL_DEFAULT_WIDTH);
    safeWriteJSON(LS_PANEL_WIDTH, PANEL_DEFAULT_WIDTH);
  }, [setWidth]);

  // Track latest width for the on-release localStorage write.
  useEffect(() => { lastWriteRef.current = width; }, [width]);

  return { width, setWidth, onMouseDown, onDoubleClick, maxWidth, isDragging: isDraggingRef };
}

// Debounce any value. Used by the search bar (200ms) so we don't re-filter on
// every keystroke.
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// Search state + history. The query itself is local to the bar; history is a
// 5-deep list of recent committed searches kept in localStorage.
function useSearchHistory() {
  const [history, setHistory] = useState(() => {
    const arr = safeReadJSON(LS_SEARCH_HISTORY, []);
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  });
  const remember = useCallback((q) => {
    const trimmed = (q || '').trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const dedup = [trimmed, ...prev.filter((x) => x.toLowerCase() !== trimmed.toLowerCase())].slice(0, 5);
      safeWriteJSON(LS_SEARCH_HISTORY, dedup);
      return dedup;
    });
  }, []);
  const clear = useCallback(() => {
    setHistory([]);
    safeWriteJSON(LS_SEARCH_HISTORY, []);
  }, []);
  return { history, remember, clear };
}

// Per-driver day-snapshot fetch with 30s in-memory cache keyed by truck number.
// Snapshot shape is whatever /nuvizz-driver-route returns; the function scans
// today's load-number range and filters by driverUserName (preferred) or by
// whitespace-normalized driverName (fallback).
const __snapshotCache = new Map(); // truck# -> { storedAt, data }
const SNAPSHOT_TTL_MS = 30 * 1000;

function useDriverSnapshot(driver) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!driver) { setSnapshot(null); setError(null); return; }
    const key = driver.vehicleNumber || `id:${driver.vehicleId}`;
    const cached = __snapshotCache.get(key);
    if (cached && Date.now() - cached.storedAt < SNAPSHOT_TTL_MS) {
      setSnapshot(cached.data);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSnapshot(null);
    setError(null);
    (async () => {
      try {
        const url = `/.netlify/functions/nuvizz-driver-route?truck=${encodeURIComponent(driver.vehicleNumber || '')}&driver=${encodeURIComponent(driver.driverName || '')}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (cancelled) return;
        if (!data || data.ok === false) {
          setError(data?.error || `HTTP ${resp.status}`);
          // Still set a minimal snapshot so the UI shows telemetry sections.
          const minimal = { route: null, stops: [], hos: null, dailyMiles: null };
          __snapshotCache.set(key, { storedAt: Date.now(), data: minimal });
          setSnapshot(minimal);
        } else {
          __snapshotCache.set(key, { storedAt: Date.now(), data });
          setSnapshot(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          const minimal = { route: null, stops: [], hos: null, dailyMiles: null };
          setSnapshot(minimal);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [driver?.vehicleId, driver?.vehicleNumber]);

  return { snapshot, loading, error };
}

// M4: poll Motive every 60s while enabled.
function useDriverPositions(enabled) {
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const data = await fetchJsonWithRetry('/.netlify/functions/motive-driver-positions');
        if (cancelled) return;
        if (data.ok) {
          setDrivers(data.drivers || []);
          setError(null);
          setLastRefreshed(new Date());
        } else {
          setError(data.error || 'Motive function returned ok:false');
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    pull();
    const id = setInterval(pull, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return { drivers, error, lastRefreshed };
}

// Full driver roster from Motive (the fleet-management app). Fetched ONCE on
// mount (server-cached ~1h) so the DNS "barred drivers" picker can list every
// driver in the fleet, not just those on today's board or currently positioned.
// Best-effort: on failure the picker still has the board's assigned drivers.
function useDriverRoster() {
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJsonWithRetry('/.netlify/functions/motive-drivers');
        if (!cancelled && data?.ok) setRoster(data.drivers || []);
      } catch { /* roster is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return roster;
}

// ---------- helpers ----------

function flagColor(note) {
  if (note?.priority_flag && FLAG_COLORS[note.priority_flag]) return FLAG_COLORS[note.priority_flag];
  if (note && (note.equipment_restrictions?.length || note.liftgate_required || note.appointment_required)) {
    return RESTRICTION_TINT;
  }
  return UNFLAGGED_TINT;
}

// Resolve a stored restriction string to a canonical key in RESTRICTION_ICONS.
// Unknown values pass through untouched so the caller can detect them.
function resolveRestrictionKey(raw) {
  if (!raw) return null;
  return RESTRICTION_ALIASES[raw] || raw;
}

// True if customer_notes carries any non-empty receiving_hours value. Old
// schema stored per-day as a single string ("6AM-2PM"); M4.4 schema stores
// per-day as {open, close}. Either truthy form qualifies.
function hasReceivingHours(note) {
  const hrs = note?.receiving_hours;
  if (!hrs) return false;
  for (const k of Object.keys(hrs)) {
    const v = hrs[k];
    if (!v) continue;
    if (typeof v === 'string' && v.trim()) return true;
    if (typeof v === 'object' && (v.open || v.close)) return true;
  }
  return false;
}

// True if a stop has structured receiving hours OR references receiving hours in
// its raw free text (NuVizz order instructions, addr2, dock/appointment notes).
// The structured scanner is unreliable on some Uline formats, so the "Has
// receiving hours" filter matches the raw text directly — this finds every loaded
// stop that mentions receiving hours regardless of whether hours were parsed.
// Matches Uline shapes: "RECEIVING HOURS", "RH 7-11AM", "REC HRS".
const RECEIVING_REF = /\bRECEIVING\b|\bRH\b|\bREC\s*HRS?\b/i;
function referencesReceivingHours(stop, note) {
  if (hasReceivingHours(note)) return true;
  const text = [
    stop?.signalSources?.orderInstructions,
    stop?.addr2,
    note?.dock_notes,
    note?.appointment_notes,
  ].filter(Boolean).join(' \n ');
  return RECEIVING_REF.test(text);
}

// Display-clean the raw NuVizz order instructions for the stop card: drop the
// "SPL-INSTR-TEXT:" prefix on each line and hide boilerplate that rides on every
// Uline order ("DO NOT BREAKDOWN SKID"). Returns '' when nothing meaningful is
// left so the section hides entirely.
function cleanInstructions(text) {
  if (!text) return '';
  return String(text)
    .split('\n')
    .map((l) => l.replace(/^\s*SPL-INSTR-TEXT\s*:?\s*/i, '').trim())
    .filter((l) => l && !/do\s*not\s*break\s*down\s*skid/i.test(l))
    .join('\n');
}

// True if the note carries receiving hours for ONE specific weekday key
// ('mon'..'sun'). Same legacy-string / {open,close} tolerance as above.
function hasReceivingHoursForDay(note, dayKey) {
  const v = note?.receiving_hours?.[dayKey];
  if (!v) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return !!(v.open || v.close);
}

// Map a "YYYY-MM-DD" date string to a receiving-hours day key ('mon'..'sun').
// Parsed at local noon so DST/UTC never shifts the weekday (matches date-util).
// JS getDay() is 0=Sun..6=Sat; we re-key into our Mon-first DAYS vocabulary.
function weekdayKeyFromDate(dateString) {
  if (!dateString) return null;
  const [y, m, d] = String(dateString).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}

// Build the list of restriction badge keys for a note. Includes equipment
// restrictions, liftgate, appointment-required (M2-M4), and M4.4 additions:
// receiving_hours (clock), closed_<day> per entry in note.closed_days.
// Display order per brief P3.2: equipment first, then receiving hours, then
// closed Monday, then closed Friday, then other closed days.
// `opts.day` ('mon'..'sun') makes the receiving-hours clock DAY-AWARE: the
// clock badge is included only when that weekday actually has hours set, so a
// customer with Friday-only hours shows the clock on Fridays and nowhere else.
// Omit `opts.day` (legend, counts, sidebar badge row) to keep the old behavior
// where any day's hours light the clock.
let __ttFriendlyConflictLogged = false;
function getRestrictionBadgeKeys(note, opts = {}) {
  if (!note) return [];
  const keys = [];
  for (const r of note.equipment_restrictions || []) {
    const resolved = resolveRestrictionKey(r);
    if (resolved && !keys.includes(resolved)) keys.push(resolved);
  }
  // Mutual exclusion: a real "no tractor trailer" restriction always wins over the
  // positive "tractor trailer friendly" kind. Suppress friendly from render and
  // warn once so the conflicting data is discoverable but never shown together.
  if (keys.includes('no_tractor_trailer') && keys.includes('tractor_trailer_friendly')) {
    const i = keys.indexOf('tractor_trailer_friendly');
    keys.splice(i, 1);
    if (!__ttFriendlyConflictLogged) {
      __ttFriendlyConflictLogged = true;
      // eslint-disable-next-line no-console
      console.warn('[restriction-icons] stop has both no_tractor_trailer and tractor_trailer_friendly — suppressing the positive kind (the restriction wins)');
    }
  }
  if (note.liftgate_required && !keys.includes('liftgate_required')) keys.push('liftgate_required');
  if (note.appointment_required && !keys.includes('appointment_required')) keys.push('appointment_required');
  const showHours = opts.day ? hasReceivingHoursForDay(note, opts.day) : hasReceivingHours(note);
  if (showHours) keys.push('receiving_hours');
  const closed = Array.isArray(note.closed_days) ? note.closed_days : [];
  const closedOrder = ['mon', 'fri', 'tue', 'wed', 'thu', 'sat', 'sun'];
  for (const day of closedOrder) {
    if (closed.includes(day)) {
      const key = `closed_${({mon:'monday', tue:'tuesday', wed:'wednesday', thu:'thursday', fri:'friday', sat:'saturday', sun:'sunday'})[day]}`;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// Raw SVG fragment for a single 14×14 badge (used inside the marker SVG
// data URL AND inside the React <RestrictionIcon/>). Logs unknown kinds
// once to the console so they're discoverable rather than silent.
const __unknownRestrictionsLogged = new Set();
function badgeInnerSvg(kind) {
  let def = RESTRICTION_ICONS[kind];
  if (!def) {
    if (!__unknownRestrictionsLogged.has(kind)) {
      __unknownRestrictionsLogged.add(kind);
      // eslint-disable-next-line no-console
      console.warn(`[restriction-icons] unknown restriction kind: "${kind}" — rendering generic warning badge`);
    }
    def = UNKNOWN_RESTRICTION;
  }
  const slash = def.prohibition
    ? '<line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="white" stroke-width="2" stroke-linecap="round"/>'
    : '';
  const labelText = def.label_text
    ? `<text x="7" y="9.5" font-family="system-ui, sans-serif" font-size="6" font-weight="700" fill="white" text-anchor="middle">${def.label_text}</text>`
    : '';
  return `
    <circle cx="7" cy="7" r="7" fill="${def.bg}" stroke="white" stroke-width="1.5"/>
    ${def.glyph || ''}
    ${labelText}
    ${slash}
  `;
}

// M4.1.6 — marker rendering split into two functions:
//
//   pinSvgClassic(color): the historical 28×36 pin. Used for State A (stop
//     has no restrictions). No behavior change vs. M4.1 / M4.1.5 in this
//     case — same SVG, same anchor (14, 34).
//
//   iconMarkerSvg(restrictions): the icon-only marker that replaces the pin
//     entirely when 1+ restrictions are present. Returns { url, width,
//     height, anchor: [x, y] } so the marker effect can size and anchor
//     correctly. State B (1 restriction): single 36-diameter circle. State
//     C (2+): 32-diameter circles side-by-side, capped at 3 elements (4+
//     becomes "first 2 + overflow '+N' badge"). Geographic anchor is the
//     bottom-center of the marker group in both states.

function pinSvgClassic(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1c-7 0-13 5.4-13 12 0 9 13 22 13 22s13-13 13-22c0-6.6-6-12-13-12z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="13" r="4.5" fill="white"/>
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

// M5.1 — same 28×36 pin as pinSvgClassic but status-aware: `hollow` draws an
// outlined (gray) pin for UNPLANNED, and `glyph` swaps the center white dot for
// a status mark (check=delivered, bang=exception, arrow=en route). Anchor is
// unchanged (14, 34) so it's a drop-in for the classic pin.
// Dark or light text for legibility on a given solid fill (perceived luminance).
function readableTextColor(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.6 ? '#1f2937' : '#ffffff';
}

function pinSvgStatus(color, opts = {}) {
  const { hollow = false, glyph = null, tag = null, label = null } = opts;
  const bodyFill = hollow ? '#ffffff' : color;
  const bodyStroke = hollow ? color : '#ffffff';
  const strokeW = hollow ? 2.5 : 2;
  let center;
  if (label != null) {
    // Route delivery-sequence number in the pin head (NuVizz-style numbered stop).
    const txt = hollow ? color : readableTextColor(color);
    const fs = String(label).length >= 2 ? 9 : 11;
    center = `<text x="14" y="${String(label).length >= 2 ? 16.6 : 17}" font-family="system-ui, sans-serif" font-size="${fs}" font-weight="800" fill="${txt}" text-anchor="middle" letter-spacing="-0.5">${label}</text>`;
  } else if (glyph === 'check') {
    center = '<path d="M9.5 13.2l2.8 2.8 5.2-6" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (glyph === 'bang') {
    center = '<text x="14" y="17.5" font-family="system-ui, sans-serif" font-size="12" font-weight="800" fill="white" text-anchor="middle">!</text>';
  } else if (glyph === 'question') {
    center = '<text x="14" y="17.7" font-family="system-ui, sans-serif" font-size="13" font-weight="800" fill="white" text-anchor="middle">?</text>';
  } else if (glyph === 'dns') {
    // DNS — white "✕" in the pin head (do not send).
    center = '<path d="M10.6 9.6l6.8 6.8M17.4 9.6l-6.8 6.8" stroke="white" stroke-width="2.4" stroke-linecap="round"/>';
  } else if (glyph === 'arrow') {
    center = '<path d="M9.5 13h6m-2.5-2.6l2.8 2.6-2.8 2.6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (tag === 'AM' || tag === 'PM') {
    // Delivery-window tag — render "AM"/"PM" in the pin head (replaces the dot).
    // Text color contrasts with the pin fill (e.g. dark on a yellow-flag pin).
    const txt = hollow ? color : readableTextColor(color);
    center = `<text x="14" y="16.8" font-family="system-ui, sans-serif" font-size="10" font-weight="800" fill="${txt}" text-anchor="middle" letter-spacing="-0.5">${tag}</text>`;
  } else {
    center = `<circle cx="14" cy="13" r="4.5" fill="${hollow ? color : 'white'}"/>`;
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1c-7 0-13 5.4-13 12 0 9 13 22 13 22s13-13 13-22c0-6.6-6-12-13-12z"
        fill="${bodyFill}" stroke="${bodyStroke}" stroke-width="${strokeW}"/>
      ${center}
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

// Resolve a restriction kind to its accent color + 22×22 glyph fragment.
// Substitutes `currentColor` in the template with the accent so the glyph
// renders standalone (works in any SVG renderer, no CSS cascade required).
// Returns the rendered glyph string plus the optional prohibition slash.
function renderMarkerGlyph(restrictionKey, glyphX, glyphY, tint) {
  const resolved = resolveRestrictionKey(restrictionKey);
  const def = RESTRICTION_ICONS[resolved] || UNKNOWN_RESTRICTION;
  const color = tint || def.accent || def.bg || '#6b7280';
  const glyph = (def.markerGlyph || UNKNOWN_RESTRICTION.markerGlyph || '')
    .replace(/currentColor/g, color);
  const slash = def.prohibition
    ? `<line x1="2" y1="2" x2="20" y2="20" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`
    : '';
  return `<g transform="translate(${glyphX},${glyphY})">${glyph}${slash}</g>`;
}

function iconMarkerSvg(restrictions, tint) {
  if (!restrictions || restrictions.length === 0) return null;

  // State B: single 36-diameter circle.
  if (restrictions.length === 1) {
    const r = restrictions[0];
    const def = RESTRICTION_ICONS[resolveRestrictionKey(r)] || UNKNOWN_RESTRICTION;
    const accent = tint || def.accent || def.bg || '#6b7280';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="44" viewBox="0 0 40 44">
        <ellipse cx="20" cy="40" rx="12" ry="1.8" fill="black" opacity="0.18"/>
        <circle cx="20" cy="20" r="18" fill="white" fill-opacity="0.95" stroke="${accent}" stroke-width="2"/>
        ${renderMarkerGlyph(r, 9, 9, tint)}
      </svg>`;
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      width: 40,
      height: 44,
      anchor: [20, 38],
    };
  }

  // State C: side-by-side 32-diameter circles. 2 or 3 raw restrictions
  // render as-is; 4+ collapses to first 2 + "+N" overflow.
  const elements = restrictions.length <= 3
    ? restrictions.slice()
    : [restrictions[0], restrictions[1], { __overflow: restrictions.length - 2 }];
  const n = elements.length;
  const slotW = 32;
  const gap = 2;
  const totalW = n * slotW + (n - 1) * gap;
  const totalH = 40;

  let elementsMarkup = '';
  for (let i = 0; i < n; i++) {
    const cx = i * (slotW + gap) + slotW / 2;
    const cy = 18;
    const el = elements[i];
    if (el && typeof el === 'object' && '__overflow' in el) {
      elementsMarkup += `
        <circle cx="${cx}" cy="${cy}" r="15" fill="white" fill-opacity="0.95" stroke="${tint || '#6b7280'}" stroke-width="2"/>
        <text x="${cx}" y="${cy + 4}" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="${tint || '#374151'}" text-anchor="middle">+${el.__overflow}</text>
      `;
    } else {
      const def = RESTRICTION_ICONS[resolveRestrictionKey(el)] || UNKNOWN_RESTRICTION;
      const accent = tint || def.accent || def.bg || '#6b7280';
      elementsMarkup += `
        <circle cx="${cx}" cy="${cy}" r="15" fill="white" fill-opacity="0.95" stroke="${accent}" stroke-width="2"/>
        ${renderMarkerGlyph(el, cx - 11, cy - 11, tint)}
      `;
    }
  }

  const shadowRx = Math.max(8, totalW / 2 - 6);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
      <ellipse cx="${totalW / 2}" cy="36" rx="${shadowRx}" ry="1.8" fill="black" opacity="0.15"/>
      ${elementsMarkup}
    </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    width: totalW,
    height: totalH,
    anchor: [totalW / 2, 34],
  };
}

// Build the rich dispatch-map marker icon for a single stop — the shared source of
// truth so BOTH the Map screen and the Routing screen render IDENTICAL markers
// (DNS pin → numbered route pin → status/flag/AM-PM/address-off pin → restriction
// icons). Returns a google.maps Icon ({ url, scaledSize, anchor }).
//   opts.selectedDayKey — day key for receiving-hours restriction badges
//   opts.matched        — stop is in the active result set (renders ORANGE + enlarged)
//   opts.inRoute        — stop is in the open/selected route (renders a numbered pin)
//   opts.seq            — the route sequence number drawn in the numbered pin
//   opts.routeColor     — overrides the numbered pin's color (Routing colors by route,
//                         the Map colors by status); omit to keep status coloring.
function stopMarkerIcon(google, s, note, opts = {}) {
  const { selectedDayKey, matched = false, inRoute = false, seq, routeColor } = opts;
  const restrictions = getRestrictionBadgeKeys(note, { day: selectedDayKey });
  const flagHue = (note?.priority_flag && FLAG_COLORS[note.priority_flag]) ? FLAG_COLORS[note.priority_flag] : null;
  const dnsStop = !!note?.do_not_send;
  if (dnsStop) {
    // DNS — strong red pin with a white ✕, taking precedence over everything else.
    return { url: pinSvgStatus(DNS_COLOR, { glyph: 'dns' }), scaledSize: new google.maps.Size(28, 36), anchor: new google.maps.Point(14, 34) };
  }
  if (inRoute) {
    // Numbered route pin (delivery sequence). Colored by route when a routeColor is
    // given (Routing), else by status (Map): green=delivered / blue=scheduled.
    const statusKind = classifyStopStatus(s);
    const meta = STATUS_META[statusKind] || STATUS_META.SCHEDULED;
    const color = routeColor || meta.color || flagColor(note);
    return { url: pinSvgStatus(color, { label: String(seq) }), scaledSize: new google.maps.Size(30, 39), anchor: new google.maps.Point(15, 37) };
  }
  if (restrictions.length === 0) {
    // State A — status drives the pin; matched stops pop orange; a priority flag,
    // AM/PM window, or "address looks off" signal recolor/reglyph as appropriate.
    const statusKind = classifyStopStatus(s);
    const meta = STATUS_META[statusKind] || STATUS_META.SCHEDULED;
    const tag = (note?.delivery_window === 'AM' || note?.delivery_window === 'PM') ? note.delivery_window : null;
    const addressOff = !matched && !flagHue
      && (statusKind === 'SCHEDULED' || statusKind === 'UNPLANNED')
      && addressLooksOff(s, note);
    const color = matched ? '#f59e0b'
      : flagHue
      || (addressOff ? ADDRESS_OFF_TINT : (meta.color || flagColor(note)));
    let glyph = meta.glyph;
    if (!matched) {
      if (note?.priority_flag === 'question' && !glyph) glyph = 'question';
      else if (addressOff) glyph = 'bang';
    }
    const big = matched || !!tag;
    return {
      url: pinSvgStatus(color, { hollow: matched ? false : meta.hollow, glyph, tag }),
      scaledSize: big ? new google.maps.Size(28, 36) : new google.maps.Size(16, 21),
      anchor: big ? new google.maps.Point(14, 34) : new google.maps.Point(8, 20),
    };
  }
  // States B/C — restriction / receiving-hours icons; a priority flag recolors them.
  const spec = iconMarkerSvg(restrictions, flagHue);
  return { url: spec.url, scaledSize: new google.maps.Size(spec.width, spec.height), anchor: new google.maps.Point(spec.anchor[0], spec.anchor[1]) };
}

function truckSvg(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="18" fill="${color}" stroke="white" stroke-width="2"/>
      <path d="M9 22h13v-7H9zM22 18h5l3 4v3h-8z" fill="white"/>
      <circle cx="13" cy="27" r="2.5" fill="${color}" stroke="white" stroke-width="1"/>
      <circle cx="26" cy="27" r="2.5" fill="${color}" stroke="white" stroke-width="1"/>
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function fmtTimeAgo(d) {
  if (!d) return '—';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

// Relative recency for a feed timestamp (ISO/UTC instant) — "3 min ago".
function fmtFeedAge(iso) {
  if (!iso) return null;
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
  return `${Math.round(secs / 86400)} d ago`;
}
// Absolute ET in house format: "Jul 14, 2025, 3:42 PM ET".
function fmtAbsoluteET(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${date}, ${time} ET`;
}
// Current ET hour (0-23) — for "Orders paused until 10 AM" messaging.
function etHourNow() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date())) % 24;
}

// Split per-feed freshness: loads and orders run on different cadences, so a
// single stamp would mislead. Shows relative recency; absolute ET on hover.
// Before 10 AM ET the orders feed is intentionally idle → "paused until 10 AM".
function FeedTimestamps({ loadAt, unplannedAt, isToday, className, stacked }) {
  const ordersPaused = isToday && etHourNow() < 10;
  const loadRel = fmtFeedAge(loadAt);
  const orderRel = fmtFeedAge(unplannedAt);
  const loads = <span title={fmtAbsoluteET(loadAt)}>Loads {loadRel ? `updated ${loadRel}` : '—'}</span>;
  const orders = (
    <span title={fmtAbsoluteET(unplannedAt)}>
      Orders {ordersPaused ? 'paused until 10 AM' : (orderRel ? `updated ${orderRel}` : '—')}
    </span>
  );
  // Stacked: one line each (saves horizontal space in the status card).
  // Inline: both on a single line with a separator (compact map overlay).
  if (stacked) {
    return (
      <div className={className || 'text-slate-500'}>
        <div>{loads}</div>
        <div>{orders}</div>
      </div>
    );
  }
  return (
    <div className={className || 'text-slate-500'}>
      {loads}
      <span className="text-slate-300"> · </span>
      {orders}
    </div>
  );
}

// Compact 24-bar sparkline of NuVizz API calls per ET hour (ops.byHour). Makes
// spikes (e.g. the 10am unplanned open) visible at a glance without leaving the board.
// Renders nothing until there's at least one call today.
function HourlyCalls({ byHour, className }) {
  if (!byHour) return null;
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const vals = hours.map((h) => byHour[h] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const max = Math.max(...vals);
  const peak = vals.indexOf(max);
  return (
    <div className={className || 'text-slate-400 text-[10px]'}>
      <div className="flex items-end gap-px h-5" title="NuVizz API calls per ET hour (00–23)">
        {vals.map((v, h) => (
          <div
            key={h}
            className={v ? 'w-1 bg-violet-500/70' : 'w-1 bg-slate-200'}
            style={{ height: `${Math.max(2, Math.round((v / max) * 20))}px` }}
            title={`${hours[h]}:00 ET — ${v.toLocaleString()} calls`}
          />
        ))}
      </div>
      <div>by hour (ET) · peak {hours[peak]}:00 = {max.toLocaleString()}</div>
    </div>
  );
}

// M5.2 — data now comes from the pre-scanned Firestore stop index, refreshed by a
// background scan every ~5 min. The meaningful freshness is when that scan ran
// (lastScannedAt), not when the client fetched. Surface it so dispatchers know
// how current the board is.
function fmtStopFreshness(source, lastScannedAt) {
  if (source === 'fixture') return 'MOCK DATA';
  if (source === 'index-empty') return 'No scan yet';
  if (source === 'live-scan') return 'Live scan';
  if (lastScannedAt) {
    const d = new Date(lastScannedAt);
    if (!isNaN(d.getTime())) {
      return `Stops as of ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return 'NuVizz';
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Empty/default note template — used when opening a stop that has no Firestore doc yet.
function emptyNote(stop) {
  return {
    raw_name: stop.businessName || '',
    raw_address: [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '),
    match_key: stop.matchKey,
    // M4.4 — receiving_hours uses {open, close} per day. Empty strings keep
    // <input type="time"> controls controlled without showing a placeholder.
    receiving_hours: {
      mon: { open: '', close: '' },
      tue: { open: '', close: '' },
      wed: { open: '', close: '' },
      thu: { open: '', close: '' },
      fri: { open: '', close: '' },
      sat: { open: '', close: '' },
      sun: { open: '', close: '' },
    },
    closed_days: [],
    manual_overrides: {},
    appointment_required: false,
    appointment_notes: '',
    equipment_restrictions: [],
    liftgate_required: false,
    dock_type: null,
    contacts: [],
    dock_notes: '',
    priority_flag: null,
    delivery_window: null,   // 'AM' | 'PM' | null — shows an AM/PM tag on the map pin
    photo_urls: [],
    pro_history: [],
    do_not_send: false,      // DNS — do-not-send flag (red badge everywhere)
    dns_drivers: [],         // names of drivers barred from this customer
    notify_cs: false,        // email customer service when this customer is scheduled
  };
}

// Append today's PRO to pro_history if not already the most-recent entry.
// Returns a new history array (max 20, FIFO). Pure — caller writes if changed.
function bumpProHistory(existing, pro) {
  const arr = Array.isArray(existing) ? existing : [];
  const today = todayYmd();
  const last = arr[arr.length - 1];
  if (last && last.pro === pro && last.date === today) return arr;
  const next = [...arr, { pro, date: today }];
  return next.slice(-20);
}

// Part 9: render a single restriction icon at the given size. The inner SVG
// is identical to what the marker embeds, so legend/sidebar/marker stay
// visually consistent. Uses dangerouslySetInnerHTML inside an <svg> — the
// browser preserves SVG namespace because the parent is svg, so the inner
// nodes parse correctly.
function RestrictionIcon({ kind, size = 16, title }) {
  const resolved = resolveRestrictionKey(kind);
  const def = RESTRICTION_ICONS[resolved] || UNKNOWN_RESTRICTION;
  const titleText = title || def.label;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={titleText}
    >
      <title>{titleText}</title>
      <g dangerouslySetInnerHTML={{ __html: badgeInnerSvg(resolved || 'unknown') }} />
    </svg>
  );
}

// M4.1 — case-insensitive contains-match across business name, every PRO on
// the stop, address1, city, ZIP, and either of the customer-notes prose
// fields. Returns true for empty queries (no filter applied).
function stopMatchesSearch(stop, note, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [
    stop.businessName,
    stop.addr1,
    stop.city,
    stop.zip,
    note?.dock_notes,
    note?.appointment_notes,
  ];
  for (const f of fields) {
    if (f && String(f).toLowerCase().includes(needle)) return true;
  }
  for (const pro of stop.pros || (stop.pro ? [stop.pro] : [])) {
    if (String(pro).toLowerCase().includes(needle)) return true;
  }
  return false;
}

// Return the PRO from a stop's pros list that matches the search needle.
// Used so the table cell shows the matched PRO first (then "+N" others).
function matchedPro(stop, q) {
  if (!q) return null;
  const needle = q.toLowerCase();
  const list = stop.pros || (stop.pro ? [stop.pro] : []);
  for (const pro of list) {
    if (String(pro).toLowerCase().includes(needle)) return pro;
  }
  return null;
}

// ---------- components ----------

// 6-px visible bar centered in a 12-px hit area. The wider hit zone makes the
// handle easier to grab; the visible bar is the affordance the dispatcher sees.
function ResizeHandle({ onMouseDown, onDoubleClick }) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  return (
    <div
      onMouseDown={(e) => { setActive(true); onMouseDown(e); const up = () => { setActive(false); document.removeEventListener('mouseup', up); }; document.addEventListener('mouseup', up); }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex-shrink-0 cursor-col-resize select-none"
      style={{
        width: 12,
        marginLeft: -3,
        marginRight: -3,
        zIndex: 5,
        position: 'relative',
        background: 'transparent',
      }}
      title="Drag to resize. Double-click to reset."
    >
      <div
        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
        style={{
          width: 6,
          background: active
            ? `rgba(30,91,146,0.30)`
            : hover
            ? 'rgba(148,163,184,0.25)'
            : 'transparent',
          transition: 'background 80ms linear',
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-0.5 pointer-events-none"
        aria-hidden
      >
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
      </div>
    </div>
  );
}

// SearchBar — controlled input + recent-history dropdown. Owns its own draft
// string; commits to parent (via onChange) immediately so the parent can
// debounce + filter. onSubmit is called when Enter is pressed (used to commit
// to localStorage history).
function SearchBar({
  value, onChange, onSubmit, history, inputRef, resultCount, totalCount,
  // M6 — AI search props. When aiAvailable, a sparkle toggle switches the box
  // into "Ask AI" mode; Enter (or the button) then runs a natural-language parse.
  aiAvailable, aiMode, setAiMode, onAskAi, aiBusy, aiSummary, aiError, onClearAi,
}) {
  const [focused, setFocused] = useState(false);
  const showHistory = focused && !value && history.length > 0;
  const aiActive = !!aiSummary;
  return (
    <div className="px-3 pt-3 pb-1 relative">
      <div className="relative">
        {aiMode
          ? <Sparkles size={13} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: '#1e5b92' }} />
          : <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (aiMode && value.trim()) { onAskAi(value); }
              else { onSubmit(value); }
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') { onChange(''); e.currentTarget.blur(); }
          }}
          placeholder={aiMode ? 'Ask AI to filter (e.g. closed Fridays, liftgate)…' : 'Search customer, PRO, city, address...'}
          className={'w-full border rounded pl-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 ' +
            (aiAvailable ? 'pr-14 ' : 'pr-7 ') +
            (aiMode ? 'border-blue-400 bg-blue-50/40' : 'border-slate-300 focus:border-blue-400')}
          aria-label="Search stops"
        />
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {value && (
            <button
              onClick={() => onChange('')}
              className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
              aria-label="Clear search"
              tabIndex={-1}
            >
              <X size={13} />
            </button>
          )}
          {aiAvailable && (
            <button
              onClick={() => setAiMode(!aiMode)}
              className={'px-1.5 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-1 ' +
                (aiMode ? 'text-white' : 'text-slate-500 hover:bg-slate-100')}
              style={aiMode ? { background: '#1e5b92' } : undefined}
              title="Toggle natural-language AI search"
              aria-pressed={aiMode}
            >
              <Sparkles size={11} /> AI
            </button>
          )}
        </div>
      </div>
      {aiActive ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800">
            <Sparkles size={10} /> {aiSummary}
          </span>
          <button onClick={onClearAi} className="text-slate-500 hover:text-slate-800 underline">Clear</button>
        </div>
      ) : aiBusy ? (
        <div className="mt-1 text-[10px] text-slate-500 inline-flex items-center gap-1"><Sparkles size={10} className="animate-pulse" /> Asking AI…</div>
      ) : value && !aiMode ? (
        <div className="mt-1 text-[10px] text-slate-500">
          {resultCount > 0
            ? <>Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops</>
            : <>No stops match "<span className="font-semibold">{value}</span>"</>
          }
        </div>
      ) : null}
      {aiError && <div className="mt-1 text-[10px] text-amber-700">{aiError}</div>}
      {showHistory && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-white border border-slate-200 rounded shadow-md z-10 max-h-56 overflow-y-auto">
          <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-slate-400 border-b">Recent searches</div>
          {history.map((h, i) => (
            <button
              key={i}
              onMouseDown={(e) => { e.preventDefault(); onChange(h); onSubmit(h); }}
              className="block w-full text-left px-2 py-1 text-xs hover:bg-blue-50"
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// M4.1.6: render the same iconMarkerSvg output as an <img> for the legend
// examples. This guarantees the legend preview is byte-identical to what
// the map renders, so if the marker visual changes the legend stays in sync.
function LegendMarkerExample({ restrictions, label }) {
  const spec = useMemo(() => iconMarkerSvg(restrictions), [restrictions]);
  if (!spec) return null;
  return (
    <div className="flex items-center gap-2">
      <img
        src={spec.url}
        alt=""
        width={spec.width}
        height={spec.height}
        style={{ display: 'block' }}
      />
      <span className="text-slate-600">{label}</span>
    </div>
  );
}

// Part 9: collapsible legend that explains both the priority-flag color
// language and the restriction icons. Default collapsed; expanded state
// persists to localStorage. Lives directly under <FilterPanel/>.
function Legend({ expanded, setExpanded }) {
  return (
    <div className="border-t">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 hover:bg-slate-50"
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-1.5">
          <Info size={13} /> Legend
        </span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 text-[11px]">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Priority flag</div>
            <div className="space-y-1">
              {FLAG_OPTIONS.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: FLAG_COLORS[k] }} />
                  <span className="capitalize">{k === 'question' ? 'Question (?)' : k}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: RESTRICTION_TINT }} />
                <span>Restricted (no flag set)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: UNFLAGGED_TINT }} />
                <span>No notes</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Restricted stops</div>
            <p className="text-slate-600 mb-2 leading-snug">
              When a stop has equipment restrictions, the pin is replaced by the restriction icon(s) for quick visual scanning.
            </p>
            <div className="space-y-2">
              <LegendMarkerExample
                restrictions={['no_tractor_trailer']}
                label="Single restriction"
              />
              <LegendMarkerExample
                restrictions={['no_tractor_trailer', 'liftgate_required']}
                label="Multiple restrictions"
              />
              <LegendMarkerExample
                restrictions={['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'no_overhead_clearance']}
                label="Four or more — first 2 + overflow"
              />
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Restriction icons</div>
            <div className="space-y-1">
              {Object.entries(RESTRICTION_ICONS)
                .filter(([key]) => key !== 'tractor_trailer_friendly')
                .map(([key, def]) => (
                  <div key={key} className="flex items-center gap-2">
                    <RestrictionIcon kind={key} size={16} />
                    <span>{def.label}</span>
                  </div>
                ))}
              <div className="flex items-center gap-2 pt-1">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[8px] font-bold" style={{ background: '#0f172a' }}>+N</span>
                <span className="text-slate-500">Three or more restrictions</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Allowed (green)</div>
            <div className="flex items-center gap-2">
              <RestrictionIcon kind="tractor_trailer_friendly" size={16} />
              <span>{RESTRICTION_ICONS.tractor_trailer_friendly.label} — stop can take a tractor trailer</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// M4.4 — Filter Toolbar. Floats over the map canvas at top-right with 5
// toggles. Collapsible. State persists to localStorage. Pure presentation;
// the parent applies filters to stops in applyMapFilters().
function MapFilterToggle({ label, checked, onChange, warning, disabled, disabledHint }) {
  return (
    <div className={`relative flex items-center justify-between gap-3 py-1.5 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-slate-700 min-w-0 flex-1 pr-2" title={disabled ? disabledHint : undefined}>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`flex-shrink-0 relative w-9 h-5 rounded-full transition-colors ${disabled ? 'cursor-not-allowed' : ''}`}
        style={{ background: checked && !disabled ? '#16a34a' : '#cbd5e1' }}
        title={disabled ? disabledHint : undefined}
      >
        <span
          className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
          style={{ left: checked && !disabled ? 'calc(100% - 18px)' : '2px' }}
        />
      </button>
      {warning && (
        <span className="absolute right-0 -bottom-4 text-[9px] text-amber-700 italic">{warning}</span>
      )}
    </div>
  );
}

// M5 — Date picker. Native <input type="date"> for accessibility + native
// mobile pickers. Shows the long date when not today, "Today" chip otherwise.
// A "Today" reset button appears only when the selected date isn't today.
function DatePicker({ selectedDate, onChange, onToday, compact }) {
  const today = isTodayET(selectedDate);
  return (
    <div className={`flex items-center gap-1.5 ${compact ? '' : 'bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-2 py-1.5'}`}>
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        className="text-xs border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
        aria-label="Select delivery date"
      />
      {/* "Today" tag only — the native input already shows the full date, so we
          don't repeat it as long text (was a redundant second copy of the date). */}
      {today && (
        <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">Today</span>
      )}
      {!today && (
        <button
          onClick={onToday}
          className="text-[10px] font-semibold py-1 px-2 rounded border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 whitespace-nowrap"
          title="Jump back to today"
        >
          Today
        </button>
      )}
    </div>
  );
}

// Opens Google Street View for a stop — by coordinates when we have them (drops
// the pano right at the dock), else a Maps search on the address. New tab.
function StreetViewLink({ stop, className }) {
  const addr = [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ');
  const url = (stop.lat != null && stop.lng != null)
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${stop.lat},${stop.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className || 'inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1'}
      style={{ minHeight: 44, alignItems: 'center' }}
    >
      <MapPinned size={13} /> Street View
    </a>
  );
}

// Opens the stop in Google Maps (regular map / directions target) — by
// coordinates when available, else an address search. New tab.
function GoogleMapsLink({ stop, className }) {
  const addr = [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ');
  const q = (stop.lat != null && stop.lng != null) ? `${stop.lat},${stop.lng}` : addr;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className || 'inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1'}
      style={{ minHeight: 44, alignItems: 'center' }}
    >
      <MapPin size={13} /> Google Maps
    </a>
  );
}

// "Find business" — a general Google WEB search for the business name + address.
// The plain "Google Maps" link above already covers the map view; this is the
// general search (listing, hours, phone, website, "permanently closed", etc.)
// that helps locate/verify a business whose auto-placed pin looks wrong.
function WebSearchLink({ stop, className }) {
  const q = [stop.businessName, stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(' ');
  if (!q) return null;
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className || 'inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1'}
      style={{ minHeight: 44, alignItems: 'center' }}
    >
      <Search size={13} /> Find business
    </a>
  );
}

// Collapsible per-order line items. NuVizz returns stopDetails (SKU, qty, weight,
// dims, S/L category); we show the one-line summary always and expand to the full
// list on click. Self-contained state so both the desktop sidebar and mobile
// drawer can drop it in without threading props.
// Pallets / loose pieces / total pieces breakdown. NuVizz mislabels its freight fields
// (confirmed by Davis dispatch): the field it calls `cartons` is really PALLETS, `volume`
// is LOOSE pieces, and `pallets` is the TOTAL piece count (pallets + loose). The normalized
// field names still mirror NuVizz's raw naming; we relabel to the real meaning here.
function FreightBreakdown({ stop }) {
  const parts = [];
  if (stop.cartons) parts.push([stop.cartons, `pallet${stop.cartons === 1 ? '' : 's'}`]);
  if (stop.volume) parts.push([stop.volume, `loose pc${stop.volume === 1 ? '' : 's'}`]);
  if (stop.pallets) parts.push([stop.pallets, `total piece${stop.pallets === 1 ? '' : 's'}`]);
  if (!parts.length) return null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
      {parts.map(([n, label], i) => (
        <span key={i}><b className="text-slate-700">{n}</b> {label}</span>
      ))}
    </div>
  );
}

function OrderItemsSection({ stop, defaultOpen = false }) {
  const items = Array.isArray(stop.stopDetails) ? stop.stopDetails : [];
  const [open, setOpen] = useState(defaultOpen);
  // No line-item breakdown available — keep the existing summary-only display.
  if (!items.length) {
    return (
      <div>
        <div className="text-xs uppercase font-semibold text-slate-500">Items</div>
        <div className="text-sm">{stop.itemsSummary || '—'}</div>
        <FreightBreakdown stop={stop} />
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="text-xs uppercase font-semibold text-slate-500">Items ({items.length})</span>
          <span className="block text-sm text-slate-700 truncate">{stop.itemsSummary || '—'}</span>
          <FreightBreakdown stop={stop} />
        </span>
        {open ? <ChevronUp size={15} className="text-slate-400 flex-shrink-0" /> : <ChevronDown size={15} className="text-slate-400 flex-shrink-0" />}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5">
          {items.map((it, i) => {
            const qty = it.quantity != null ? `${it.quantity}${it.quantityUOM ? ' ' + it.quantityUOM : ''}` : null;
            const wt = it.weight != null ? `${it.weight}${it.weightUOM ? ' ' + it.weightUOM : ''}` : null;
            const oversize = it.productCategory === 'L';
            return (
              <li key={i} className="text-[13px] leading-snug">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 break-words text-slate-800">
                    {it.product || it.sku || '(item)'}
                    {oversize && <span className="ml-1 px-1 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold align-middle">L</span>}
                  </span>
                  <span className="flex-shrink-0 text-slate-500 whitespace-nowrap text-right text-[12px]">
                    {[qty, wt].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                {it.sku && it.product && <div className="text-[10px] font-mono text-slate-400 break-all">{it.sku}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Box / lasso selection toolbar. Two tools: Box (drag a rectangle) and Lasso
// (draw a freeform shape). Toggling a tool off cancels it. When a selection
// exists, a count chip clears it. Reused on desktop + mobile.
function SelectionControls({ mode, setMode, count, onClear, onText, onTextDrivers, className }) {
  const btn = (active) =>
    'p-1.5 rounded inline-flex items-center justify-center border ' +
    (active ? 'text-white border-transparent' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50');
  return (
    <div className={'bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow p-0.5 flex items-center gap-0.5 ' + (className || '')}>
      <button onClick={() => setMode(mode === 'box' ? null : 'box')} className={btn(mode === 'box')} style={mode === 'box' ? { background: '#1e5b92' } : undefined} title="Box select — drag a rectangle" aria-label="Box select">
        <Square size={15} />
      </button>
      <button onClick={() => setMode(mode === 'lasso' ? null : 'lasso')} className={btn(mode === 'lasso')} style={mode === 'lasso' ? { background: '#1e5b92' } : undefined} title="Lasso select — draw a shape" aria-label="Lasso select">
        <Lasso size={15} />
      </button>
      {count > 0 && onText && (
        <button onClick={onText} className="p-1.5 rounded text-[11px] font-semibold text-slate-600 hover:bg-slate-100 inline-flex items-center gap-0.5" title="Text selected customers" aria-label="Text selected customers">
          <MessageSquare size={14} />
        </button>
      )}
      {count > 0 && onTextDrivers && (
        <button onClick={onTextDrivers} className="p-1.5 rounded text-[11px] font-semibold text-slate-600 hover:bg-slate-100 inline-flex items-center gap-0.5" title="Text drivers of selected stops" aria-label="Text drivers of selected stops">
          <Truck size={14} />
        </button>
      )}
      {count > 0 && (
        <button onClick={onClear} className="p-1.5 rounded text-[11px] font-semibold text-slate-600 hover:bg-slate-100 inline-flex items-center gap-0.5" title="Clear selection" aria-label="Clear selection">
          <X size={14} />{count}
        </button>
      )}
    </div>
  );
}

// Resolve a customer's text number: prefer a manually-entered notes contact
// phone, fall back to the NuVizz scan's destination contact. Returns '' if none.
function resolveStopPhone(stop, note) {
  const has10 = (p) => p && String(p).replace(/\D/g, '').length >= 10;
  const fromNote = (note?.contacts || []).map((c) => c?.phone).find(has10);
  const fromStop = has10(stop?.contact?.phone) ? stop.contact.phone : null;
  return String(fromNote || fromStop || '').trim();
}

async function postSendSms(payload) {
  const r = await fetch('/.netlify/functions/send-sms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

// Shared SMS compose modal. `recipients` = [{ to?, driverName?, label }]. A
// `driverName` recipient is sent by name — the server resolves the phone from the
// MarginIQ roster (number never reaches the browser). A single `to` recipient
// (customer) gets an editable phone field. Used by Text customer / selected / driver.
function SmsComposeModal({ title, recipients, onClose }) {
  const driverMode = recipients.some((r) => r.driverName);
  const editable = recipients.length === 1 && !driverMode; // customer single → editable phone
  const [text, setText] = useState('');
  const [phone, setPhone] = useState(editable ? (recipients[0].to || '') : '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const chars = text.length;
  const segments = chars === 0 ? 0 : Math.ceil(chars / (chars <= 160 ? 160 : 153));
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneOk = phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith('1'));
  const canSend = !!text.trim() && !sending && (editable ? phoneOk : true);
  const send = async () => {
    if (!canSend) return;
    setSending(true); setResult(null);
    const list = editable
      ? [{ to: phone, label: recipients[0].label }]
      : recipients.map((r) => (r.driverName ? { driverName: r.driverName, label: r.label } : { to: r.to, label: r.label }));
    try {
      const res = await postSendSms({ text: text.trim(), recipients: list });
      setResult(res);
    } catch (e) {
      setResult({ ok: false, error: e.message, results: [] });
    } finally { setSending(false); }
  };
  return (
    <div className="fixed inset-0 z-[1200] bg-slate-900/40 flex items-start justify-center p-4 sm:p-8" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="font-semibold text-slate-800 inline-flex items-center gap-1.5"><MessageSquare size={16} /> {title}</div>
          <button onClick={onClose} className="p-1.5 -mr-1 rounded-full hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {editable ? (
            <label className="block mb-2">
              <span className="text-[11px] font-semibold text-slate-600">To {recipients[0].label || 'customer'}</span>
              <input
                type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone number (10 digits)"
                className={`mt-0.5 w-full border rounded-lg px-2 py-1.5 text-sm ${phone && !phoneOk ? 'border-red-300' : 'border-slate-300'}`}
              />
              {phone && !phoneOk && <span className="text-[10px] text-red-600">Enter a valid 10-digit US number</span>}
            </label>
          ) : driverMode && recipients.length === 1 ? (
            <div className="text-[11px] text-slate-500 mb-2">To <b className="text-slate-700">{recipients[0].label}</b> · number from employee roster</div>
          ) : (
            <div className="text-[11px] text-slate-500 mb-2">To <b className="text-slate-700">{recipients.length} recipients</b></div>
          )}
          {recipients.length > 1 && (
            <div className="mb-2 max-h-24 overflow-y-auto text-[11px] text-slate-500 border border-slate-100 rounded p-1.5">
              {recipients.map((r, i) => <div key={i} className="truncate">{r.label || '—'}{r.to ? ` · ${r.to}` : ''}</div>)}
            </div>
          )}
          {!result && (
            <>
              <textarea
                value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus
                placeholder="Type your message…"
                className="w-full border border-slate-300 rounded-lg p-2 text-sm resize-y"
              />
              <div className="mt-1 text-[10px] text-slate-400">{chars} chars · ~{segments} SMS segment{segments === 1 ? '' : 's'} each</div>
            </>
          )}
          {result && (
            <div className="text-sm">
              <div className={`font-semibold ${result.ok ? 'text-green-700' : 'text-amber-700'}`}>
                {result.sent != null ? `Sent ${result.sent}` : ''}{result.failed ? ` · failed ${result.failed}` : ''}{result.capped ? ` · capped ${result.capped}` : ''}
                {result.error && !result.results?.length ? `Error: ${result.error}` : ''}
              </div>
              {Array.isArray(result.results) && result.results.some((r) => !r.ok) && (
                <div className="mt-2 max-h-32 overflow-y-auto text-[11px] text-slate-500 space-y-0.5">
                  {result.results.filter((r) => !r.ok).map((r, i) => <div key={i} className="truncate">⚠ {r.label || r.to}: {r.error}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          {result
            ? <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: BRAND }}>Done</button>
            : <>
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-slate-600 border border-slate-300">Cancel</button>
                <button onClick={send} disabled={!canSend} className="px-3 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 inline-flex items-center gap-1.5" style={{ background: BRAND }}>
                  <Send size={14} /> {sending ? 'Sending…' : `Send${recipients.length > 1 ? ` (${recipients.length})` : ''}`}
                </button>
              </>}
        </div>
      </div>
    </div>
  );
}

// Transparent capture layer rendered over the map while a select tool is armed.
// Pointer events (mouse + touch) draw the shape in container-pixel space; on
// release the parent converts pixels -> LatLng and tests enclosure. The overlay
// intercepts events so the map itself doesn't pan while drawing.
function SelectionOverlay({ mode, onBox, onLasso }) {
  const elRef = useRef(null);
  const drawingRef = useRef(false);
  const startRef = useRef(null);
  const ptsRef = useRef([]);
  const [rect, setRect] = useState(null);
  const [path, setPath] = useState([]);

  const localXY = (e) => {
    const r = elRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const reset = () => { setRect(null); setPath([]); ptsRef.current = []; startRef.current = null; };

  const onDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = localXY(e);
    drawingRef.current = true;
    if (mode === 'box') { startRef.current = p; setRect({ x: p.x, y: p.y, w: 0, h: 0 }); }
    else { ptsRef.current = [p]; setPath([p]); }
  };
  const onMove = (e) => {
    if (!drawingRef.current) return;
    const p = localXY(e);
    if (mode === 'box') {
      const s = startRef.current;
      setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    } else { ptsRef.current.push(p); setPath(ptsRef.current.slice()); }
  };
  const onUp = (e) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const p = localXY(e);
    if (mode === 'box') {
      const s = startRef.current;
      if (s && (Math.abs(p.x - s.x) > 4 || Math.abs(p.y - s.y) > 4)) onBox(s, p);
    } else if (ptsRef.current.length >= 3) {
      onLasso(ptsRef.current.slice());
    }
    reset();
  };

  return (
    <div
      ref={elRef}
      className="absolute inset-0 z-[15]"
      style={{ cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { drawingRef.current = false; reset(); }}
    >
      {mode === 'box' && rect && (
        <div className="absolute border-2 pointer-events-none" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderColor: '#1e5b92', background: 'rgba(30,91,146,0.15)' }} />
      )}
      {mode === 'lasso' && path.length > 1 && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          <polyline points={path.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(30,91,146,0.12)" stroke="#1e5b92" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

// Floating bar shown while relocating a stop's pin. The dispatcher drags the blue
// pin on the map; this saves (or resets) the per-customer location override.
function MoveLocationBar({ stop, saving, onSave, onCancel, onReset }) {
  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[45] bg-white border border-slate-200 rounded-lg shadow-xl px-3 py-2 flex flex-wrap items-center gap-2 w-[94vw] max-w-md">
      <div className="text-xs text-slate-700 min-w-0">
        <div className="font-semibold truncate max-w-[180px]">{stop.businessName || stop.stopNbr}</div>
        <div className="text-slate-500">Drag the blue pin to the correct spot, then Save.</div>
      </div>
      <button onClick={onReset} disabled={saving} className="text-[11px] px-2 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 min-h-[40px]" title="Clear the saved override (back to NuVizz location)">Reset</button>
      <button onClick={onCancel} disabled={saving} className="text-[11px] px-2 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 min-h-[40px]">Cancel</button>
      <button onClick={onSave} disabled={saving} className="text-xs px-3 py-1.5 rounded text-white font-semibold disabled:opacity-50 min-h-[40px]" style={{ background: '#16a34a' }}>{saving ? 'Saving…' : 'Save location'}</button>
    </div>
  );
}

// Edit a stop's address when NuVizz has it wrong (so the pin lands in the wrong
// place). The corrected address is GEOCODED client-side via the already-loaded
// Google Geocoder; on success we persist BOTH the typed address (address_override,
// shown in the panel) AND the resulting coordinates (location_override, the same
// field the "Correct pin location" drag uses) to customer_notes — so fixing the
// address also moves the pin, for this customer, on every future load.
// ⚠ banner shown on a stop whose addr1 looks mis-split (suite/contact where the
// street should be). "Fix & move pin" applies the suggested swap, re-geocodes
// the clean street and saves the override in one click; "Edit…" opens the modal
// pre-filled with the suggestion. Renders nothing when the address looks fine.
function AddressFixBanner({ stop, note, onAutoFix, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!addressLooksOff(stop, note)) return null;
  const fix = suggestAddressFix(stop);
  const run = async () => {
    if (!fix) { onEdit(stop, null); return; }      // can't auto-split → manual editor
    setErr(null); setBusy(true);
    try { await onAutoFix(stop, fix); }
    catch (e) { setErr(e?.message || 'Could not fix the address'); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-2 p-2 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div><span className="font-semibold">Address may be mis-split.</span> The pin was geocoded from “{stop.addr1}”.</div>
          {fix && <div className="mt-0.5 break-words">Suggested street: <span className="font-mono">{fix.addr1}</span>{fix.addr2 ? <> · suite → <span className="font-mono">{fix.addr2}</span></> : null}</div>}
          {err && <div className="text-red-600 mt-0.5">{err}</div>}
          <div className="flex items-center gap-2 mt-1.5">
            <button onClick={run} disabled={busy} className="px-2 py-1 rounded text-white text-[11px] font-semibold disabled:opacity-50" style={{ background: '#16a34a' }}>
              {busy ? 'Fixing…' : (fix ? 'Fix & move pin' : 'Fix in editor')}
            </button>
            {fix && (
              <button onClick={() => onEdit(stop, fix)} disabled={busy} className="px-2 py-1 rounded border border-amber-300 text-amber-800 text-[11px] font-semibold disabled:opacity-50 hover:bg-amber-100">Edit…</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Geocode a single-line address query via the Google client geocoder. Shared by
// the address-edit modal and the one-click auto-fix. Rejects on any non-OK.
function geocodeAddress(google, q) {
  return new Promise((resolve, reject) => {
    if (!google?.maps?.Geocoder) { reject(new Error('Maps not ready')); return; }
    new google.maps.Geocoder().geocode({ address: q }, (res, status) => {
      if (status === 'OK' && res?.[0]?.geometry?.location) {
        const loc = res[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng(), formatted: res[0].formatted_address });
      } else {
        reject(new Error(status === 'ZERO_RESULTS' ? "Couldn't find that address" : `Geocode failed (${status})`));
      }
    });
  });
}

function AddressEditModal({ stop, note, google, seed, onClose, onSaved }) {
  const ov = note?.address_override || {};
  // `seed` (from the "Fix address" suggestion) wins, then a saved override, then
  // the raw NuVizz field.
  const [addr1, setAddr1] = useState(seed?.addr1 ?? ov.addr1 ?? stop.addr1 ?? '');
  const [addr2, setAddr2] = useState(seed?.addr2 ?? ov.addr2 ?? stop.addr2 ?? '');
  const [city, setCity] = useState(ov.city ?? stop.city ?? '');
  const [state, setState] = useState(ov.state ?? stop.state ?? '');
  const [zip, setZip] = useState(ov.zip ?? stop.zip ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const hasOverride = !!note?.address_override;

  const save = async () => {
    setErr(null);
    // addr2 (suite/dock/contact) is stored but deliberately kept OUT of the
    // geocode query — only the street line + city/state/zip are geocoded.
    const fields = { addr1: addr1.trim(), addr2: addr2.trim(), city: city.trim(), state: state.trim(), zip: zip.trim() };
    const q = [fields.addr1, fields.city, fields.state, fields.zip].filter(Boolean).join(', ');
    if (!q) { setErr('Enter an address'); return; }
    setBusy(true);
    try {
      const geo = await geocodeAddress(google, q);
      await setDoc(doc(db, 'customer_notes', stop.matchKey), {
        match_key: stop.matchKey,
        raw_name: stop.businessName || '',
        address_override: fields,
        address_override_at: serverTimestamp(),
        location_override: { lat: geo.lat, lng: geo.lng },
        location_override_at: serverTimestamp(),
        last_updated: serverTimestamp(),
      }, { merge: true });
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setErr(null);
    try {
      await setDoc(doc(db, 'customer_notes', stop.matchKey), {
        match_key: stop.matchKey, address_override: null, address_override_at: null,
        location_override: null, last_updated: serverTimestamp(),
      }, { merge: true });
      onSaved?.();
      onClose();
    } catch (e) { setErr(e.message || 'Could not reset'); }
    finally { setBusy(false); }
  };

  const field = 'w-full text-sm border border-slate-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-4 space-y-3 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="font-semibold text-slate-800">Edit address</div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded"><X size={18} /></button>
        </div>
        <div className="text-xs text-slate-500 -mt-1">{stop.businessName || stop.stopNbr} · saving re-geocodes and moves the pin for this customer.</div>
        <div className="space-y-2">
          <input className={field} value={addr1} onChange={(e) => setAddr1(e.target.value)} placeholder="Street address" aria-label="Street address" />
          <input className={field} value={addr2} onChange={(e) => setAddr2(e.target.value)} placeholder="Suite / unit / dock (not geocoded)" aria-label="Suite, unit or dock" />
          <div className="grid grid-cols-3 gap-2">
            <input className={field + ' col-span-2'} value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" aria-label="City" />
            <input className={field} value={state} onChange={(e) => setState(e.target.value)} placeholder="State" aria-label="State" />
          </div>
          <input className={field} value={zip} onChange={(e) => setZip(e.target.value)} placeholder="ZIP" aria-label="ZIP" />
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex items-center justify-between gap-2 pt-1">
          {hasOverride
            ? <button onClick={reset} disabled={busy} className="text-[11px] px-2 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50" title="Clear the correction (back to NuVizz address + pin)">Reset to original</button>
            : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button onClick={save} disabled={busy} className="text-xs px-3 py-1.5 rounded text-white font-semibold disabled:opacity-50" style={{ background: '#16a34a' }}>{busy ? 'Saving…' : 'Save & move pin'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// M5 — Show Routes toggle. Sits adjacent to the filter toolbar (top-right),
// same visual treatment, but a standalone control (not in the 5-toggle group).
// M5 — Driver route legend. Collapsible (same pattern as the restriction
// legend). One row per driver: color swatch + display name + stop count.
function DriverRouteLegend({ legend, expanded, setExpanded }) {
  if (!legend.length) return null;
  return (
    <div className="border-t">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 hover:bg-slate-50"
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-1.5"><Truck size={13} /> Routes ({legend.length} drivers)</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1 max-h-48 overflow-y-auto">
          {legend.map((d) => (
            <div key={d.driverUserName} className="flex items-center gap-2 text-[11px]">
              <span className="w-3 h-1.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
              <span className="flex-1 truncate">{d.driverName || d.driverUserName}</span>
              <span className="text-slate-400">{d.stopCount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterToolbar({ filters, setFilters, collapsed, setCollapsed, stopCount, vehicleDisabled, showRoutes, setShowRoutes }) {
  const set = (key) => (v) => setFilters((prev) => ({ ...prev, [key]: v }));
  const clusterWarning = !filters.showClustered && stopCount > 200
    ? `Rendering ${stopCount} markers individually may be slow`
    : null;
  return (
    <div
      className="bg-white rounded-lg shadow-md border border-slate-200 overflow-hidden"
      style={{ width: collapsed ? 'auto' : 240, opacity: 0.97 }}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        aria-expanded={!collapsed}
      >
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Filter size={13} /> Filters
        </span>
        {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2 border-t">
          <MapFilterToggle
            label="Hide terminal markers"
            checked={filters.hideTerminal}
            onChange={set('hideTerminal')}
          />
          <MapFilterToggle
            label="Hide stem out"
            checked={filters.hideStemOut}
            onChange={set('hideStemOut')}
          />
          <MapFilterToggle
            label="Unplanned only"
            checked={filters.unplannedOnly}
            onChange={set('unplannedOnly')}
          />
          <MapFilterToggle
            label="Carry-over unplanned"
            checked={filters.carryover}
            onChange={set('carryover')}
          />
          <MapFilterToggle
            label="Show drivers (live)"
            checked={filters.showVehicleLocation}
            onChange={set('showVehicleLocation')}
            disabled={vehicleDisabled}
            disabledHint="Live drivers only available for today's date."
          />
          {vehicleDisabled && (
            <div className="text-[10px] text-slate-500 italic -mt-1 mb-1 leading-tight">Live drivers only available for today.</div>
          )}
          <MapFilterToggle
            label="Show clustered markers"
            checked={filters.showClustered}
            onChange={set('showClustered')}
          />
          {clusterWarning && (
            <div className="text-[10px] text-amber-700 italic mt-1 leading-tight">{clusterWarning}</div>
          )}
          <MapFilterToggle
            label="Satellite view"
            checked={filters.satellite}
            onChange={set('satellite')}
          />
          {setShowRoutes && (
            <MapFilterToggle
              label="Show routes"
              checked={showRoutes}
              onChange={setShowRoutes}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FilterPanel({ filters, setFilters, counts }) {
  const F = filters;
  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="font-semibold flex items-center gap-2"><Filter size={14} /> Filters</div>
        <button
          onClick={() => setFilters({})}
          className="text-xs text-slate-500 hover:text-slate-800"
        >
          Reset
        </button>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Priority flag</div>
        <div className="flex flex-wrap gap-1.5">
          {[...FLAG_OPTIONS, 'none'].map((v) => {
            const active = (F.flag || []).includes(v);
            const swatch = v === 'none' ? '#cbd5e1' : FLAG_COLORS[v];
            return (
              <button
                key={v}
                onClick={() => {
                  const cur = F.flag || [];
                  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
                  setFilters({ ...F, flag: next.length ? next : undefined });
                }}
                className={`px-2 py-0.5 rounded-full text-[11px] border flex items-center gap-1 ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-700'}`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: swatch }} />
                {v}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Toggle
          label="Appointment required"
          checked={!!F.apptRequired}
          onChange={(b) => setFilters({ ...F, apptRequired: b || undefined })}
        />
        <Toggle
          label="Liftgate required"
          checked={!!F.liftgate}
          onChange={(b) => setFilters({ ...F, liftgate: b || undefined })}
        />
        <Toggle
          label="Has any restriction"
          checked={!!F.hasRestriction}
          onChange={(b) => setFilters({ ...F, hasRestriction: b || undefined })}
        />
        <Toggle
          label="Has receiving hours"
          checked={!!F.hasHours}
          onChange={(b) => setFilters({ ...F, hasHours: b || undefined })}
        />
        <Toggle
          label="Unflagged only (no notes)"
          checked={!!F.unflagged}
          onChange={(b) => setFilters({ ...F, unflagged: b || undefined })}
        />
        <Toggle
          label="Potential address issues"
          checked={!!F.addressIssue}
          onChange={(b) => setFilters({ ...F, addressIssue: b || undefined })}
        />
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Equipment restriction</div>
        <Toggle
          label="Any equipment restriction"
          checked={!!F.anyEquipment}
          onChange={(b) => setFilters({ ...F, anyEquipment: b || undefined })}
        />
        <select
          value={F.equipment || ''}
          onChange={(e) => setFilters({ ...F, equipment: e.target.value || undefined })}
          className="w-full border border-slate-300 rounded px-2 py-1 text-xs mt-1"
          disabled={!!F.anyEquipment}
          title={F.anyEquipment ? 'Showing all equipment restrictions' : undefined}
        >
          <option value="">Any</option>
          {EQUIPMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div className="text-xs text-slate-500 pt-2 border-t">
        Showing <span className="font-semibold text-slate-800">{counts.visible}</span> of {counts.total} stops
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-slate-300"
      />
      <span className="text-xs text-slate-700">{label}</span>
    </label>
  );
}

function applyFilters(stops, notesByKey, filters) {
  return stops.filter((s) => {
    const n = notesByKey.get(s.matchKey);
    if (filters.unflagged && n) return false;
    if (filters.flag && filters.flag.length) {
      const f = n?.priority_flag || 'none';
      if (!filters.flag.includes(f)) return false;
    }
    if (filters.apptRequired && !n?.appointment_required) return false;
    if (filters.liftgate && !n?.liftgate_required) return false;
    if (filters.hasRestriction) {
      const has = !!(n && (
        n.equipment_restrictions?.length || n.liftgate_required || n.appointment_required || n.priority_flag
      ));
      if (!has) return false;
    }
    if (filters.equipment) {
      if (!n?.equipment_restrictions?.includes(filters.equipment)) return false;
    }
    // "Any equipment restriction" — stops carrying at least one equipment flag
    // (the checkbox complement to the specific-restriction dropdown).
    if (filters.anyEquipment && !(n?.equipment_restrictions?.length)) return false;
    // "Potential address issues" — stops the mis-split detector flags (addr1 is a
    // suite/dock/contact while the street is in addr2), so dispatch can sweep them.
    if (filters.addressIssue && !addressLooksOff(s, n)) return false;
    if (filters.hasHours && !referencesReceivingHours(s, n)) return false;
    return true;
  });
}

// Right-side sidebar showing stop + metadata + edit form.
function ProsSection({ stop }) {
  const pros = stop.pros || (stop.pro ? [stop.pro] : []);
  const [copied, setCopied] = useState(null);
  const copy = (pro) => {
    try {
      navigator.clipboard.writeText(pro);
      setCopied(pro);
      setTimeout(() => setCopied((c) => (c === pro ? null : c)), 1200);
    } catch { /* clipboard blocked */ }
  };
  return (
    <div className="px-4 py-3 border-b">
      <div className="text-xs uppercase font-semibold text-slate-500 mb-1.5">
        PROs ({pros.length})
      </div>
      {pros.length === 0 ? (
        <div className="text-xs italic text-slate-400">— No PROs —</div>
      ) : (
        <div className="space-y-0.5">
          {pros.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => copy(p)}
              className="block w-full text-left font-mono text-xs text-slate-700 hover:bg-slate-100 px-1 py-0.5 rounded"
              title="Click to copy"
            >
              {p}
              {copied === p && <span className="ml-2 text-[10px] text-emerald-600 font-sans">copied</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared stop-detail building blocks ──────────────────────────────────────
// SINGLE source of truth for the stop detail + editor, rendered identically by
// the desktop sidebar AND the mobile sheet so the two can never drift. Read-only
// data sections, the full notes editor, and the notes wrapper are all here.

// Read-only data: address (+ fix banner + map links + edit/move), NuVizz
// instructions, delivery window, items, and route. Used by desktop + mobile.
// DNS — "do not send" badge. Red/white pill shown anywhere a DNS customer
// surfaces (map callout context, stop cards, detail, historical search). When
// specific drivers are barred, they're listed in the tooltip + an optional
// inline suffix.
const DNS_COLOR = '#dc2626';
function DnsBadge({ note, showDrivers = false, className = '' }) {
  if (!note?.do_not_send) return null;
  const drivers = Array.isArray(note.dns_drivers) ? note.dns_drivers.filter(Boolean) : [];
  const title = drivers.length ? `Do not send — not allowed: ${drivers.join(', ')}` : 'Do not send';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold text-white flex-shrink-0 ${className}`}
      style={{ background: DNS_COLOR }}
      title={title}
    >
      <Ban size={11} strokeWidth={2.5} /> DNS
      {showDrivers && drivers.length > 0 && (
        <span className="font-semibold normal-case">· {drivers.join(', ')}</span>
      )}
    </span>
  );
}

// Proof-of-delivery documents (photos / signed PDFs). NuVizz returns metadata
// (name / guid / path / extension) on a stop once it's delivered; the actual bytes are
// fetched server-side through /.netlify/functions/nuvizz-pod (documentapi/getdocument with
// Basic creds) so an <img src> can render the photo without exposing credentials.
function podDocUrl(d, opts = {}) {
  const p = new URLSearchParams();
  if (d.documentPath) p.set('documentPath', d.documentPath);
  else {
    if (d.documentGuid) p.set('documentGuid', d.documentGuid);
    if (d.extension) p.set('extension', d.extension);
  }
  if (opts.dataUri) p.set('format', 'datauri');
  return `/.netlify/functions/nuvizz-pod?${p.toString()}`;
}
const isPodImage = (ext) => /^(jpe?g|png|gif|webp)$/i.test(String(ext || ''));

// In-app viewer for a POD photo / document. Opens OVER the app with a clear Close (X) —
// previously these opened via target="_blank", which inside the installed PWA has no
// browser chrome, so a tapped photo/BOL filled the screen with no way back. Esc / backdrop
// / the X / the bottom Close button all dismiss it; an "open in browser" escape hatch
// remains for anyone who wants the native viewer.
function PodViewerModal({ doc, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!doc) return null;
  const src = podDocUrl(doc);
  const isImg = isPodImage(doc.extension);
  const label = doc.documentName || 'Proof of delivery';
  const when = fmtClockShort(doc.createdTime);
  return (
    <div
      className="fixed inset-0 z-[1400] flex flex-col bg-black/90"
      role="dialog" aria-modal="true"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 text-white flex-shrink-0">
        <div className="min-w-0">
          <div className="font-semibold truncate">{label}</div>
          {when && <div className="text-[11px] text-white/70">{when}</div>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <a href={src} target="_blank" rel="noopener noreferrer" className="p-2 rounded-full hover:bg-white/15 text-white/90" title="Open in browser" aria-label="Open in browser"><ExternalLink size={18} /></a>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-white/15" aria-label="Close" style={{ minWidth: 44, minHeight: 44 }}><X size={22} /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto" onClick={onClose}>
        {isImg ? (
          <img src={src} alt={label} className="max-w-full max-h-full object-contain" onClick={(e) => e.stopPropagation()} />
        ) : (
          <iframe title={label} src={src} className="w-full h-full bg-white" onClick={(e) => e.stopPropagation()} />
        )}
      </div>
      <div className="px-4 py-2 flex-shrink-0 text-center">
        <button onClick={onClose} className="px-5 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-semibold" style={{ minHeight: 44 }}>Close</button>
      </div>
    </div>
  );
}

function PodDocsSection({ stop, onRefreshed }) {
  const [viewDoc, setViewDoc] = useState(null);
  const docs = Array.isArray(stop?.podDocs) ? stop.podDocs : [];
  const delivered = classifyStopStatus(stop) === 'DELIVERED';
  const [loading, setLoading] = useState(false);
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState(null);
  // Pull the driver's capture photos on demand (NuVizz doesn't return the doc metadata
  // until we re-pull the stop). One /stop/info via pro-lookup, folded into the card so the
  // photo grid renders below. Same call the "Refresh from NuVizz" button makes.
  const loadPhotos = async () => {
    const pro = stop.primaryPro || stop.pro || stop.stopNbr;
    if (!pro || loading) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/.netlify/functions/nuvizz-pro-lookup?pro=' + encodeURIComponent(pro), { cache: 'no-store' });
      const d = await r.json();
      if (d.ok && d.stop) { setTried(true); onRefreshed?.(d.stop); }
      else setErr(d.reason || 'not found');
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };
  // No docs on the stop yet. For a DELIVERED order, the driver almost always captured a
  // photo — surface an explicit button to fetch it (this is the button the dispatcher was
  // looking for). For a not-yet-delivered order there's nothing to show.
  if (!docs.length) {
    if (!delivered) return null;
    return (
      <div className="pt-2">
        <div className="text-xs uppercase font-semibold text-slate-500 flex items-center gap-1.5">
          <FileCheck size={13} /> Proof of delivery
        </div>
        <button
          onClick={loadPhotos}
          disabled={loading}
          className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-blue-700 border border-blue-300 rounded hover:bg-blue-50 active:bg-blue-100 disabled:opacity-50"
        >
          <ImageIcon size={13} className={loading ? 'animate-pulse' : ''} />
          {loading ? 'Loading photo…' : 'View delivery photo'}
        </button>
        {err && <div className="text-[11px] text-amber-700 mt-1">Couldn’t load photo: {err}</div>}
        {tried && !err && <div className="text-[11px] text-slate-400 mt-1">No delivery photo on file for this order.</div>}
      </div>
    );
  }
  const photos = docs.filter((d) => isPodImage(d.extension));
  const others = docs.filter((d) => !isPodImage(d.extension));
  return (
    <div className="pt-2">
      <div className="text-xs uppercase font-semibold text-slate-500 flex items-center gap-1.5">
        <FileCheck size={13} /> Proof of delivery
      </div>
      {photos.length > 0 && (
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {photos.map((d, i) => (
            <button
              key={d.documentGuid || i} type="button" onClick={() => setViewDoc(d)}
              className="block w-full" title={`${d.documentName || 'POD photo'}${fmtClockShort(d.createdTime) ? ` · ${fmtClockShort(d.createdTime)}` : ''}`}
            >
              <img
                src={podDocUrl(d)} alt={d.documentName || 'POD photo'} loading="lazy"
                className="w-full h-20 object-cover rounded border border-slate-200 bg-slate-50"
                onError={(e) => { const b = e.currentTarget.closest('button'); if (b) b.style.display = 'none'; }}
              />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="mt-1 space-y-1">
          {others.map((d, i) => {
            const label = d.documentName || `POD document${d.extension ? ` (.${d.extension})` : ''}`;
            const when = fmtClockShort(d.createdTime);
            return (
              <li key={d.documentGuid || d.documentPath || i} className="text-xs text-slate-700 flex items-center gap-1.5 break-words">
                <button type="button" onClick={() => setViewDoc(d)} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                  {label} <Eye size={12} />
                </button>
                {d.extension && <span className="px-1 rounded bg-slate-100 text-slate-500 text-[9px] uppercase">{d.extension}</span>}
                {when && <span className="text-slate-400">· {when}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <PodViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </div>
  );
}

// ── Bill of Lading (printable) ───────────────────────────────────────────────
// A faithful replica of the NuVizz Bill of Lading PDF, generated entirely from the
// already-enriched stop data — NO API call. Available on every order. Field → source
// mapping (NuVizz mislabels several fields; we read the normalized values):
//   Order# laneNumber · Terms scheduleAttribute · Whse proNumber · Cust# reference2
//   BOLID bol · PRO# stopNbr · Date to.schedule.timeTo · PO reference1
//   Ship To to.address + contact.phone · Buyer contact (name/email/phone)
//   Special Instructions comments · Line items stopDetails (cat/qty/uom/product/class/weight)
//   # Skids totalCartons · # Loose volume · Total Pieces totalPallets · Weight weight
const bolEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bolNum = (n, dp = 1) => (n == null || n === '' || isNaN(Number(n)) ? '' : Number(n).toFixed(dp));

function bolData(stop) {
  const raw = (stop && stop.raw && stop.raw.stop) || {};
  const toAddr = raw.to?.address || {};
  const contact = stop.contact || raw.to?.contact || {};
  const comments = Array.isArray(stop.allComments) && stop.allComments.length
    ? stop.allComments
    : (raw.comments || []).map((c) => ({ text: c.commentDescription }));
  const items = (Array.isArray(stop.stopDetails) && stop.stopDetails.length ? stop.stopDetails : (raw.stopDetails || []));
  const lineWtSum = items.reduce((a, it) => a + (Number(it.weight) || 0), 0);
  const weight = (stop.weight != null ? Number(stop.weight) : null) ?? (raw.weight != null ? Number(raw.weight) : null) ?? lineWtSum;
  return {
    orderNbr: stop.orderNbr ?? raw.laneNumber ?? '',
    terms: stop.terms ?? raw.scheduleAttribute ?? '',
    whse: stop.warehouse ?? raw.proNumber ?? '',
    custRef: stop.custRef ?? raw.reference2 ?? '',
    bol: stop.bol ?? raw.bol ?? '',
    pro: stop.stopNbr || stop.pro || '',
    dateTime: stop.scheduledTo ?? raw.to?.schedule?.timeTo ?? '',
    po: stop.poRef ?? raw.reference1 ?? '',
    shipName: stop.businessName ?? toAddr.name ?? '',
    shipAddr1: stop.addr1 ?? toAddr.addr1 ?? '',
    shipAddr2: stop.addr2 ?? toAddr.addr2 ?? '',
    shipCity: stop.city ?? toAddr.city ?? '',
    shipState: stop.state ?? toAddr.state ?? '',
    shipZip: stop.zip ?? toAddr.zip ?? '',
    phone: contact.phone ?? contact.sms ?? '',
    buyerName: contact.name ?? contact.contactName ?? '',
    buyerEmail: contact.email ?? '',
    comments: comments.map((c) => c.text).filter(Boolean),
    items: items.map((it) => ({
      sl: it.productCategory ?? '', pc: it.quantity ?? '', pkg: it.quantityUOM ?? '',
      desc: it.product ?? it.sku ?? '', cls: it.referenceText ?? '', wt: it.weight,
    })),
    skids: Number(stop.cartons ?? raw.totalCartons ?? 0) || 0,
    loose: Number(stop.volume ?? raw.volume ?? 0) || 0,
    totalPieces: Number(stop.pallets ?? raw.totalPallets ?? 0) || 0,
    weight,
  };
}

function buildBolHtml(stop, logoUrl) {
  const d = bolData(stop);
  const cityLine = [d.shipCity, [d.shipState, d.shipZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const MIN_ROWS = 12;
  const rows = d.items.map((it) => `
      <tr>
        <td class="c">${bolEsc(it.sl)}</td>
        <td class="c">${bolEsc(it.pc)}</td>
        <td class="c">${bolEsc(it.pkg)}</td>
        <td>${bolEsc(it.desc)}</td>
        <td class="c">${bolEsc(it.cls)}</td>
        <td class="r">${bolNum(it.wt)}</td>
      </tr>`).join('');
  const filler = Array.from({ length: Math.max(0, MIN_ROWS - d.items.length) }, () =>
    '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  const instr = d.comments.length ? d.comments.map((c) => bolEsc(c)).join('<br/>') : '&nbsp;';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill of Lading ${bolEsc(d.pro)}</title>
<style>
  @page { size: letter portrait; margin: 0.4in; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; font-size:11px; padding:10px; }
  .top { display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid #1e5b92; padding-bottom:6px; margin-bottom:8px; }
  .top img { height:46px; width:auto; }
  .title { font-size:20px; font-weight:bold; text-decoration:underline; color:#111; }
  td, .grid2 > div, .si { word-break:break-word; overflow-wrap:anywhere; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; }
  .meta td { border:1px solid #111; padding:3px 5px; vertical-align:top; font-size:10.5px; }
  .lbl { font-weight:bold; }
  .box { border:1px solid #111; padding:4px 6px; }
  .grid2 { display:flex; gap:0; margin-top:6px; }
  .grid2 > div { border:1px solid #111; padding:5px 7px; width:50%; }
  .grid2 > div + div { border-left:0; }
  .sec-h { font-weight:bold; font-size:10px; text-transform:uppercase; color:#333; margin-bottom:2px; }
  .si { margin-top:6px; }
  .items { margin-top:6px; }
  .items th { border:1px solid #111; background:#eee; padding:3px 5px; font-size:9.5px; text-transform:uppercase; }
  .items td { border:1px solid #111; padding:3px 5px; height:16px; }
  .items td.c, .items th.c { text-align:center; }
  .items td.r, .items th.r { text-align:right; }
  .totals { display:flex; justify-content:flex-end; margin-top:6px; }
  .totals table td { border:1px solid #111; padding:3px 7px; font-size:10.5px; }
  .sig { margin-top:26px; font-size:11px; }
</style></head>
<body>
  <div class="top">
    <img src="${bolEsc(logoUrl)}" alt="Davis Delivery Service"/>
    <div class="title">Bill of Lading</div>
    <div style="width:46px"></div>
  </div>

  <table class="meta"><tbody>
    <tr>
      <td style="width:34%"><span class="lbl">Order#:</span> ${bolEsc(d.orderNbr)}</td>
      <td style="width:33%"><span class="lbl">BOLID:</span> ${bolEsc(d.bol)}</td>
      <td style="width:33%"><span class="lbl">Date and Time:</span> ${bolEsc(d.dateTime)}</td>
    </tr>
    <tr>
      <td><span class="lbl">Terms:</span> ${bolEsc(d.terms)}</td>
      <td><span class="lbl">PRO#:</span> ${bolEsc(d.pro)}</td>
      <td><span class="lbl">Page:</span> 1 of 1</td>
    </tr>
    <tr>
      <td><span class="lbl">Whse:</span> ${bolEsc(d.whse)}</td>
      <td></td>
      <td><span class="lbl">PO:</span> ${bolEsc(d.po)}</td>
    </tr>
    <tr>
      <td><span class="lbl">Cust#:</span> ${bolEsc(d.custRef)}</td>
      <td></td>
      <td></td>
    </tr>
  </tbody></table>

  <div class="grid2">
    <div>
      <div class="sec-h">Ship To</div>
      ${bolEsc(d.shipName)}<br/>
      ${d.shipAddr1 ? bolEsc(d.shipAddr1) + '<br/>' : ''}${d.shipAddr2 ? bolEsc(d.shipAddr2) + '<br/>' : ''}${bolEsc(cityLine)}<br/>
      <span class="lbl">Phone Number:</span> ${bolEsc(d.phone)}
    </div>
    <div>
      <div class="sec-h">Buyer</div>
      <span class="lbl">Name:</span> ${bolEsc(d.buyerName)}<br/>
      <span class="lbl">Email:</span> ${bolEsc(d.buyerEmail)}<br/>
      <span class="lbl">Phone Number:</span> ${bolEsc(d.phone)}
    </div>
  </div>

  <div class="si box">
    <div class="sec-h">Special Instructions</div>
    ${instr}
  </div>

  <table class="items"><thead>
    <tr>
      <th class="c" style="width:10%">SKID/LOOSE</th>
      <th class="c" style="width:7%">PC</th>
      <th class="c" style="width:9%">PKG</th>
      <th>FREIGHT ID DESCRIPTION</th>
      <th class="c" style="width:12%">CLASS</th>
      <th class="r" style="width:14%">WEIGHT (Lbs)</th>
    </tr></thead>
    <tbody>${rows}${filler}</tbody>
  </table>

  <div class="totals">
    <table><tbody>
      <tr><td class="lbl"># Of Skids: ${d.skids}</td><td class="lbl">Sub Weight: ${bolNum(d.weight)}</td></tr>
      <tr><td class="lbl"># of Loose: ${bolNum(d.loose)}</td><td></td></tr>
      <tr><td class="lbl">Total Pieces: ${d.totalPieces}</td><td class="lbl">Total Weight: ${bolNum(d.weight)}</td></tr>
    </tbody></table>
  </div>

  <div class="sig">Customer Signature: ______________________________________</div>
</body></html>`;
}

// Full-screen viewer for a printable document (Delivery Ticket / Bill of Lading). Renders
// the supplied HTML in an iframe (so Print outputs just the document) and scales the page
// to fit the screen. `pageW` is the doc's CSS layout width (816 portrait / 1056 landscape
// Letter @ 96dpi). No API call.
function PrintDocModal({ title, html, pageW = 816, onClose }) {
  const iframeRef = useRef(null);
  const wrapRef = useRef(null);
  const PAGE_W = pageW;
  const [scale, setScale] = useState(1);   // scale the whole page to fit the screen
  const [pageH, setPageH] = useState(Math.round(pageW * 1.294)); // ~Letter aspect until measured
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const fit = () => { const w = (wrapRef.current?.clientWidth || PAGE_W) - 16; setScale(Math.min(1, w / PAGE_W)); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const onLoad = () => {
    try { const h = iframeRef.current?.contentWindow?.document?.body?.scrollHeight; if (h && h > 120) setPageH(h + 8); } catch { /* same-origin srcdoc — safe */ }
  };
  const doPrint = () => { try { iframeRef.current?.contentWindow?.focus(); iframeRef.current?.contentWindow?.print(); } catch { /* popup/print blocked */ } };
  return (
    <div className="fixed inset-0 z-[1400] flex flex-col bg-slate-900/80" role="dialog" aria-modal="true"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-between gap-2 px-4 py-3 text-white flex-shrink-0">
        <div className="font-semibold truncate">{title}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={doPrint} className="px-3 py-2 rounded-lg bg-white text-slate-900 text-sm font-semibold inline-flex items-center gap-1.5"><Printer size={16} /> Print</button>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-white/15" aria-label="Close" style={{ minWidth: 44, minHeight: 44 }}><X size={22} /></button>
        </div>
      </div>
      <div ref={wrapRef} className="flex-1 min-h-0 overflow-auto p-2 flex justify-center">
        <div style={{ width: PAGE_W * scale, height: pageH * scale }} className="flex-shrink-0">
          <iframe
            ref={iframeRef} title={title || 'Document'} srcDoc={html} onLoad={onLoad}
            style={{ width: PAGE_W, height: pageH, border: 0, background: 'white', transform: `scale(${scale})`, transformOrigin: 'top left', boxShadow: '0 2px 14px rgba(0,0,0,0.35)' }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Delivery Ticket (printable) ──────────────────────────────────────────────
// A faithful replica of NuVizz's per-stop Delivery Ticket / manifest, generated from the
// enriched stop data — NO API call. Field → source: seq routeSeq · type stopType ·
// PRO stopNbr · BOL bol · Ship-To to.address + contact.phone · Requested schedule from/to ·
// summary weight / volume(loose) / cartons(pallets) / pallets(total pieces) · line items
// stopDetails · Comments allComments · Next Stop plannedEtaDTTM.
const TKT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function tktReqTime(iso) {   // "23 Jun 2026 08:00 AM"
  const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return '';
  let h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${+m[3]} ${TKT_MON[+m[2] - 1]} ${m[1]} ${String(h).padStart(2, '0')}:${m[5]} ${ap}`;
}
function tktReqClock(iso) {   // "08:00 PM"
  const m = String(iso || '').match(/[T ](\d{2}):(\d{2})/);
  if (!m) return '';
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m[2]} ${ap}`;
}
function tktDayOffset(a, b) {
  const A = String(a || '').slice(0, 10), B = String(b || '').slice(0, 10);
  if (!A || !B || A === B) return 0;
  return Math.round((Date.parse(B) - Date.parse(A)) / 86400000) || 0;
}
function tktNextStop(iso) {   // "06/26/2026 10:32:29 AM"
  const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${m[2]}/${m[3]}/${m[1]} ${String(h).padStart(2, '0')}:${m[5]}:${m[6]} ${ap}`;
}
function tktCommentTime(iso) {   // comment addedOn is UTC → show in ET, "Jun 22, 2026, 7:05:13 PM"
  if (!iso) return '';
  const d = new Date(/[Zz]$/.test(iso) ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  } catch { return String(iso); }
}
function ticketData(stop) {
  const raw = (stop && stop.raw && stop.raw.stop) || {};
  const exec = (stop && stop.raw && stop.raw.stopExecutionInfo) || {};
  const toAddr = raw.to?.address || {};
  const contact = stop.contact || raw.to?.contact || {};
  const comments = (Array.isArray(stop.allComments) && stop.allComments.length)
    ? stop.allComments.map((c) => ({ text: c.text, by: c.addedBy, on: c.addedOn }))
    : (raw.comments || []).map((c) => ({ text: c.commentDescription, by: c.addedByName, on: c.addedOn }));
  const items = (Array.isArray(stop.stopDetails) && stop.stopDetails.length ? stop.stopDetails : (raw.stopDetails || []));
  const idStr = (it) => {
    const pid = it.productIdentifier ?? it.sku ?? '';
    return typeof pid === 'string' ? pid : (pid?.value || pid?.id || pid?.code || '');
  };
  return {
    seq: stop.routeSeq ?? raw.to?.seq ?? '',
    type: ((stop.stopType || raw.stopType) === 'PU') ? 'Pick Up' : 'Drop Off',
    pro: stop.stopNbr || stop.pro || '',
    bol: stop.bol ?? raw.bol ?? '',
    shipName: stop.businessName ?? toAddr.name ?? '',
    shipAddr1: stop.addr1 ?? toAddr.addr1 ?? '',
    shipAddr2: stop.addr2 ?? toAddr.addr2 ?? '',
    shipCity: stop.city ?? toAddr.city ?? '', shipState: stop.state ?? toAddr.state ?? '', shipZip: stop.zip ?? toAddr.zip ?? '',
    phone: contact.phone ?? contact.sms ?? '',
    reqFrom: stop.scheduledFrom ?? raw.to?.schedule?.timeFrom ?? '',
    reqTo: stop.scheduledTo ?? raw.to?.schedule?.timeTo ?? '',
    weight: Number(stop.weight ?? raw.weight ?? 0) || 0,
    loose: Number(stop.volume ?? raw.volume ?? 0) || 0,
    pallets: Number(stop.cartons ?? raw.totalCartons ?? 0) || 0,
    totalPieces: Number(stop.pallets ?? raw.totalPallets ?? 0) || 0,
    items: items.map((it) => ({ po: it.product ?? '', ident: idStr(it), qty: it.quantity ?? '', wt: it.weight })),
    comments,
    nextStop: exec.to?.plannedEtaDTTM ?? stop.plannedEtaDTTM ?? '',
  };
}
// The Delivery-Ticket CSS, shared by the single-stop ticket and the multi-stop manifest
// (the manifest concatenates many ticket bodies, so the styles must live in one place).
const TICKET_STYLE = `
  @page { size: letter portrait; margin: 0.4in; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; font-size:11px; padding:8px; }
  .brand { display:flex; align-items:center; gap:8px; border-bottom:2px solid #1e5b92; padding-bottom:5px; margin-bottom:8px; }
  .brand img { height:34px; width:auto; }
  .brand .t { font-size:15px; font-weight:bold; color:#1e5b92; }
  .head { display:flex; justify-content:space-between; gap:16px; }
  .head .row1 { display:flex; align-items:center; gap:10px; }
  .seq { border:1px solid #111; border-radius:14px; min-width:24px; height:24px; padding:0 7px; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; }
  .type { border:1px solid #111; border-radius:13px; padding:2px 10px; font-weight:bold; }
  .pro { font-size:20px; font-weight:bold; letter-spacing:0.5px; }
  .lbl { font-weight:bold; }
  .ship { text-align:right; }
  .ship .h { font-weight:bold; }
  .meta { margin-top:4px; }
  .summary { display:flex; border:1px solid #ccc; border-radius:4px; margin:8px 0; background:#f6f7f9; }
  .summary > div { flex:1; text-align:center; padding:6px 4px; border-right:1px solid #e2e5ea; font-weight:bold; }
  .summary > div:last-child { border-right:0; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; }
  .items th { border-bottom:1px solid #bbb; background:#f0f1f3; padding:4px 6px; text-align:left; font-size:10px; }
  .items td { border-bottom:1px solid #e6e6e6; padding:4px 6px; word-break:break-word; }
  .items td.c, .items th.c { text-align:center; }
  .items td.r, .items th.r { text-align:right; }
  .cmts-h { font-weight:bold; margin:10px 0 4px; }
  .cmts { display:grid; grid-template-columns:1fr 1fr; }
  .cmt { border:1px solid #111; padding:5px 7px; min-height:34px; }
  .cmt-t { font-weight:bold; }
  .cmt-m { display:flex; justify-content:space-between; color:#444; font-size:10px; margin-top:6px; }
  .sign { display:flex; gap:12px; margin-top:14px; align-items:flex-end; }
  .sign .f { font-size:11px; }
  .sign .sigbox { border:1px solid #111; height:54px; }
  .sign .col { display:flex; flex-direction:column; }
  .next { text-align:right; font-weight:bold; margin-top:8px; }`;

// The INNER markup of one Delivery Ticket (no <html>/<style> wrapper) — so it can be
// emitted standalone (buildTicketHtml) or concatenated into the manifest (buildManifestHtml).
function ticketBody(stop, logoUrl, brandTitle = 'Delivery Ticket') {
  const d = ticketData(stop);
  const cityLine = [d.shipCity, [d.shipState, d.shipZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const reqLine = (d.reqFrom || d.reqTo) ? `${tktReqTime(d.reqFrom)} - ${tktReqClock(d.reqTo)} +${tktDayOffset(d.reqFrom, d.reqTo)}D` : '';
  const MIN_ROWS = 6;
  const itemRows = d.items.map((it) => `
      <tr>
        <td>${bolEsc(it.po)}</td>
        <td>${bolEsc(it.ident)}</td>
        <td class="c">${bolEsc(it.qty)}</td>
        <td class="c">-/-</td>
        <td class="r">${it.wt == null || it.wt === '' ? '' : Number(it.wt).toLocaleString() + ' Lbs'}</td>
        <td></td>
      </tr>`).join('');
  const itemFiller = Array.from({ length: Math.max(0, MIN_ROWS - d.items.length) }, () =>
    '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  const commentCells = d.comments.map((c) => `
      <div class="cmt">
        <div class="cmt-t">${bolEsc(c.text)}</div>
        <div class="cmt-m"><span>~By ${bolEsc(c.by || '')}</span><span>${bolEsc(tktCommentTime(c.on))}</span></div>
      </div>`).join('');
  return `
  <div class="brand"><img src="${bolEsc(logoUrl)}" alt="Davis Delivery Service"/><div class="t">${bolEsc(brandTitle)}</div></div>
  <div class="head">
    <div class="l">
      <div class="row1">
        <span class="seq">${bolEsc(d.seq)}</span>
        <span class="type">${bolEsc(d.type)}</span>
        <span class="pro">${bolEsc(d.pro)}</span>
      </div>
      <div class="meta"><span class="lbl">BOL:</span> ${bolEsc(d.bol)}</div>
      <div class="meta"><span class="lbl">Requested Date &amp; Time:</span><br/>${bolEsc(reqLine)}</div>
    </div>
    <div class="ship">
      <div class="h">Ship To:</div>
      ${bolEsc(d.shipName)}<br/>
      ${d.shipAddr1 ? bolEsc(d.shipAddr1) + ',<br/>' : ''}${d.shipAddr2 ? bolEsc(d.shipAddr2) + ',<br/>' : ''}${bolEsc(cityLine)}<br/>
      <span class="lbl">Call:</span> ${bolEsc(d.phone)}
    </div>
  </div>
  <div class="summary">
    <div>${Number(d.weight).toLocaleString()} Lbs</div>
    <div>${d.loose} Loose</div>
    <div>${d.pallets} Pallets</div>
    <div>${d.totalPieces} Total Pieces</div>
  </div>
  <table class="items"><thead>
    <tr><th style="width:22%">PO</th><th style="width:22%">PO Identifier</th><th class="c" style="width:10%">Quantity</th><th class="c" style="width:24%">Exceptions/Comments</th><th class="r" style="width:12%">Weight</th><th style="width:10%">Volume</th></tr>
  </thead><tbody>${itemRows}${itemFiller}</tbody></table>
  <div class="cmts-h">Comments:</div>
  <div class="cmts">${commentCells}</div>
  <div class="sign">
    <div class="col" style="min-width:160px"><span class="f"><span class="lbl">Signed By:</span> _____________</span><span class="f" style="margin-top:10px"><span class="lbl">Actual Time:</span> ___________</span></div>
    <div class="col" style="flex:1"><span class="f lbl">Signature:</span><div class="sigbox"></div></div>
    <div class="col" style="flex:1"><span class="f lbl">Driver Comment:</span><div class="sigbox"></div></div>
  </div>
  ${d.nextStop ? `<div class="next">Next Stop: ${bolEsc(tktNextStop(d.nextStop))}</div>` : ''}`;
}
function buildTicketHtml(stop, logoUrl) {
  const d = ticketData(stop);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Delivery Ticket ${bolEsc(d.pro)}</title>
<style>${TICKET_STYLE}</style></head>
<body>${ticketBody(stop, logoUrl)}</body></html>`;
}

// ── Driver Manifest (printable) ──────────────────────────────────────────────
// The whole route as one print job: a summary cover page (route, origin, requested window,
// stop count, driver, freight totals) followed by every stop's Delivery Ticket in route
// order (the same order as the route detail list + numbered map pins). NO API call — built
// from the enriched stops we already hold.
function manifestOrigin(stops) {
  for (const s of stops) {
    const f = s?.raw?.stop?.from?.address;
    if (f && (f.addr1 || f.name || f.city)) {
      const cityLine = [f.city, [f.state, f.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return [f.name, f.addr1, f.addr2, cityLine].filter(Boolean).join(', ');
    }
  }
  return '';
}
function buildManifestHtml(stops, logoUrl) {
  const ordered = orderRouteStops(stops);
  const routeName = ordered.find((s) => s.routeName)?.routeName || ordered.find((s) => s.loadNbr)?.loadNbr || 'Route';
  const driver = ordered.find((s) => s.driverName)?.driverName || ordered.find((s) => s.driverUserName)?.driverUserName || '—';
  const origin = manifestOrigin(ordered);
  // Per-stop ticket data once, reused for the totals and the page bodies.
  const data = ordered.map((s) => ticketData(s));
  const froms = data.map((d) => d.reqFrom).filter(Boolean).sort();
  const tos = data.map((d) => d.reqTo).filter(Boolean).sort();
  const windowStr = (froms[0] || tos[0])
    ? `${tktReqTime(froms[0] || tos[0])}${tos.length ? ' – ' + tktReqTime(tos[tos.length - 1]) : ''}`
    : '';
  const tot = data.reduce((a, d) => ({
    weight: a.weight + (Number(d.weight) || 0),
    loose: a.loose + (Number(d.loose) || 0),
    pallets: a.pallets + (Number(d.pallets) || 0),
    pieces: a.pieces + (Number(d.totalPieces) || 0),
  }), { weight: 0, loose: 0, pallets: 0, pieces: 0 });
  const pages = ordered.map((s) => `<section class="tkt">${ticketBody(s, logoUrl)}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Driver Manifest ${bolEsc(routeName)}</title>
<style>${TICKET_STYLE}
  /* Page 1 = summary header + the first ticket; every ticket after starts a new page,
     and no single ticket is ever split across a page boundary. */
  .tkt { padding:8px; break-inside: avoid; page-break-inside: avoid; }
  .tkt + .tkt { break-before: page; page-break-before: always; }
  .mf-head { margin-bottom:6px; }
  .mf-route { font-size:26px; font-weight:bold; color:#1e5b92; line-height:1.1; }
  .mf-grid { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin-top:8px; font-size:12px; }
  .mf-grid .k { font-weight:bold; color:#444; white-space:nowrap; }
</style></head>
<body>
  <div class="brand"><img src="${bolEsc(logoUrl)}" alt="Davis Delivery Service"/><div class="t">Driver Manifest</div></div>
  <div class="mf-head">
    <div class="mf-route">${bolEsc(routeName)}</div>
    <div class="mf-grid">
      ${origin ? `<div class="k">Origin</div><div>${bolEsc(origin)}</div>` : ''}
      ${windowStr ? `<div class="k">Requested</div><div>${bolEsc(windowStr)}</div>` : ''}
      <div class="k">Stops</div><div>${ordered.length} Stop${ordered.length === 1 ? '' : 's'}</div>
      <div class="k">Driver</div><div>${bolEsc(driver)}</div>
    </div>
  </div>
  <div class="summary">
    <div>${Math.round(tot.weight).toLocaleString()} Lbs</div>
    <div>${tot.loose} Loose</div>
    <div>${tot.pallets} Pallets</div>
    <div>${tot.pieces} Total Pieces</div>
  </div>
  ${pages}
</body></html>`;
}

// "2026-06-23T15:35:26" → "Jun 23, 3:35 PM" (NuVizz event/comment timestamps are local ET).
function fmtNoteTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(s || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${months[+m[2] - 1]} ${+m[3]}, ${h}:${m[5]} ${ap}`;
}

const COMMENT_TYPE_LABEL = { ORD_IN: 'Order instruction', PRE_VISIT: 'Pre-visit', GEN: 'General' };

// The full NuVizz comment list — the portal's "Driver Instruction" panel: EVERY comment
// (order instructions, pre-visit, billing, …) with its type, author + time. Strips the
// SPL-INSTR-TEXT prefix and hides the "DO NOT BREAKDOWN SKID" boilerplate (per request).
function StopNotesList({ comments }) {
  const rows = (comments || [])
    .map((c) => ({ ...c, text: String(c.text || '').replace(/^\s*SPL-INSTR-TEXT\s*:?\s*/i, '').trim() }))
    .filter((c) => c.text && !/do\s*not\s*break\s*down\s*skid/i.test(c.text));
  if (!rows.length) return null;
  return (
    <div className="pt-1">
      <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Notes</div>
      <div className="space-y-1.5">
        {rows.map((c, i) => {
          const label = c.typeDesc || COMMENT_TYPE_LABEL[c.type] || c.type || 'Note';
          const meta = [c.addedBy, c.source, c.addedOn && fmtNoteTime(c.addedOn)].filter(Boolean).join(' · ');
          return (
            <div key={i} className="rounded bg-slate-50 border border-slate-200 px-2 py-1">
              <div className="text-xs text-slate-800 whitespace-pre-wrap break-words leading-snug">{c.text}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{label}{meta ? ` — ${meta}` : ''}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Activity timeline (the portal's "Activity Timeline"). Collapsed by default; the FIRST
// time it's expanded it calls /.netlify/functions/nuvizz-stop-events on demand — even if
// Refresh wasn't pressed. Prefers the rich /event/eventinfo (By:/From:) when stopId is known.
function StopActivityTimeline({ stopNbr, stopId, onRefreshed }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ loading: false, events: null, error: null });
  useEffect(() => {
    if (!open || st.events || st.loading) return;
    let cancelled = false;
    setSt((s) => ({ ...s, loading: true, error: null }));
    const qs = new URLSearchParams();
    if (stopNbr) qs.set('stopNbr', stopNbr);
    if (stopId) qs.set('stopId', stopId);
    fetch('/.netlify/functions/nuvizz-stop-events?' + qs.toString(), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setSt({ loading: false, events: d.ok ? (d.events || []) : [], error: d.ok ? null : (d.reason || 'failed') });
        // Opening the timeline already costs a /stop/info — fold that fresh detail back into
        // the card so any newly-added notes/items show without a separate Refresh.
        if (d.ok && d.stop && onRefreshed) onRefreshed(d.stop);
      })
      .catch((e) => { if (!cancelled) setSt({ loading: false, events: [], error: e.message }); });
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="pt-2 mt-2 border-t">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-xs uppercase font-semibold text-slate-500">
        <span className="inline-flex items-center gap-1"><Activity size={12} /> Activity timeline</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="mt-1.5">
          {st.loading && <div className="text-xs text-slate-500">Loading…</div>}
          {!st.loading && st.error && <div className="text-[11px] text-amber-700">Couldn’t load timeline: {st.error}</div>}
          {!st.loading && st.events && !st.error && st.events.length === 0 && <div className="text-xs text-slate-500">No activity recorded.</div>}
          {!st.loading && st.events && st.events.length > 0 && (
            <ol className="space-y-1.5">
              {st.events.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <div className="flex-shrink-0 w-1.5 h-1.5 mt-1.5 rounded-full bg-slate-400" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800">{e.name || '—'}</div>
                    <div className="text-[10px] text-slate-500">
                      {[fmtNoteTime(e.dttm), e.user && `by ${e.user}`, e.company && `from ${e.company}`].filter(Boolean).join(' · ')}
                    </div>
                    {e.lat != null && e.lng != null && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-0.5"
                      >
                        <MapPin size={10} /> {Number(e.lat).toFixed(5)}, {Number(e.lng).toFixed(5)}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// Notes + Refresh + Activity timeline for the open stop. Refresh re-pulls the order from
// NuVizz (/stop/info via nuvizz-pro-lookup) and merges the fresh detail — full comment
// list, stopId, route sequence — into a LOCAL copy so the panel updates immediately. Keyed
// by stop number at the call site so it resets when a different order is opened.
function StopLiveDetail({ stop, onRefreshed }) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(null);
  const refresh = async () => {
    const pro = stop.primaryPro || stop.pro || stop.stopNbr;
    if (!pro || refreshing) return;
    setRefreshing(true); setRefreshErr(null);
    try {
      const r = await fetch('/.netlify/functions/nuvizz-pro-lookup?pro=' + encodeURIComponent(pro), { cache: 'no-store' });
      const d = await r.json();
      if (d.ok && d.stop) onRefreshed?.(d.stop);
      else setRefreshErr(d.reason || 'not found');
    } catch (e) { setRefreshErr(e.message); }
    finally { setRefreshing(false); }
  };
  const cleaned = cleanInstructions(stop.signalSources?.orderInstructions);
  return (
    <div className="pt-1 space-y-2">
      <div>
        <button onClick={refresh} disabled={refreshing} className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-blue-700 border border-blue-200 rounded-md px-3 py-1.5 hover:bg-blue-50 active:bg-blue-100 disabled:opacity-50">
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh from NuVizz'}
        </button>
      </div>
      {refreshErr && <div className="text-[11px] text-amber-700">Couldn’t refresh: {refreshErr}</div>}
      {stop.allComments?.length ? (
        <StopNotesList comments={stop.allComments} />
      ) : cleaned ? (
        <div className="pt-1">
          <div className="text-xs uppercase font-semibold text-slate-500">NuVizz instructions</div>
          <div className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-snug">{cleaned}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">Refresh to load all notes</div>
        </div>
      ) : null}
      <StopActivityTimeline stopNbr={stop.stopNbr || stop.pro} stopId={stop.stopId} onRefreshed={onRefreshed} />
    </div>
  );
}

// Owns the "live" overlay for an open stop. A Refresh / timeline-open / "View delivery
// photo" pull merges fresh /stop/info fields over the board stop, so the WHOLE card — the
// header status badge included — reflects the latest NuVizz state (e.g. a stop the board
// still shows Scheduled flips to Delivered once its real status 90 comes back). Resets when
// a different stop opens. Returns [liveStop, onRefreshed].
function useLiveStop(stop) {
  const stopKey = stop?.stopNbr || stop?.pro;
  const [fresh, setFresh] = useState(null);
  const [prevKey, setPrevKey] = useState(stopKey);
  if (stopKey !== prevKey) { setPrevKey(stopKey); setFresh(null); }
  const live = fresh ? { ...stop, ...fresh } : stop;
  const onRefreshed = useCallback((d) => { if (d) setFresh((prev) => ({ ...(prev || {}), ...d })); }, []);
  return [live, onRefreshed];
}

function StopDataSections({ stop, note, onRefreshed, onOpenRoute, onMoveLocation, onEditAddress, onAutoFixAddress, onText }) {
  // `stop` is the already-merged "live" stop the PARENT owns (see useLiveStop). The parent
  // holds the refresh overlay so the header status badge updates too — not just this body.
  // `onRefreshed` bubbles a fresh /stop/info pull (Refresh button, timeline open, or the
  // "View delivery photo" button) back up to that parent.
  const live = stop;
  const stopKey = stop.stopNbr || stop.pro;
  const [showTicket, setShowTicket] = useState(false);
  const ticketHtml = useMemo(
    () => (showTicket ? buildTicketHtml(live, (typeof window !== 'undefined' ? window.location.origin : '') + '/davis-logo.jpg') : ''),
    [showTicket, live],
  );
  const textPhone = resolveStopPhone(live, note);
  return (
    <div className="px-4 py-3 border-b text-sm space-y-1">
      <div>
        <div className="text-xs uppercase font-semibold text-slate-500 flex items-center gap-1.5">
          Address
          {note?.address_override && <span className="px-1 rounded bg-blue-100 text-blue-700 text-[9px] font-semibold normal-case">corrected</span>}
        </div>
        <div className="break-words">{note?.address_override?.addr1 || live.addr1}</div>
        {(note?.address_override?.addr2 ?? live.addr2) && (
          <div className="text-xs px-2 py-1 mt-1 bg-amber-50 border border-amber-200 rounded text-amber-900 break-words">
            <span className="font-semibold">addr2:</span> {note?.address_override?.addr2 ?? live.addr2}
          </div>
        )}
        <div className="text-slate-600 break-words">
          {(note?.address_override?.city ?? live.city)}, {(note?.address_override?.state ?? live.state)} {(note?.address_override?.zip ?? live.zip)}
        </div>
        <AddressFixBanner stop={live} note={note} onAutoFix={onAutoFixAddress} onEdit={onEditAddress} />
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-1">
          <StreetViewLink stop={live} />
          <GoogleMapsLink stop={live} />
          <WebSearchLink stop={live} />
        </div>
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
          {onEditAddress && (
            <button onClick={() => onEditAddress(live)} className="mt-1.5 inline-flex items-center gap-1 text-xs text-blue-700 hover:underline">
              <MapPin size={13} /> Edit address
            </button>
          )}
          {onMoveLocation && (
            <button onClick={() => onMoveLocation(live)} className="mt-1.5 inline-flex items-center gap-1 text-xs text-blue-700 hover:underline">
              <MapPin size={13} /> Correct pin location{note?.location_override ? ' · custom saved' : ''}
            </button>
          )}
          {onText && (
            <button onClick={() => onText(live)} className="mt-1.5 inline-flex items-center gap-1 text-xs text-blue-700 hover:underline">
              <MessageSquare size={13} /> Text customer{textPhone ? '' : ' (add #)'}
            </button>
          )}
        </div>
      </div>
      <div className="pt-2">
        <OrderItemsSection stop={live} />
      </div>
      <div className="pt-2">
        <button
          onClick={() => setShowTicket(true)}
          className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-white rounded-md px-3 py-2"
          style={{ background: BRAND }}
        >
          <FileText size={14} /> Delivery Ticket
        </button>
      </div>
      {showTicket && (
        <PrintDocModal
          title={`Delivery Ticket · PRO ${live.pro || live.stopNbr || ''}`}
          html={ticketHtml}
          pageW={816}
          onClose={() => setShowTicket(false)}
        />
      )}
      <StopLiveDetail key={stopKey} stop={live} onRefreshed={onRefreshed} />
      <PodDocsSection stop={live} onRefreshed={onRefreshed} />
      <div className="pt-2 mt-2 border-t">
        <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Route</div>
        {live.loadNbr ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-slate-900 truncate">{live.routeName || live.loadNbr}</div>
              {live.driverName && <div className="text-xs text-slate-500 truncate">{live.driverName}</div>}
              {live.routeName && <div className="text-[10px] text-slate-400 font-mono">{live.loadNbr}</div>}
            </div>
            {onOpenRoute && (
              <button
                onClick={() => onOpenRoute(live.loadNbr)}
                className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-blue-700 border border-blue-300 rounded hover:bg-blue-50 active:bg-blue-100"
              >
                View full route
              </button>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-500 italic">Not yet assigned</div>
        )}
      </div>
      {live.listUpdatedDTTM && fmtClockShort(live.listUpdatedDTTM) && (
        <div className="pt-2 text-[11px] text-slate-400">Updated {fmtClockShort(live.listUpdatedDTTM)}</div>
      )}
    </div>
  );
}

// The COMPLETE customer-notes editor — every editable field on a stop. `compact`
// (desktop) tightens controls; otherwise controls use 44px touch targets.
// `draft` is the working note; `setDraft` takes a PARTIAL patch and merges it
// (the parent tracks dirty state + persists).
function StopNotesEditor({ draft, setDraft, compact = false, drivers = [] }) {
  const D = draft;
  const setD = (patch) => setDraft(patch);
  // DNS — barred-driver list. Names sourced from the app's known drivers.
  const driverNames = [...new Set((drivers || []).map((d) => d?.driverName).filter(Boolean))].sort();
  const barred = Array.isArray(D.dns_drivers) ? D.dns_drivers : [];
  const toggleBarredDriver = (name) => {
    const next = barred.includes(name) ? barred.filter((n) => n !== name) : [...barred, name];
    setD({ dns_drivers: next });
  };
  const [copyToast, setCopyToast] = useState(false);
  const setHours = (day, partial) => {
    const existing = D.receiving_hours?.[day] || { open: '', close: '' };
    const merged = typeof existing === 'string'
      ? { open: '', close: '', ...partial }
      : { open: existing.open || '', close: existing.close || '', ...partial };
    setD({
      receiving_hours: { ...D.receiving_hours, [day]: merged },
      manual_overrides: { ...(D.manual_overrides || {}), receiving_hours: true },
    });
  };
  const toggleClosed = (day) => {
    const current = Array.isArray(D.closed_days) ? D.closed_days : [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    setD({ closed_days: next, manual_overrides: { ...(D.manual_overrides || {}), closed_days: true } });
  };
  const isClosed = (day) => Array.isArray(D.closed_days) && D.closed_days.includes(day);
  const copyMondayToWeekdays = () => {
    const monClosed = isClosed('mon');
    const monHours = D.receiving_hours?.mon;
    const monHasHours = monHours && (typeof monHours === 'object' ? (monHours.open || monHours.close) : monHours);
    if (!monClosed && !monHasHours) return;
    const weekdays = ['tue', 'wed', 'thu', 'fri'];
    const patch = {
      receiving_hours: { ...(D.receiving_hours || {}) },
      closed_days: Array.isArray(D.closed_days) ? [...D.closed_days] : [],
      manual_overrides: { ...(D.manual_overrides || {}), receiving_hours: true, closed_days: true },
    };
    for (const d of weekdays) {
      if (monClosed) {
        if (!patch.closed_days.includes(d)) patch.closed_days.push(d);
      } else {
        patch.closed_days = patch.closed_days.filter((x) => x !== d);
        patch.receiving_hours[d] = typeof monHours === 'string' ? monHours : { open: monHours.open || '', close: monHours.close || '' };
      }
    }
    setD(patch);
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 1500);
  };
  const getOpen = (day) => { const v = D.receiving_hours?.[day]; if (!v || typeof v === 'string') return ''; return v.open || ''; };
  const getClose = (day) => { const v = D.receiving_hours?.[day]; if (!v || typeof v === 'string') return ''; return v.close || ''; };
  const getLegacyString = (day) => { const v = D.receiving_hours?.[day]; return typeof v === 'string' ? v : ''; };
  const toggleRestriction = (val) => {
    const cur = D.equipment_restrictions || [];
    setD({ equipment_restrictions: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] });
  };
  const addContact = () => setD({ contacts: [...(D.contacts || []), { name: '', phone: '', role: '' }] });
  const setContact = (i, patch) => { const next = [...(D.contacts || [])]; next[i] = { ...next[i], ...patch }; setD({ contacts: next }); };
  const removeContact = (i) => setD({ contacts: (D.contacts || []).filter((_, idx) => idx !== i) });

  // Tap-target sizing: compact = desktop density; otherwise 44px min targets.
  const pad = compact ? 'px-2 py-1' : 'px-3 py-2';
  const tap = compact ? undefined : { minHeight: 44 };

  return (
    <div className="space-y-4 text-sm">
      {/* Notify CS — email customer service the first time this customer is
          scheduled each day (handled server-side by the scan). */}
      <div className="rounded-lg border p-2" style={D.notify_cs ? { borderColor: '#2563eb', background: '#eff6ff' } : { borderColor: '#e2e8f0' }}>
        <button
          onClick={() => setD({ notify_cs: !D.notify_cs })}
          style={{ ...tap, ...(D.notify_cs ? { background: '#2563eb', borderColor: '#2563eb', color: '#fff' } : {}) }}
          className={`w-full flex items-center justify-between gap-2 ${pad} rounded border text-xs font-semibold ${D.notify_cs ? '' : 'border-slate-300 bg-white text-slate-700'}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <MessageSquare size={14} strokeWidth={2.5} style={{ color: D.notify_cs ? '#fff' : '#2563eb' }} />
            Email customer service when scheduled
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${D.notify_cs ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>{D.notify_cs ? 'ON' : 'OFF'}</span>
        </button>
        {D.notify_cs && (
          <div className="mt-1 text-[10px] text-slate-500">CS gets one email the first time this customer appears on a day's board.</div>
        )}
      </div>
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Priority flag</div>
        <div className="flex flex-wrap gap-1.5">
          {[null, ...FLAG_OPTIONS].map((v) => {
            const active = D.priority_flag === v;
            const swatch = v ? FLAG_COLORS[v] : '#e2e8f0';
            return (
              <button key={String(v)} onClick={() => setD({ priority_flag: v })} style={tap}
                className={`${pad} rounded border text-xs flex items-center gap-1.5 ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: swatch }} />
                {v === 'question' ? '?' : (v || 'none')}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Delivery window</div>
        <div className="flex flex-wrap gap-1.5">
          {[null, 'AM', 'PM'].map((v) => {
            const active = (D.delivery_window || null) === v;
            return (
              <button key={String(v)} onClick={() => setD({ delivery_window: v })} style={tap}
                title={v ? `Tag this stop ${v} — shows an ${v} pin on the map` : 'No AM/PM tag'}
                className={`${pad} rounded border text-xs font-semibold ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
                {v || 'none'}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Receiving hours</div>
        <div className="grid grid-cols-7 gap-1 mb-2">
          {DAYS.map((d) => {
            const closed = isClosed(d);
            return (
              <button key={d} type="button" onClick={() => toggleClosed(d)}
                className={`text-[10px] uppercase font-semibold py-1 rounded border ${closed ? 'bg-red-100 border-red-300 text-red-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                title={closed ? `${d.toUpperCase()} closed — click to open` : `${d.toUpperCase()} open — click to mark closed`}>
                {d}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 mb-2">
          <button type="button" onClick={copyMondayToWeekdays}
            disabled={!isClosed('mon') && !(D.receiving_hours?.mon && (typeof D.receiving_hours.mon === 'string' ? D.receiving_hours.mon : (D.receiving_hours.mon.open || D.receiving_hours.mon.close)))}
            className="text-[10px] py-1 px-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Apply Monday's hours/closed state to Tuesday-Friday">
            Copy to all weekdays (Mon-Fri)
          </button>
          {copyToast && <span className="text-[10px] text-emerald-600">Copied</span>}
        </div>
        <div className="space-y-1">
          {DAYS.map((d) => {
            const closed = isClosed(d);
            const legacy = getLegacyString(d);
            return (
              <div key={d} className="flex items-center gap-2">
                <div className="w-10 text-[10px] uppercase font-semibold text-slate-500 flex-shrink-0">{d}</div>
                {closed ? (
                  <div className="flex-1 flex items-center justify-between gap-2 px-2 py-1 rounded bg-red-50 border border-red-200">
                    <span className="text-[11px] font-semibold text-red-700">Closed</span>
                    <button type="button" onClick={() => toggleClosed(d)} className="text-[10px] text-blue-600 hover:underline">Edit</button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <input type="time" value={getOpen(d)} onChange={(e) => setHours(d, { open: e.target.value })} className="flex-1 min-w-0 border border-slate-300 rounded px-1 py-1 text-[11px]" aria-label={`${d} open time`} />
                    <span className="text-[10px] text-slate-400 flex-shrink-0">–</span>
                    <input type="time" value={getClose(d)} onChange={(e) => setHours(d, { close: e.target.value })} className="flex-1 min-w-0 border border-slate-300 rounded px-1 py-1 text-[11px]" aria-label={`${d} close time`} />
                  </div>
                )}
                {legacy && !closed && <div className="text-[9px] text-amber-700 italic flex-shrink-0" title={`Legacy free-text value: ${legacy}`}>(legacy)</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Toggle label="Appointment required" checked={!!D.appointment_required} onChange={(b) => setD({ appointment_required: b })} />
        <Toggle label="Liftgate required" checked={!!D.liftgate_required} onChange={(b) => setD({ liftgate_required: b })} />
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Appointment notes</div>
        <input value={D.appointment_notes || ''} onChange={(e) => setD({ appointment_notes: e.target.value })} className="w-full border border-slate-300 rounded px-2 py-1 text-xs" style={tap} />
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Equipment restrictions</div>
        <div className="flex flex-wrap gap-1.5">
          {EQUIPMENT_OPTIONS.map((o) => {
            const active = (D.equipment_restrictions || []).includes(o.value);
            return (
              <button key={o.value} onClick={() => toggleRestriction(o.value)} style={tap}
                className={`${pad} rounded-full text-[11px] border inline-flex items-center gap-1.5 ${active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-slate-300 text-slate-700'}`}>
                <RestrictionIcon kind={o.value} size={14} />
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Dock type</div>
        <div className="flex flex-wrap gap-1.5">
          {[...DOCK_TYPES, { value: null, label: 'unknown' }].map((o) => {
            const active = (D.dock_type ?? null) === o.value;
            return (
              <button key={String(o.value)} onClick={() => setD({ dock_type: o.value })} style={tap}
                className={`${pad} rounded border text-xs ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Dock notes</div>
        <textarea value={D.dock_notes || ''} onChange={(e) => setD({ dock_notes: e.target.value })} rows={3} className="w-full border border-slate-300 rounded px-2 py-1 text-xs" />
      </div>

      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1 flex items-center justify-between">
          <span>Contacts</span>
          <button onClick={addContact} className="text-xs text-blue-600 inline-flex items-center gap-0.5 hover:underline"><Plus size={11} /> add</button>
        </div>
        <div className="space-y-1.5">
          {(D.contacts || []).map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1 items-center">
              <input value={c.name || ''} onChange={(e) => setContact(i, { name: e.target.value })} placeholder="Name" className="min-w-0 border border-slate-300 rounded px-1.5 py-1 text-xs" />
              <input value={c.phone || ''} onChange={(e) => setContact(i, { phone: e.target.value })} placeholder="Phone" className="min-w-0 border border-slate-300 rounded px-1.5 py-1 text-xs" />
              <input value={c.role || ''} onChange={(e) => setContact(i, { role: e.target.value })} placeholder="Role" className="min-w-0 border border-slate-300 rounded px-1.5 py-1 text-xs" />
              <button onClick={() => removeContact(i)} className="text-slate-400 hover:text-red-600 flex-shrink-0"><Trash2 size={14} /></button>
            </div>
          ))}
          {(!D.contacts || !D.contacts.length) && <div className="text-xs text-slate-400 italic">none</div>}
        </div>
      </div>

      {/* DNS — do not send + which drivers are barred. Placed LAST in the panel: it's
          rarely used, so the common fields (priority, hours, restrictions, …) come first. */}
      <div className="rounded-lg border p-2" style={D.do_not_send ? { borderColor: DNS_COLOR, background: '#fef2f2' } : { borderColor: '#e2e8f0' }}>
        <button
          onClick={() => setD({ do_not_send: !D.do_not_send })}
          style={{ ...tap, ...(D.do_not_send ? { background: DNS_COLOR, borderColor: DNS_COLOR, color: '#fff' } : {}) }}
          className={`w-full flex items-center justify-between gap-2 ${pad} rounded border text-xs font-semibold ${D.do_not_send ? '' : 'border-slate-300 bg-white text-slate-700'}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Ban size={14} strokeWidth={2.5} style={{ color: D.do_not_send ? '#fff' : DNS_COLOR }} />
            Do not send (DNS)
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${D.do_not_send ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>{D.do_not_send ? 'ON' : 'OFF'}</span>
        </button>
        {D.do_not_send && (
          <div className="mt-2">
            <div className="text-[11px] font-semibold text-slate-600 mb-1">Drivers not allowed (tap to bar)</div>
            {driverNames.length === 0 ? (
              <div className="text-[11px] text-slate-400 italic">No drivers found (fleet roster unavailable and none on today's board). Leave blank for a general do-not-send.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {driverNames.map((name) => {
                  const on = barred.includes(name);
                  return (
                    <button key={name} onClick={() => toggleBarredDriver(name)} style={tap}
                      className={`${pad} rounded border text-xs ${on ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
                      {on ? '✕ ' : ''}{name}
                    </button>
                  );
                })}
              </div>
            )}
            {barred.length > 0 && (
              <div className="mt-1 text-[10px] text-slate-500">Barred: {barred.join(', ')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Customer-notes section wrapper: the Edit toggle, the read-only view, the full
// editor, and recent-PRO history. Shared by desktop + mobile.
function StopNotesSection({ note, editing, setEditing, draft, setDraft, compact = false, drivers = [] }) {
  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase font-semibold text-slate-500">Customer notes</div>
        {!editing && (
          compact
            ? <button onClick={() => setEditing(true)} className="text-xs text-blue-600 hover:underline">Edit</button>
            : <button onClick={() => setEditing(true)} className="px-3 py-1.5 text-xs text-white font-semibold rounded" style={{ background: BRAND, minHeight: 36 }}>Edit</button>
        )}
      </div>
      {!editing && !note && <div className="text-xs text-slate-500 italic">No notes yet. {compact ? 'Click' : 'Tap'} Edit to add.</div>}
      {!editing && note && <ReadOnlyNoteView note={note} />}
      {editing && <StopNotesEditor draft={draft} setDraft={setDraft} compact={compact} drivers={drivers} />}
      {note?.pro_history?.length > 0 && (
        <div className="pt-2 border-t">
          <div className="text-xs font-semibold text-slate-600 mb-1">Recent PROs at this customer</div>
          <div className="flex flex-wrap gap-1">
            {[...note.pro_history].reverse().slice(0, 10).map((h, i) => (
              <span key={i} className="text-[10px] bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">{h.pro} · {h.date}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StopSidebar({ stop, note, onClose, onSave, saving, saveError, onOpenRoute, onMoveLocation, onEditAddress, onAutoFixAddress, onText, drivers = [], mobile = false }) {
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(!note);
  // True once the dispatcher edits the draft; cleared on stop-change and save.
  // Guards against a background note write (async load, scanner, another device)
  // resetting the draft mid-edit and silently wiping in-progress changes — the
  // root cause of "I set the hours but they didn't save".
  const dirtyRef = useRef(false);
  // Re-init only when a DIFFERENT stop opens.
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(!note);
    dirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop?.stopNbr]);
  // Adopt a note that loads/updates after the stop opened — but NEVER while the
  // dispatcher has unsaved edits, or their work would be clobbered.
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(note || emptyNote(stop));
    setEditing(!note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);

  // The live overlay: a Refresh / timeline open updates the status badge below, so a board
  // stop still tagged Scheduled flips to Delivered once its real status comes back.
  const [live, onRefreshed] = useLiveStop(stop);
  if (!stop) return null;
  const sidebarStatusKind = classifyStopStatus(live);
  const sidebarArrivedAt = (sidebarStatusKind === 'ARRIVED' || sidebarStatusKind === 'DELIVERED')
    ? fmtClockShort(live.arrivalDTTM || execArrivalTs(live.raw?.stopExecutionInfo || {})) : null;
  const sidebarDeliveredAt = sidebarStatusKind === 'DELIVERED'
    ? fmtClockShort(live.deliveredDTTM || execDeliveredTs(live.raw?.stopExecutionInfo || {})) : null;
  const D = draft;
  // setD merges a PARTIAL patch and marks the draft dirty (guards background
  // writes from clobbering in-progress edits). All field helpers live in the
  // shared <StopNotesEditor>.
  const setD = (patch) => { dirtyRef.current = true; setDraft({ ...D, ...patch }); };

  return (
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ background: BRAND, color: 'white' }}>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-wide opacity-90">PRO {stop.pro || '—'}</div>
          <div className="font-bold truncate">{stop.businessName || '(no name)'}</div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded"><X size={20} /></button>
      </div>

      {/* M5.1 — execution-status badge bar */}
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
        <StatusBadge kind={sidebarStatusKind} />
        <DnsBadge note={note} showDrivers />
        {sidebarDeliveredAt && <span className="text-[11px] text-slate-500">Delivered {sidebarDeliveredAt}</span>}
        {sidebarArrivedAt && <span className="text-[11px] text-slate-500">Arrived {sidebarArrivedAt}</span>}
      </div>

      <div className="overflow-y-auto flex-1">
        <StopDataSections stop={live} note={note} onRefreshed={onRefreshed} onOpenRoute={onOpenRoute} onMoveLocation={onMoveLocation} onEditAddress={onEditAddress} onAutoFixAddress={onAutoFixAddress} onText={onText} />
        <ProsSection stop={live} />
        <StopNotesSection note={note} editing={editing} setEditing={setEditing} draft={D} setDraft={setD} compact drivers={drivers} />
      </div>

      {editing && (
        <div className="flex-shrink-0 border-t px-4 py-2 flex items-center justify-between gap-2 bg-slate-50">
          {saveError && <span className="text-xs text-red-600 truncate">{saveError}</span>}
          <div className="ml-auto flex gap-2">
            {note && (
              <button onClick={() => { dirtyRef.current = false; setDraft(note); setEditing(false); }} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded">
                Cancel
              </button>
            )}
            <button
              onClick={() => { dirtyRef.current = false; onSave(D); }}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-white font-semibold rounded inline-flex items-center gap-1 disabled:opacity-50"
              style={{ background: BRAND }}
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

// ---------- M4.1 driver day-snapshot sidebar ----------

function fmtClockShort(ts) {
  if (!ts) return null;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return null; }
}

function fmtDurationHm(secs) {
  if (secs == null) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function classifyTimeliness(scheduledIso, actualIso) {
  if (!scheduledIso || !actualIso) return null;
  const sched = new Date(scheduledIso).getTime();
  const act = new Date(actualIso).getTime();
  if (Number.isNaN(sched) || Number.isNaN(act)) return null;
  const deltaMin = Math.round((act - sched) / 60000);
  let kind = 'ontime';
  if (deltaMin > 15) kind = 'late';
  else if (deltaMin < -15) kind = 'early';
  return { deltaMin, kind };
}

function StopStatusIcon({ status }) {
  if (status === 'completed') return <span style={{ color: '#16a34a' }}>✓</span>;
  if (status === 'en_route' || status === 'current')
    return <span style={{ color: '#1e5b92' }} className="inline-block animate-pulse">▶</span>;
  return <span style={{ color: '#94a3b8' }}>○</span>;
}

function DriverSnapshotSidebar({ driver, snapshot, loading, error, onClose, onPanToStop, onText, mobile = false }) {
  if (!driver) return null;
  return (
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
      <DriverSnapshotHeader driver={driver} snapshot={snapshot} onClose={onClose} onText={onText} />
      <DriverSnapshotBody
        driver={driver}
        snapshot={snapshot}
        loading={loading}
        error={error}
        onPanToStop={onPanToStop}
      />
    </aside>
  );
}

function DriverSnapshotHeader({ driver, snapshot, onClose, onText }) {
  const truckLabel = driver.vehicleNumber || `(truck ${driver.vehicleId || '?'})`;
  const driverName = driver.driverName || '(no driver)';
  const hos = snapshot?.hos || null;
  return (
    <div className="px-4 py-3 border-b flex-shrink-0" style={{ background: BRAND, color: 'white' }}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-wider opacity-75 hover:opacity-100 inline-flex items-center gap-1"
        >
          <ArrowLeft size={11} /> Back to stops
        </button>
        {onText && driver.driverName && (
          <button
            onClick={() => onText(driver.driverName)}
            className="text-[11px] font-semibold inline-flex items-center gap-1 bg-white/15 hover:bg-white/25 rounded px-2 py-1"
            title={`Text ${driverName}`}
          >
            <MessageSquare size={12} /> Text driver
          </button>
        )}
      </div>
      <div className="font-bold">Truck {truckLabel} · {driverName}</div>
      {hos && (
        <div className="text-[11px] opacity-80 mt-0.5">
          {hos.loggedInAt && <>Logged in {fmtClockShort(hos.loggedInAt)}</>}
          {hos.loggedInAt && hos.onDutySeconds != null && ' · '}
          {hos.onDutySeconds != null && <>{fmtDurationHm(hos.onDutySeconds)} on duty</>}
        </div>
      )}
    </div>
  );
}

function DriverSnapshotBody({ driver, snapshot, loading, error, onPanToStop }) {
  const route = snapshot?.route || null;
  const stops = Array.isArray(snapshot?.stops) ? snapshot.stops : [];

  const nextStop = useMemo(() => {
    if (!stops.length) return null;
    return stops.find((s) => s.status !== 'completed') || null;
  }, [stops]);

  const eta = useMemo(() => {
    if (!nextStop || nextStop.lat == null || nextStop.lng == null) return null;
    if (driver.lat == null || driver.lng == null) return null;
    const mins = naiveEtaMinutes(
      { lat: driver.lat, lng: driver.lng },
      { lat: nextStop.lat, lng: nextStop.lng },
    );
    return { minutes: mins, clock: formatEtaClockTime(mins) };
  }, [driver?.lat, driver?.lng, nextStop?.lat, nextStop?.lng]);

  const onTimePct = useMemo(() => {
    const completed = stops.filter((s) => s.status === 'completed');
    if (!completed.length) return null;
    const onTime = completed.filter((s) => {
      const t = classifyTimeliness(s.scheduledTime, s.actualArrival || s.actualCompletion);
      return t?.kind === 'ontime' || t?.kind === 'early';
    }).length;
    return { onTime, total: completed.length, pct: Math.round((onTime / completed.length) * 100) };
  }, [stops]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-sm" data-sheet-scroll>
      {loading && <SnapshotSkeleton />}

      {error && !loading && (
        <div className="m-3 px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded text-amber-900">
          {error}
        </div>
      )}

      {!loading && (
          <>
            <SnapshotSection title="Route Summary">
              {route ? (
                <>
                  <div className="font-semibold text-slate-900">
                    Route {route.id || '—'} · {route.totalStops ?? stops.length} stops today
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Completed: <span className="font-semibold text-slate-900">{route.completed ?? stops.filter((s) => s.status === 'completed').length}</span>
                    {'   '}Remaining: <span className="font-semibold text-slate-900">{route.remaining ?? stops.filter((s) => s.status !== 'completed').length}</span>
                  </div>
                </>
              ) : (
                <div className="text-xs italic text-slate-500">No route assigned today</div>
              )}

              {nextStop && (
                <div className="mt-2 pt-2 border-t">
                  <div className="text-[10px] uppercase font-semibold text-slate-500">Next stop</div>
                  <div className="text-sm font-semibold text-slate-900">{nextStop.businessName || nextStop.name || '—'}</div>
                  <div className="text-xs text-slate-600">
                    {[nextStop.addr1, nextStop.city, nextStop.state].filter(Boolean).join(', ') || '—'}
                  </div>
                  {eta?.minutes != null && (
                    <div className="text-xs text-slate-700 mt-0.5">
                      ETA: <span className="font-semibold">{eta.clock}</span>
                      {eta.minutes != null && <> ({Math.round(eta.minutes)} min away)</>}
                    </div>
                  )}
                </div>
              )}
            </SnapshotSection>

            <SnapshotSection title="Today's Stops">
              {stops.length === 0 ? (
                <div className="text-xs italic text-slate-500">No stops loaded</div>
              ) : (
                <ul className="space-y-0.5">
                  {stops.map((s, i) => {
                    const timeliness = classifyTimeliness(s.scheduledTime, s.actualArrival || s.actualCompletion);
                    const late = timeliness?.kind === 'late';
                    const isClickable = s.lat != null && s.lng != null && onPanToStop;
                    return (
                      <li
                        key={s.pro || s.stopNbr || i}
                        onClick={isClickable ? () => onPanToStop(s) : undefined}
                        className={`flex items-center gap-2 text-xs px-1 py-0.5 rounded ${isClickable ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                      >
                        <span className="w-3 text-center"><StopStatusIcon status={s.status} /></span>
                        <span className="w-12 font-mono text-[10px] text-slate-500">{fmtClockShort(s.scheduledTime) || '—'}</span>
                        <span className="flex-1 truncate">{s.businessName || s.name || s.pro || '—'}</span>
                        {(s.primaryPro || s.pro) && (
                          <span
                            className="font-mono text-[10px] text-slate-400"
                            title={(s.pros || (s.pro ? [s.pro] : [])).join('\n')}
                          >
                            {s.primaryPro || s.pro}
                            {((s.proCount ?? (s.pros?.length || 0)) > 1) && (
                              <span className="text-slate-300"> +{(s.proCount ?? s.pros.length) - 1}</span>
                            )}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500">
                          {s.status === 'completed' && timeliness && (
                            timeliness.kind === 'ontime'
                              ? <span className="text-emerald-600">on-time</span>
                              : timeliness.kind === 'early'
                              ? <span className="text-slate-500">{Math.abs(timeliness.deltaMin)} min early</span>
                              : <span className="text-red-600">{timeliness.deltaMin} min late ⚠</span>
                          )}
                          {(s.status === 'en_route' || s.status === 'current') && <span className="text-blue-700">en route</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SnapshotSection>

            <SnapshotSection title="Live Telemetry">
              <div className="grid grid-cols-[16px_1fr] gap-x-2 gap-y-1 items-center text-xs">
                <Gauge size={12} className="text-slate-400" />
                <div>Speed: <span className="font-semibold">{driver.speedMph != null ? `${Math.round(driver.speedMph)} mph` : '—'}</span></div>
                <Clock size={12} className="text-slate-400" />
                <div>
                  Last ping: <span className="font-semibold">{fmtClockShort(driver.locatedAt) || '—'}</span>
                  {driver.locatedAt && <span className="text-slate-500"> ({fmtTimeAgo(new Date(driver.locatedAt))})</span>}
                </div>
                <MapPinned size={12} className="text-slate-400" />
                <div className="truncate" title={driver.address || ''}>
                  Location: <span className="font-semibold">{driver.address || '—'}</span>
                </div>
              </div>
            </SnapshotSection>

            <SnapshotSection title="Performance Today">
              <div className="text-xs space-y-1">
                <div>
                  On-time stops:{' '}
                  {onTimePct
                    ? <span className="font-semibold">{onTimePct.onTime} of {onTimePct.total} ({onTimePct.pct}%)</span>
                    : <span className="text-slate-500">—</span>
                  }
                </div>
                <div>Avg dwell: <span className="text-slate-500">—</span></div>
                <div>
                  Miles driven:{' '}
                  {snapshot?.dailyMiles != null
                    ? <span className="font-semibold">{Number(snapshot.dailyMiles).toFixed(1)}</span>
                    : <span className="text-slate-500">—</span>}
                </div>
              </div>
            </SnapshotSection>
          </>
        )}
    </div>
  );
}

function SnapshotSection({ title, children }) {
  return (
    <section className="px-4 py-3 border-b">
      <div className="text-[10px] uppercase font-semibold text-slate-500 tracking-wide mb-1.5">{title}</div>
      {children}
    </section>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <div className="h-3 bg-slate-200 rounded w-3/4 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-1/2 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-2/3 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-1/3 animate-pulse" />
    </div>
  );
}

function ReadOnlyNoteView({ note }) {
  const items = [];
  if (note.do_not_send) {
    const barred = Array.isArray(note.dns_drivers) ? note.dns_drivers.filter(Boolean) : [];
    items.push({ k: 'DNS', v: <span className="font-semibold" style={{ color: DNS_COLOR }}>Do not send{barred.length ? ` — not: ${barred.join(', ')}` : ''}</span> });
  }
  if (note.priority_flag) items.push({ k: 'Flag', v: <span style={{ color: FLAG_COLORS[note.priority_flag] }} className="font-semibold capitalize">{note.priority_flag}</span> });
  if (note.delivery_window === 'AM' || note.delivery_window === 'PM') items.push({ k: 'Window', v: <span className="font-semibold">{note.delivery_window}</span> });
  if (note.appointment_required) {
    items.push({
      k: 'Appointment',
      v: (
        <span className="inline-flex items-center gap-1.5">
          <RestrictionIcon kind="appointment_required" size={14} />
          Required{note.appointment_notes ? ` — ${note.appointment_notes}` : ''}
        </span>
      ),
    });
  }
  if (note.liftgate_required) {
    items.push({
      k: 'Liftgate',
      v: (
        <span className="inline-flex items-center gap-1.5">
          <RestrictionIcon kind="liftgate_required" size={14} />
          Required
        </span>
      ),
    });
  }
  if (note.dock_type) items.push({ k: 'Dock', v: note.dock_type.replace('_', ' ') });
  if (note.equipment_restrictions?.length) {
    items.push({
      k: 'Restrictions',
      v: (
        <ul className="space-y-1 mt-0.5">
          {note.equipment_restrictions.map((r) => {
            const key = resolveRestrictionKey(r);
            const label = RESTRICTION_ICONS[key]?.label
              || EQUIPMENT_OPTIONS.find((o) => o.value === r)?.label
              || r;
            return (
              <li key={r} className="inline-flex items-center gap-1.5 mr-2">
                <RestrictionIcon kind={r} size={14} />
                <span>{label}</span>
              </li>
            );
          })}
        </ul>
      ),
    });
  }
  // M4.4 — receiving_hours can be legacy strings or {open, close} objects.
  // Display: "8AM-2PM" style for legacy, "08:00-14:00" for structured, or "Closed"
  // if the day is in note.closed_days. "—" means no hours set.
  const closedSet = new Set(Array.isArray(note.closed_days) ? note.closed_days : []);
  const hoursAny = Object.entries(note.receiving_hours || {}).some(([d, v]) => {
    if (closedSet.has(d)) return true;
    if (!v) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return !!(v.open || v.close);
  }) || closedSet.size > 0;
  // Display in 12-hour am/pm (e.g. "8:00a–3:00p"), matching the rest of the app
  // (formatReceivingHours). Stored values are 24h from <input type="time">;
  // fmtTime12 also passes legacy free-text through untouched.
  const renderDayHours = (d) => {
    if (closedSet.has(d)) return 'Closed';
    const v = note.receiving_hours?.[d];
    if (!v) return '—';
    if (typeof v === 'string') return fmtTime12(v) || v;
    if (v.open && v.close) return `${fmtTime12(v.open)}–${fmtTime12(v.close)}`;
    return fmtTime12(v.open || v.close) || '—';
  };
  if (hoursAny) {
    items.push({
      k: 'Hours',
      v: (
        <div className="grid grid-cols-7 gap-1 mt-1">
          {DAYS.map((d) => (
            <div key={d} className="text-center">
              <div className="text-[9px] uppercase text-slate-500">{d}</div>
              <div className={`text-[10px] ${closedSet.has(d) ? 'text-red-600 font-semibold' : ''}`}>{renderDayHours(d)}</div>
            </div>
          ))}
        </div>
      ),
    });
  }
  if (note.dock_notes) items.push({ k: 'Dock notes', v: note.dock_notes });
  if (note.contacts?.length) {
    items.push({
      k: 'Contacts',
      v: (
        <ul className="text-xs space-y-0.5 mt-1">
          {note.contacts.map((c, i) => (
            <li key={i}>{c.name}{c.role ? ` (${c.role})` : ''} — {c.phone}</li>
          ))}
        </ul>
      ),
    });
  }
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map((it, i) => (
        <div key={i}>
          <dt className="text-[10px] uppercase font-semibold text-slate-500">{it.k}</dt>
          <dd>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- map screen ----------

// Lazily create a custom OverlayView class for driver labels. Must be invoked
// after `google` is loaded since OverlayView is provided by the Maps script.
function makeDriverLabelOverlayClass(google) {
  return class DriverLabelOverlay extends google.maps.OverlayView {
    constructor(position, line1, line2, opts = {}) {
      super();
      this.position = position;
      this.line1 = line1;
      this.line2 = line2;
      this.stale = opts.stale || false;
      this.div = null;
    }
    onAdd() {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.transform = 'translate(-50%, 28px)';
      div.style.pointerEvents = 'none';
      div.style.background = 'rgba(255,255,255,0.85)';
      div.style.border = '1px solid rgba(0,0,0,0.1)';
      div.style.borderRadius = '4px';
      div.style.padding = '2px 6px';
      div.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      div.style.fontSize = '11px';
      div.style.lineHeight = '1.25';
      div.style.whiteSpace = 'nowrap';
      div.style.textAlign = 'center';
      div.style.boxShadow = '0 1px 2px rgba(0,0,0,0.08)';
      div.style.opacity = this.stale ? '0.6' : '1';

      const l1 = document.createElement('div');
      l1.style.color = '#1e5b92';
      l1.style.fontWeight = '600';
      l1.textContent = this.line1 || '';

      const l2 = document.createElement('div');
      l2.style.color = '#555';
      l2.style.fontSize = '10px';
      l2.textContent = this.line2 || '';

      div.appendChild(l1);
      if (this.line2) div.appendChild(l2);
      this.div = div;
      const panes = this.getPanes();
      panes.floatPane.appendChild(div);
    }
    draw() {
      if (!this.div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const px = proj.fromLatLngToDivPixel(this.position);
      if (!px) return;
      this.div.style.left = `${px.x}px`;
      this.div.style.top = `${px.y}px`;
    }
    onRemove() {
      if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
      this.div = null;
    }
    setVisible(v) {
      if (this.div) this.div.style.display = v ? '' : 'none';
    }
  };
}

// ---------- M4.5 mobile (<768px) layout primitives ----------
// Compact 48px brand-blue top bar that replaces the desktop header below
// MOBILE_BREAKPOINT. Renders the "D" mark, "Dispatch" label, and a tap-able
// version chip on the right. Tapping the chip toggles a small overflow menu
// the parent owns (Diagnostics access lives here, per brief P5.1).
function MobileAppBar({ version, onChipMenu, chipMenuOpen, onSelectMenu, smsUnread = 0 }) {
  return (
    <header
      className="flex-shrink-0 flex items-center justify-between gap-2 px-3 text-white relative"
      style={{
        background: BRAND,
        // minHeight (not a fixed height) + the notch inset as padding so the bar
        // GROWS by the safe-area inset — content sits below the notch with a full
        // 48px row, instead of the inset eating into a fixed 48px (which squeezed
        // the logo/version under the status bar on notched phones).
        minHeight: 'calc(48px + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
        <div className="bg-white rounded px-1.5 py-1 flex items-center flex-shrink-0">
          <img src="/davis-logo.jpg" alt="Davis Delivery Service" className="h-5 w-auto" />
        </div>
        <span className="font-semibold text-[14px] leading-none truncate">Dispatch</span>
      </div>
      <div className="relative">
        <button
          onClick={onChipMenu}
          className="text-[10px] px-1.5 py-1 rounded bg-white/15 text-white/80 active:bg-white/25"
          aria-haspopup="menu"
          aria-expanded={chipMenuOpen}
          title="Version menu"
        >
          v{version}
        </button>
        {chipMenuOpen && (
          <div
            className="absolute top-full right-0 mt-1 bg-white text-slate-800 rounded shadow-lg border border-slate-200 text-xs min-w-[140px] z-50"
            role="menu"
          >
            {ROUTING_FLAG && (
              <button
                className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2"
                onClick={() => onSelectMenu('routing')}
                role="menuitem"
              >
                <MapPinned size={12} /> Routing (beta)
              </button>
            )}
            <button
              className={`w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2${ROUTING_FLAG ? ' border-t border-slate-100' : ''}`}
              onClick={() => onSelectMenu('messages')}
              role="menuitem"
            >
              <MessageSquare size={12} /> Messages
              {smsUnread > 0 && <span className="ml-auto min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold inline-flex items-center justify-center">{smsUnread > 99 ? '99+' : smsUnread}</span>}
            </button>
            <button
              className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2 border-t border-slate-100"
              onClick={() => onSelectMenu('diagnostics')}
              role="menuitem"
            >
              <Activity size={12} /> Diagnostics
            </button>
            <button
              className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2 border-t border-slate-100"
              onClick={() => onSelectMenu('map')}
              role="menuitem"
            >
              <MapPin size={12} /> Map
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

// Floating action button. 56px circle, bottom-right above safe area. Rotates 45°
// to act as an × close button when the drawer is open. Caller owns the open
// state.
function MobileFAB({ open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? 'Close drawer' : 'Open drawer'}
      className="absolute rounded-full text-white flex items-center justify-center transition-transform"
      style={{
        background: BRAND,
        width: 56,
        height: 56,
        right: 16,
        bottom: `calc(16px + env(safe-area-inset-bottom))`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
        zIndex: 30,
      }}
    >
      {open ? <X size={24} /> : <LayoutList size={22} />}
    </button>
  );
}

// Persistent bottom navigation for the mobile app. Lives OUTSIDE the map/drawer
// area so it stays visible over every full-screen view — tap Map to return to
// the board, Stops/Filters/Loads to open that full-screen view.
function MobileTabBar({ active, onMap, onStops, onFilters, onLoads }) {
  const Tab = ({ id, label, icon, onClick }) => {
    const on = active === id;
    return (
      <button
        onClick={onClick}
        aria-current={on ? 'page' : undefined}
        className="flex-1 flex flex-col items-center justify-center gap-0.5 active:bg-slate-100"
        style={{ color: on ? BRAND : '#64748b', minHeight: 50 }}
      >
        {icon}
        <span className="text-[10px] font-semibold leading-none">{label}</span>
      </button>
    );
  };
  return (
    <nav
      className="flex-shrink-0 flex items-stretch border-t border-slate-200 bg-white"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <Tab id="map" label="Map" icon={<MapPin size={20} />} onClick={onMap} />
      <Tab id="stops" label="Stops" icon={<LayoutList size={20} />} onClick={onStops} />
      <Tab id="filters" label="Filters" icon={<Filter size={20} />} onClick={onFilters} />
      <Tab id="loads" label="Loads" icon={<Package size={20} />} onClick={onLoads} />
    </nav>
  );
}

// Shared bottom-sheet primitive. Owns the slide-up animation, the drag handle,
// the snap behavior (3 height stops), the backdrop dim, and the close-on-fling.
// Consumers compose their own header + body inside. Each drawer can specify
// its preferred default height + an optional onDragHandle on top of children
// (e.g. the StopDetail drawer puts a customer-name header above its tabs).
//
// Touch handling uses native events (no library) — vertical pointer drags on
// the handle adjust height; release snaps to nearest of the snap stops, with
// a downward fling past the smallest stop closing the sheet.
const SHEET_HEIGHTS = { mini: 0.30, default: 0.60, expanded: 0.95 };
const STOP_DETAIL_HEIGHTS = { mini: 0.30, default: 0.66, expanded: 0.95 };

function BottomSheet({ open, onClose, children, ariaLabel }) {
  // FULL-SCREEN mobile view. It slides up to fill the whole content area (under
  // the persistent app header), rather than a partial bottom sheet. Full screen
  // means: the search/editor/lists get the entire area, the on-screen keyboard
  // never fights a half-height sheet (no blanking, you can see what you type),
  // nothing overlaps the map, and there's no wasted empty band. Inner scrolling
  // is owned by a child marked [data-sheet-scroll] (flex-1 min-h-0 overflow-y-auto).
  return (
    <div
      className="absolute inset-0 z-[25] bg-white flex flex-col"
      style={{
        transform: open ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 240ms ease-out',
        pointerEvents: open ? 'auto' : 'none',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

function MobileDrawer({ open, onClose, activeTab, setActiveTab, children }) {
  return (
    <BottomSheet open={open} onClose={onClose} heights={SHEET_HEIGHTS} ariaLabel="Stops, Filters, Loads">
      <div className="flex-shrink-0 flex border-b border-slate-200">
        {[
          { id: 'stops', label: 'Stops' },
          { id: 'filters', label: 'Filters' },
          { id: 'loads', label: 'Loads' },
        ].map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex-1 py-3 text-sm font-semibold transition-colors ${active ? '' : 'text-slate-500'}`}
              style={{
                color: active ? BRAND : undefined,
                borderBottom: active ? `2px solid ${BRAND}` : '2px solid transparent',
                minHeight: 44,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-sheet-scroll>
        {children}
      </div>
    </BottomSheet>
  );
}

// Stops tab content. Search input + count + list of cards (one tap = pick stop).
// Historical PRO / customer lookup. Opened by an explicit button (not the live
// search). Searches our SAVED 20-stop-per-customer history (customer_notes) with
// zero API calls — by customer name (shows that customer's last 20 PROs) or by
// PRO. ONLY when a typed PRO isn't in saved history does it offer a deliberate
// NuVizz lookup (one call). Business-name searches never call the API.
function PastProSearch({ notes, initialQuery, onPickCustomer, onClose }) {
  const [q, setQ] = useState(initialQuery || '');
  const [api, setApi] = useState(null); // NuVizz single-PRO lookup: null | {loading} | {stop} | {error}
  const [detail, setDetail] = useState(null); // stop shown in the full-detail modal
  const [remote, setRemote] = useState({ loading: false, customers: [], error: null }); // our delivery-history warehouse
  const query = q.trim();
  const lc = query.toLowerCase();
  // PRO-like = contains digits and is a single token (no spaces) — names have spaces.
  const isProLike = !!query && /\d/.test(query) && !/\s/.test(query);

  // Instant local pass over the already-loaded customer_notes (partial match).
  const all = [...notes.values()];
  const localCustomers = !query ? [] : all
    .filter((n) => (n.raw_name || '').toLowerCase().includes(lc) && Array.isArray(n.pro_history) && n.pro_history.length)
    .map((n) => ({
      key: (n.raw_name || n.id || '').toLowerCase(),
      matchKey: n.match_key || n.id || null,
      name: n.raw_name || n.id,
      addr1: n.address_override?.addr1 || null,
      city: n.address_override?.city || null,
      state: n.address_override?.state || null,
      zip: n.address_override?.zip || null,
      history: [...n.pro_history].reverse().slice(0, 20),
    }));
  const proMatches = !query ? [] : all.flatMap((n) =>
    (Array.isArray(n.pro_history) ? n.pro_history : [])
      .filter((h) => String(h.pro).toLowerCase().includes(lc))
      .map((h) => ({ customer: n.raw_name || n.id, pro: h.pro, date: h.date })),
  ).slice(0, 60);

  // Search our own delivery-history warehouse (history_customers rollup). This
  // reads Firestore only — it NEVER calls NuVizz — so business-name search is
  // free at NuVizz. Debounced; name → prefix search, PRO → exact.
  useEffect(() => {
    if (!query) { setRemote({ loading: false, customers: [], error: null }); return; }
    let cancelled = false;
    setRemote((r) => ({ ...r, loading: true, error: null }));
    const param = isProLike ? ('pro=' + encodeURIComponent(query)) : ('name=' + encodeURIComponent(query));
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/.netlify/functions/nuvizz-customer-history?' + param);
        const d = await res.json();
        if (cancelled) return;
        setRemote({ loading: false, customers: Array.isArray(d.customers) ? d.customers : [], error: d.ok ? null : (d.reason || null) });
      } catch (e) {
        if (!cancelled) setRemote({ loading: false, customers: [], error: e.message });
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, isProLike]);

  // Merge local + warehouse customers; the warehouse holds the authoritative
  // last-20, so it wins on duplicates.
  const customers = (() => {
    const map = new Map();
    for (const c of localCustomers) map.set(c.key, { ...c, addr: [c.addr1, c.city, c.state].filter(Boolean).join(', ') });
    for (const c of remote.customers) {
      const key = (c.name || c.matchKey || '').toLowerCase();
      if (!key) continue;
      map.set(key, {
        key, matchKey: c.matchKey || null, name: c.name,
        addr1: c.addr1 || null, city: c.city || null, state: c.state || null, zip: c.zip || null,
        history: Array.isArray(c.pros) ? c.pros : [],
        addr: [c.addr1, c.city, c.state].filter(Boolean).join(', '),
      });
    }
    return [...map.values()].slice(0, 40);
  })();

  // Open a historical customer in the full stop detail (synthetic stop — no live
  // route/items, but the customer notes editor incl. DNS works and reads/writes
  // customer_notes by matchKey).
  const openCustomer = (m) => {
    if (!onPickCustomer) return;
    const matchKey = m.matchKey || normalizeMatchKey(m.name || '', m.addr1 || '', m.city || '', m.zip || '');
    onPickCustomer({
      stopNbr: 'hist:' + matchKey,
      matchKey,
      pro: null, pros: [], proCount: 0,
      businessName: m.name || '',
      addr1: m.addr1 || null, addr2: null,
      city: m.city || null, state: m.state || null, zip: m.zip || null,
      lat: null, lng: null,
      loadNbr: null, routeName: null, driverName: null,
      scheduledFrom: null, scheduledTo: null,
      status: null, isPlanned: false, isUnplanned: true,
      signalSources: {}, stopDetails: [], raw: {},
      __historical: true,
    });
  };

  const noResults = query && !remote.loading && customers.length === 0 && proMatches.length === 0;

  const runApi = async () => {
    setApi({ loading: true });
    try {
      const r = await fetch('/.netlify/functions/nuvizz-pro-lookup?pro=' + encodeURIComponent(query));
      const d = await r.json();
      setApi(d.ok && d.stop ? { stop: d.stop } : { error: d.reason || 'not found' });
    } catch (e) { setApi({ error: e.message }); }
  };

  return (
    <>
      <div className="flex-shrink-0 px-3 py-2 border-b border-slate-200 flex items-center gap-2">
        <button onClick={onClose} className="flex-shrink-0 p-2 -ml-1 rounded-full hover:bg-slate-100 active:bg-slate-200" style={{ minWidth: 40, minHeight: 40 }} aria-label="Back to stops"><ChevronDown size={18} className="rotate-90" /></button>
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="search" inputMode="search" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            value={q} onChange={(e) => { setQ(e.target.value); setApi(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            placeholder="Customer name or PRO #…" autoFocus
            className="w-full pl-8 pr-3 border border-slate-300 rounded-lg text-sm" style={{ minHeight: 44 }}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-sheet-scroll>
        <div className="px-3 py-2 text-[11px] text-slate-500">Searches our saved delivery history (last 20 PROs per customer). Business-name search never calls NuVizz — only an unknown PRO lookup does.</div>
        {!query && <div className="px-4 py-6 text-center text-xs text-slate-400 italic">Type a customer name or a PRO number.</div>}
        {query && remote.loading && customers.length === 0 && proMatches.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-slate-400 inline-flex items-center gap-1.5 w-full justify-center"><RefreshCw size={13} className="animate-spin" /> Searching history…</div>
        )}

        {customers.length > 0 && (
          <div className="px-3 pb-2">
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Customers ({customers.length})</div>
            {customers.map((m, i) => {
              const cNote = m.matchKey ? notes.get(m.matchKey) : null;
              return (
                <button
                  key={m.key || i}
                  onClick={() => openCustomer(m)}
                  className="w-full text-left mb-2 border border-slate-200 rounded-lg p-2 active:bg-slate-50"
                >
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-slate-900 break-words flex-1 min-w-0">{m.name}</div>
                    <DnsBadge note={cNote} />
                    <ChevronDown size={16} className="-rotate-90 text-slate-400 flex-shrink-0" />
                  </div>
                  {m.addr && <div className="text-[11px] text-slate-500 break-words">{m.addr}</div>}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.history.map((h, j) => (
                      <span key={j} className="text-[10px] font-mono bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">{h.pro} · {h.date}</span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {proMatches.length > 0 && (
          <div className="px-3 pb-2">
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">PRO matches ({proMatches.length})</div>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {proMatches.map((m, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                  <span className="font-mono text-[12px] flex-shrink-0">{m.pro}</span>
                  <span className="text-slate-500 text-[11px] flex-shrink-0">{m.date}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-slate-700">{m.customer}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {noResults && (
          <div className="px-4 py-4 text-center">
            <div className="text-xs text-slate-500 mb-2">Nothing in saved history for “{query}”.</div>
            {isProLike ? (
              !api ? (
                <button onClick={runApi} className="px-3 py-2 text-sm text-white font-semibold rounded-lg" style={{ background: BRAND, minHeight: 44 }}>Look up PRO in NuVizz (1 API call)</button>
              ) : api.loading ? (
                <div className="text-xs text-slate-500 inline-flex items-center gap-1"><RefreshCw size={14} className="animate-spin" /> Looking up…</div>
              ) : api.error ? (
                <div className="text-xs text-red-600">PRO not found in NuVizz ({api.error}).</div>
              ) : null
            ) : (
              <div className="text-[11px] text-slate-400 italic">Tip: business-name search reads only our saved delivery history — try a different spelling, or search by PRO number.</div>
            )}
          </div>
        )}

        {api?.stop && (
          <div className="px-3 pb-3">
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">From NuVizz</div>
            <button
              onClick={() => setDetail(api.stop)}
              className="w-full text-left border border-blue-200 bg-blue-50/40 rounded-lg p-3 text-sm hover:bg-blue-50 active:bg-blue-100"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">PRO {api.stop.pro || '—'}</div>
                  <div className="font-bold text-slate-900 break-words">{api.stop.businessName || '(no name)'}</div>
                  <div className="text-slate-600 break-words">{api.stop.addr1}</div>
                  <div className="text-slate-600 break-words">{[api.stop.city, api.stop.state, api.stop.zip].filter(Boolean).join(', ')}</div>
                  {api.stop.loadNbr && <div className="text-[12px] text-slate-500">Route: {api.stop.routeName || api.stop.loadNbr}{api.stop.driverName ? ` · ${api.stop.driverName}` : ''}</div>}
                  {api.stop.itemsSummary && <div className="text-[12px] text-slate-500">{api.stop.itemsSummary}</div>}
                </div>
                <ChevronDown size={18} className="-rotate-90 text-blue-400 flex-shrink-0 mt-0.5" />
              </div>
              <div className="mt-1.5 text-[11px] font-semibold" style={{ color: BRAND }}>Tap for full details →</div>
            </button>
          </div>
        )}
        <div className="h-3" />
      </div>
      {detail && (
        <LookupStopModal stop={detail} note={(detail.matchKey && notes.get(detail.matchKey)) || null} onClose={() => setDetail(null)} />
      )}
    </>
  );
}

// Full stop-detail modal for a historical PRO lookup — a centered window over the
// map showing ALL of the already-fetched detail (address + map links, live status
// /timeline, order line items, POD photos, route). Reuses StopDataSections read-only
// (no action callbacks → edit/pin/route buttons hidden). No extra NuVizz call — it
// renders the stop the lookup already returned; the inner "Refresh" button is opt-in.
function LookupStopModal({ stop, note, onClose }) {
  const [live, onRefreshed] = useLiveStop(stop);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!stop) return null;
  const pro = stop.pro || stop.primaryPro || stop.stopNbr || '';
  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ background: BRAND, color: 'white', paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="min-w-0">
            <div className="font-bold truncate">{stop.businessName || `Stop ${pro}`}</div>
            <div className="text-[11px] text-white/80 truncate">
              {pro ? `PRO #${pro}` : ''}{stop.routeName || stop.loadNbr ? ` · ${stop.routeName || stop.loadNbr}` : ''}{stop.driverName ? ` · ${stop.driverName}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="opacity-80 hover:opacity-100 p-1 -mr-1 flex-shrink-0"><X size={20} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <StopDataSections stop={live} note={note} onRefreshed={onRefreshed} />
        </div>
      </div>
    </div>
  );
}

function MobileStopsTab({
  stops, notes, drivers, searchInput, setSearchInput,
  resultCount, totalCount, onPickStop,
  aiAvailable, onAskAi, aiBusy, aiSummary, aiError, onClearAi,
}) {
  const [histOpen, setHistOpen] = useState(false);
  if (histOpen) return <PastProSearch notes={notes} initialQuery={searchInput} onPickCustomer={onPickStop} onClose={() => setHistOpen(false)} />;
  return (
    <div className="flex flex-col">
      <div className="p-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
              placeholder="Customer, PRO, city, address…"
              className="w-full pl-8 pr-3 border border-slate-300 rounded-lg text-sm"
              style={{ minHeight: 44 }}
            />
          </div>
          {aiAvailable && (
            <button
              onClick={() => searchInput.trim() && onAskAi(searchInput)}
              disabled={aiBusy || !searchInput.trim()}
              className="flex-shrink-0 whitespace-nowrap rounded-lg text-white inline-flex items-center gap-1 px-3 text-xs font-semibold disabled:opacity-40"
              style={{ background: '#1e5b92', minHeight: 44, minWidth: 44 }}
              aria-label="Ask AI to filter"
            >
              <Sparkles size={14} /> AI
            </button>
          )}
        </div>
        {aiSummary ? (
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800">
              <Sparkles size={11} className="flex-shrink-0" /> <span className="truncate">{aiSummary}</span>
            </span>
            <button onClick={onClearAi} className="flex-shrink-0 text-slate-500 underline px-1 py-1 -my-1">Clear</button>
          </div>
        ) : aiBusy ? (
          <div className="mt-2 text-[11px] text-slate-500">Asking AI…</div>
        ) : (
          <div className="text-[11px] text-slate-500 mt-1.5 px-0.5">
            Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops
          </div>
        )}
        {aiError && <div className="mt-1 text-[11px] text-amber-700">{aiError}</div>}
        <button
          onClick={() => setHistOpen(true)}
          className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg py-2 active:bg-slate-100"
        >
          <Clock size={13} /> Search past PROs / customer history
        </button>
      </div>
      <div className="divide-y divide-slate-100">
        {stops.length === 0 && (
          <div className="text-xs text-slate-400 italic px-4 py-6 text-center">
            No stops match the current filters.
          </div>
        )}
        {stops.map((s) => (
          <MobileStopCard
            key={s.stopNbr}
            stop={s}
            note={notes.get(s.matchKey)}
            onPick={() => onPickStop(s)}
          />
        ))}
      </div>
    </div>
  );
}

function MobileStopCard({ stop, note, onPick }) {
  const flag = note?.priority_flag;
  const restricted = !!(note && note.equipment_restrictions?.length);
  const swatch = flag ? FLAG_COLORS[flag] : (restricted ? RESTRICTION_TINT : '#cbd5e1');
  const statusKind = classifyStopStatus(stop);
  // NuVizz mislabels its freight fields: cartons = real skids, volume = loose pieces.
  const freight = [];
  if (stop.cartons) freight.push(`${stop.cartons} skid${stop.cartons === 1 ? '' : 's'}`);
  if (stop.volume) freight.push(`${stop.volume} loose`);
  return (
    <button
      onClick={onPick}
      className="w-full flex items-start gap-3 px-4 py-2 text-left active:bg-slate-100"
      style={{ minHeight: 64 }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5"
        style={{ background: swatch }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900 truncate flex items-center gap-1.5 min-w-0">
            <span className="truncate">{stop.businessName || '(no name)'}</span>
            <DnsBadge note={note} />
          </div>
          {stop.pro && (
            <span className="font-mono text-[10px] text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 flex-shrink-0">
              {stop.pro}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {stop.addr1 ? `${stop.addr1} · ` : ''}{stop.city || '—'}{stop.state ? `, ${stop.state}` : ''}
        </div>
        <div className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap">
          <StatusBadge kind={statusKind} />
          {stop.driverName && <span className="text-[11px] text-slate-600 truncate max-w-[45%]">{stop.driverName}</span>}
          {freight.length > 0 && <span className="text-[11px] text-slate-500">{freight.join(' · ')}</span>}
        </div>
      </div>
    </button>
  );
}

// Filters tab. Re-uses the desktop FilterPanel's behavior (everything is just
// props on the same filters object) and adds the M4.4 map-toolbar toggles
// stacked underneath. Clustering toggle is forced ON + warning shown.
function MobileFiltersTab({
  filters, setFilters, counts,
  mapFilters, setMapFilters,
  showRoutes, setShowRoutes, vehicleDisabled,
}) {
  const setMF = (key) => (v) => setMapFilters((prev) => ({ ...prev, [key]: v }));
  return (
    <div className="flex flex-col">
      <FilterPanel filters={filters} setFilters={setFilters} counts={counts} />
      <div className="border-t px-3 py-3">
        <div className="text-xs font-semibold text-slate-600 mb-2">Map display</div>
        <div className="space-y-1.5">
          <MapFilterToggle
            label="Hide terminal markers"
            checked={mapFilters.hideTerminal}
            onChange={setMF('hideTerminal')}
          />
          <MapFilterToggle
            label="Hide stem out"
            checked={mapFilters.hideStemOut}
            onChange={setMF('hideStemOut')}
          />
          <MapFilterToggle
            label="Unplanned only"
            checked={mapFilters.unplannedOnly}
            onChange={setMF('unplannedOnly')}
          />
          <MapFilterToggle
            label="Carry-over unplanned"
            checked={mapFilters.carryover}
            onChange={setMF('carryover')}
          />
          <MapFilterToggle
            label="Show drivers (live)"
            checked={mapFilters.showVehicleLocation}
            onChange={setMF('showVehicleLocation')}
            disabled={vehicleDisabled}
            disabledHint="Live drivers only available for today's date."
          />
          {vehicleDisabled && (
            <div className="text-[10px] text-slate-500 italic -mt-1 leading-tight">Live drivers only available for today.</div>
          )}
          {/* M5 — Show Routes lives in the mobile filters drawer (P3.7). */}
          <MapFilterToggle
            label="Show routes"
            checked={showRoutes}
            onChange={setShowRoutes}
          />
          {/* Clustering required on mobile — see brief P3.4. */}
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-xs text-slate-700 min-w-0 flex-1 truncate">Show clustered markers</span>
            <span className="text-[10px] uppercase text-amber-700 italic flex-shrink-0 whitespace-nowrap">required on mobile</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Drivers tab. Tap a driver row → caller centers the map and opens the
// driver-snapshot UI (in PR 1 that's still the existing right-side sidebar;
// PR 2 will replace it with a drawer).
function MobileDriversTab({ drivers, error, onPickDriver }) {
  if (error) {
    return (
      <div className="px-4 py-6 text-xs text-red-600">⚠ {error}</div>
    );
  }
  if (!drivers || drivers.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-slate-400 italic text-center">
        No active drivers.
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100">
      {drivers.map((d) => (
        <button
          key={d.id || d.truckNumber}
          onClick={() => onPickDriver(d)}
          className="w-full flex items-center gap-3 px-4 text-left active:bg-slate-100"
          style={{ minHeight: 56 }}
        >
          <Truck size={18} className="text-slate-500 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-900 truncate">
              <span className="font-semibold">{d.truckNumber || '—'}</span>
              {d.driverName ? <span className="text-slate-600"> · {d.driverName}</span> : null}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {d.status || (d.lastSeenAgo ? `last seen ${d.lastSeenAgo}` : 'unknown')}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// Loads tab content — the day's loads grouped from the board (one tap opens that
// load's route detail). Shows route/load id, driver, delivered-of-total progress,
// and pallet/weight totals.
function MobileLoadsTab({ loads, onPickLoad }) {
  if (!loads || loads.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-slate-400 italic text-center">
        No loads on the board for this date.
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100">
      {loads.map((l) => {
        const pct = l.stops ? Math.round((100 * l.delivered) / l.stops) : 0;
        return (
        <button
          key={l.loadNbr}
          onClick={() => onPickLoad(l.loadNbr)}
          className="w-full flex items-center gap-3 px-4 text-left active:bg-slate-100"
          style={{ minHeight: 56 }}
        >
          <Package size={18} className="text-slate-500 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-900 truncate">
              <span className="font-semibold">{l.routeName || l.loadNbr}</span>
              {l.driverName ? <span className="text-slate-600"> · {l.driverName}</span> : null}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {l.delivered}/{l.stops} delivered
              {l.pallets ? ` · ${l.pallets} plt` : ''}
              {l.weight ? ` · ${l.weight.toLocaleString()} lb` : ''}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-bold" style={{ color: pct === 100 ? '#16a34a' : BRAND }}>{pct}%</div>
            <div className="text-[10px] text-slate-400">{l.stops} stop{l.stops === 1 ? '' : 's'}</div>
          </div>
        </button>
      ); })}
    </div>
  );
}

// ---------- M4.5 PR 2: stop-detail + driver-snapshot drawers ----------

// Mobile stop-detail drawer. A bottom-sheet that renders the SAME shared
// stop components as the desktop sidebar (StopDataSections + ProsSection +
// StopNotesSection) in a single scroll, so mobile has full desktop parity —
// every edit option, one inline Edit, one Save.
function MobileStopDetailDrawer({ stop, note, onClose, onSave, saving, saveError, onOpenRoute, onMoveLocation, onEditAddress, onAutoFixAddress, onText, drivers = [] }) {
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // See StopSidebar: guards an open edit from being wiped by a background note
  // write (the root cause of an empty saved note / lost receiving hours).
  const dirtyRef = useRef(false);

  // Reset draft when a different stop opens.
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(false);
    setConfirmDiscard(false);
    dirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop?.stopNbr]);
  // Adopt a note that loads/updates after open — unless mid-edit.
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(note || emptyNote(stop));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);

  // Live overlay so the status badge below updates on Refresh / timeline open (a board
  // stop tagged Scheduled flips to Delivered once its real status 90 comes back).
  const [live, onRefreshed] = useLiveStop(stop);
  if (!stop) return null;
  const D = draft;
  const setD = (patch) => { dirtyRef.current = true; setDraft({ ...D, ...patch }); };

  const hasUnsaved = editing && JSON.stringify(draft) !== JSON.stringify(note || emptyNote(stop));

  const tryClose = () => {
    if (hasUnsaved) { setConfirmDiscard(true); return; }
    onClose();
  };

  return (
    <BottomSheet open onClose={tryClose} heights={STOP_DETAIL_HEIGHTS} ariaLabel={`Stop details: ${stop.businessName || stop.pro || ''}`}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-1 pb-2 border-b border-slate-200">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-wide text-slate-600">PRO {stop.pro || '—'}</div>
            <div className="font-bold text-base text-slate-900 truncate">{stop.businessName || '(no name)'}</div>
            <div className="text-[12px] text-slate-500 truncate">{stop.addr1 || '—'}</div>
          </div>
          <button
            onClick={tryClose}
            className="flex-shrink-0 p-2 -mr-1 rounded-full hover:bg-slate-100 active:bg-slate-200"
            style={{ minWidth: 44, minHeight: 44 }}
            aria-label="Close stop details"
          >
            <X size={20} />
          </button>
        </div>
      </div>
      {/* Single scroll — the SAME shared detail + full editor as desktop, so
          every option is present and the two can never drift. onFocus scrolls
          the focused field into view above the on-screen keyboard (the keyboard
          shrinks the sheet, so a lower field would otherwise be hidden). */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-sheet-scroll
        onFocus={(e) => {
          const t = e.target;
          if (t && typeof t.matches === 'function' && t.matches('input,textarea,select')) {
            setTimeout(() => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ } }, 280);
          }
        }}
      >
        <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <StatusBadge kind={classifyStopStatus(live)} />
          <DnsBadge note={note} showDrivers />
        </div>
        <StopDataSections stop={live} note={note} onRefreshed={onRefreshed} onOpenRoute={onOpenRoute} onMoveLocation={onMoveLocation} onEditAddress={onEditAddress} onAutoFixAddress={onAutoFixAddress} onText={onText} />
        <ProsSection stop={live} />
        <StopNotesSection note={note} editing={editing} setEditing={setEditing} draft={D} setDraft={setD} drivers={drivers} />
      </div>
      {/* Sticky save bar — visible while editing */}
      {editing && (
        <div className="flex-shrink-0 border-t bg-white px-4 py-2 flex items-center justify-between gap-2"
             style={{ paddingBottom: `calc(0.5rem + env(safe-area-inset-bottom))` }}>
          {saveError && <span className="text-[11px] text-red-600 truncate">{saveError}</span>}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => { dirtyRef.current = false; setDraft(note || emptyNote(stop)); setEditing(false); }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded"
              style={{ minHeight: 44 }}
            >
              Cancel
            </button>
            <button
              onClick={() => { dirtyRef.current = false; onSave(D); }}
              disabled={saving}
              className="px-4 py-2 text-sm text-white font-semibold rounded inline-flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: BRAND, minHeight: 44 }}
            >
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>
      )}
      {/* Discard confirm dialog */}
      {confirmDiscard && (
        <div
          className="absolute inset-0 flex items-center justify-center px-6"
          style={{ background: 'rgba(0,0,0,0.45)', zIndex: 50 }}
        >
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-4">
            <div className="font-semibold text-slate-900 mb-1">Discard changes?</div>
            <div className="text-xs text-slate-600 mb-4">You have unsaved edits to this stop. Closing will lose them.</div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded"
                style={{ minHeight: 44 }}
              >
                Keep editing
              </button>
              <button
                onClick={() => { setConfirmDiscard(false); onClose(); }}
                className="px-3 py-2 text-sm text-white font-semibold rounded"
                style={{ background: '#dc2626', minHeight: 44 }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// M5.1 — status pill for the stop-detail sidebar. Color matches the marker
// hue; UNPLANNED renders as an outlined chip to echo its hollow pin.
function StatusBadge({ kind }) {
  const meta = STATUS_META[kind] || STATUS_META.SCHEDULED;
  const c = meta.badge;
  const outlined = kind === 'UNPLANNED';
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={
        outlined
          ? { color: c, border: `1px solid ${c}`, background: '#fff' }
          : { color: '#fff', background: c }
      }
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: outlined ? c : '#fff' }} />
      {meta.label}
    </span>
  );
}

// M5.2 — Route detail body, shared between the desktop sidebar and mobile drawer.
// Shows the load's stops in compareByPlannedEta order (== polyline order) with status
// badge + delivery/arrival/ETA time. Tap a row → onPickStop closes route + opens stop.
function RouteDetailBody({ stops, onPickStop }) {
  const sorted = orderRouteStops(stops);
  const driverName = sorted[0]?.driverName || sorted[0]?.driverUserName || '—';
  const delivered = sorted.filter((s) => classifyStopStatus(s) === 'DELIVERED').length;
  const pct = sorted.length ? Math.round((100 * delivered) / sorted.length) : 0;
  const [showManifest, setShowManifest] = useState(false);
  const routeName = sorted.find((s) => s.routeName)?.routeName || sorted.find((s) => s.loadNbr)?.loadNbr || 'Route';
  const manifestHtml = useMemo(
    () => (showManifest ? buildManifestHtml(sorted, (typeof window !== 'undefined' ? window.location.origin : '') + '/davis-logo.jpg') : ''),
    [showManifest, sorted],
  );
  return (
    <>
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase font-semibold text-slate-500">Driver</div>
          <div className="text-sm font-semibold text-slate-900 truncate">{driverName}</div>
        </div>
        <div className="text-right flex-shrink-0 pl-2">
          <div className="text-base font-bold leading-none" style={{ color: pct === 100 ? '#16a34a' : BRAND }}>{pct}%</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{delivered}/{sorted.length} delivered</div>
        </div>
      </div>
      <div className="px-4 py-2 border-b">
        <button
          onClick={() => setShowManifest(true)}
          disabled={!sorted.length}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Printer size={15} /> Print Manifest
        </button>
      </div>
      {showManifest && (
        <PrintDocModal
          title={`Driver Manifest · ${routeName}`}
          html={manifestHtml}
          pageW={816}
          onClose={() => setShowManifest(false)}
        />
      )}
      <ol className="divide-y divide-slate-100">
        {sorted.map((s, i) => {
          const kind = classifyStopStatus(s);
          const exec = s.raw?.stopExecutionInfo || {};
          const time = kind === 'DELIVERED' ? fmtClockShort(s.deliveredDTTM || execDeliveredTs(exec))
                     : kind === 'ARRIVED' ? fmtClockShort(s.arrivalDTTM || execArrivalTs(exec))
                     : fmtClockShort(s.plannedEtaDTTM || exec.to?.plannedEtaDTTM);
          // Number by NuVizz's own sequence (routeSeq) so the list matches the Route
          // Workbench and the numbered map pins 1:1; fall back to position if absent.
          const rs = routeSeqOf(s);
          const seqLabel = rs != null ? rs : i + 1;
          const addr = [s.addr1, s.city, s.state].filter(Boolean).join(', ');
          return (
            <li key={(s.stopNbr || '') + ':' + i}>
              <button
                onClick={() => onPickStop && onPickStop(s)}
                className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-slate-50 active:bg-slate-100"
                style={{ minHeight: 56 }}
              >
                <span className="text-[10px] font-mono text-slate-400 w-5 flex-shrink-0 text-right">{seqLabel}</span>
                <StatusBadge kind={kind} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 truncate">{s.businessName || '(no name)'}</div>
                  {addr && <div className="text-[11px] text-slate-500 truncate">{addr}</div>}
                  <div className="text-[11px] text-slate-400 truncate">
                    {s.pro && <span className="font-mono mr-1">{s.pro}</span>}
                    {time && <span>{time}</span>}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function RouteDetailSidebar({ loadNbr, stops, onClose, onPickStop, mobile = false }) {
  // M5.2.1 — lead with the human route name (e.g. "DULUTH"); load # stays as fine
  // print so the dispatcher can still grep for the internal identifier.
  const routeName = stops.find((s) => s.routeName)?.routeName || null;
  return (
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ background: BRAND, color: 'white' }}>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider opacity-75">Route</div>
          <div className="font-bold truncate">{routeName || loadNbr}</div>
          {routeName && <div className="text-[10px] font-mono opacity-75">{loadNbr}</div>}
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded" aria-label="Close route"><X size={20} /></button>
      </div>
      <div className="overflow-y-auto flex-1">
        <RouteDetailBody stops={stops} onPickStop={onPickStop} />
      </div>
    </aside>
  );
}

function MobileRouteDetailDrawer({ loadNbr, stops, onClose, onPickStop }) {
  const routeName = stops.find((s) => s.routeName)?.routeName || null;
  return (
    <BottomSheet open onClose={onClose} heights={SHEET_HEIGHTS} ariaLabel={`Route ${routeName || loadNbr}`}>
      <div className="flex-shrink-0 px-4 py-2 flex items-center justify-between border-b">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Route</div>
          <div className="font-bold truncate">{routeName || loadNbr}</div>
          {routeName && <div className="text-[10px] font-mono text-slate-400">{loadNbr}</div>}
        </div>
        <button onClick={onClose} className="p-2 -mr-2" aria-label="Close route"><X size={20} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-sheet-scroll>
        <RouteDetailBody stops={stops} onPickStop={onPickStop} />
      </div>
    </BottomSheet>
  );
}


// Mobile driver-snapshot drawer. Replaces the full-screen DriverSnapshotSidebar
// overlay on mobile with a slide-up bottom sheet that re-uses the desktop
// snapshot header + body subcomponents. Tap a stop row → drawer closes, map
// pans, and the caller can open the stop detail drawer.
function MobileDriverSnapshotDrawer({ driver, snapshot, loading, error, onClose, onPickStopFromSnapshot, onText }) {
  if (!driver) return null;
  return (
    <BottomSheet open onClose={onClose} heights={STOP_DETAIL_HEIGHTS} ariaLabel={`Driver snapshot: ${driver.driverName || ''}`}>
      <DriverSnapshotHeader driver={driver} snapshot={snapshot} onClose={onClose} onText={onText} />
      <DriverSnapshotBody
        driver={driver}
        snapshot={snapshot}
        loading={loading}
        error={error}
        onPanToStop={onPickStopFromSnapshot}
      />
    </BottomSheet>
  );
}

function MapScreen({ onOpenMessages, smsUnread = 0 }) {
  // M5 — selectedDate drives every fetch. Defaults to today (ET) and is NOT
  // persisted: every page load resets to today (brief P2.2).
  const [selectedDate, setSelectedDate] = useState(() => todayInET());
  const dateIsToday = isTodayET(selectedDate);

  // Declared before useStops because the carry-over fetch reads mapFilters.carryover
  // (referencing it after the useStops call hit a temporal-dead-zone crash).
  const [mapFilters, setMapFilters] = useState(() => ({
    ...DEFAULT_MAP_FILTERS,
    ...safeReadJSON(LS_MAP_FILTERS, {}),
  }));

  const { stops, loading, error, lastRefreshed, lastScannedAt, lastLoadScanAt, lastUnplannedScanAt, scanState, source, ops, refresh } = useStops(selectedDate, mapFilters.carryover ? CARRYOVER_DAYS : 0);

  // Manual "Scan now" — triggers a REAL on-demand NuVizz scan (today loads +
  // today unplanned + tomorrow loads) via the synchronous endpoint, then re-reads
  // the index. 60s cooldown so it can't be mashed.
  const [scanning, setScanning] = useState(false);
  const [scanCooldown, setScanCooldown] = useState(false);
  const [scanErr, setScanErr] = useState(null);
  const manualScan = useCallback(async () => {
    if (scanning || scanCooldown) return;
    setScanning(true); setScanErr(null);
    try {
      // A busy date (hundreds of orders → hundreds of Firestore writes) can't finish
      // inside the 26s synchronous-function cap. So fire the ASYNC background scanner
      // (15-min budget) for the VIEWED date, then poll the index until it refreshes.
      const before = lastScannedAt;
      const pollUrl = `/.netlify/functions/nuvizz-pull-today-stops?date=${encodeURIComponent(selectedDate)}`;
      const resp = await fetch(`/.netlify/functions/nuvizz-refresh-stops-background?date=${encodeURIComponent(selectedDate)}`, { method: 'POST' });
      if (!resp.ok && resp.status !== 202) throw new Error('Scan unavailable');
      let updated = false;
      for (let i = 0; i < 20 && !updated; i++) {          // poll up to ~60s
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const d = await fetchJsonWithRetry(pollUrl);
          if (d && d.lastScannedAt && d.lastScannedAt !== before) updated = true;
        } catch { /* keep polling */ }
      }
      await refresh({ silent: true });
      if (!updated) { setScanErr('Scan running — the board will refresh automatically'); setTimeout(() => setScanErr(null), 6000); }
      setScanCooldown(true);
      setTimeout(() => setScanCooldown(false), 60000);
    } catch (e) {
      setScanErr(e?.message || 'Scan failed');
      setTimeout(() => setScanErr(null), 5000);
    } finally {
      setScanning(false);
    }
  }, [scanning, scanCooldown, refresh, selectedDate, lastScannedAt]);

  const { notes, ready: notesReady } = useCustomerNotes();
  useAutoScanner(stops, notes, notesReady);
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(null); // M5.2 — loadNbr of opened route, or null
  // M5 — Show Routes toggle (persisted). Polylines render only when ON.
  const [showRoutes, setShowRoutes] = useState(() => safeReadJSON(LS_SHOW_ROUTES, false));
  const [filters, setFilters] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // M4.5 P3.3 — Driver marker labels are hidden by default on mobile to reduce
  // visual clutter; tapping a marker temporarily reveals the label as a side
  // effect of opening the driver-snapshot drawer (the labels stay visible while
  // the toggle is on; defaulting it off keeps the small viewport readable).
  const [showDriverLabels, setShowDriverLabels] = useState(() => {
    const stored = safeReadJSON(LS_DRIVER_LABELS, null);
    if (typeof stored === 'boolean') return stored;
    const w = typeof window === 'undefined' ? 1280 : window.innerWidth;
    return w >= MOBILE_BREAKPOINT;
  });
  const [legendExpanded, setLegendExpanded] = useState(() => safeReadJSON(LS_LEGEND_EXPANDED, false));
  const [routeLegendExpanded, setRouteLegendExpanded] = useState(() => safeReadJSON(LS_ROUTE_LEGEND_EXPANDED, true));
  const [bottomTableOpen, setBottomTableOpen] = useState(() => safeReadJSON(LS_BOTTOM_TABLE_OPEN, false));
  const [tableColumns, setTableColumns] = useState(() => ({
    ...DEFAULT_TABLE_COLUMNS,
    ...safeReadJSON(LS_TABLE_COLUMNS, {}),
  }));
  // M4.4 — Map filter toolbar state. The "Show vehicle location" toggle is the
  // same Motive driver overlay that previously lived in the left panel; the
  // duplicate left-panel toggle is removed.
  const [toolbarCollapsed, setToolbarCollapsed] = useState(() => safeReadJSON(LS_FILTER_TOOLBAR_COLLAPSED, true));
  const [statusCollapsed, setStatusCollapsed] = useState(() => safeReadJSON(LS_STATUS_PILL_COLLAPSED, false));
  // M4.5 — Mobile drawer is closed by default on every load; active tab is
  // restored from localStorage so repeat dispatchers land where they left off.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [mobileDrawerTab, setMobileDrawerTab] = useState(() => {
    const t = safeReadJSON(LS_MOBILE_DRAWER_TAB, 'stops');
    return ['stops', 'filters', 'loads'].includes(t) ? t : 'stops';
  });
  // M5 — live drivers (Motive) only meaningful for today. On any other date the
  // overlay is forced off regardless of the toggle's stored value.
  const showDrivers = mapFilters.showVehicleLocation && dateIsToday;
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 200);
  const { history, remember } = useSearchHistory();
  // Desktop historical PRO / customer-history lookup (mobile has its own in
  // MobileStopsTab). Rendered as an overlay so the board stays mounted behind it.
  const [histOpen, setHistOpen] = useState(false);

  // M6 — AI Order Search state. aiMode flips the search box into NL parse mode;
  // aiResult holds the AI-derived match set (from search OR chat) that overrides
  // the literal keyword filter. aiAvailable gates the affordance on the key being
  // configured server-side (probed once via the function's GET endpoint).
  const [aiMode, setAiMode] = useState(false);
  const [aiResult, setAiResult] = useState(null); // { set:Set<stopNbr>, summary, source }
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/.netlify/functions/ai-search')
      .then((r) => r.json())
      .then((d) => { if (alive) setAiAvailable(!!d?.available); })
      .catch(() => { /* leave optimistic; POST surfaces ai_key_missing if needed */ });
    return () => { alive = false; };
  }, []);

  // Box / lasso multi-select. selectMode is the armed tool while drawing;
  // selectionSet is the resulting Set<stopNbr> that highlights + filters the
  // board (via effectiveMatchSet, same mechanism as search/AI). The projection
  // ref converts container pixels <-> LatLng for the drawn shape.
  const [selectMode, setSelectMode] = useState(null); // null | 'box' | 'lasso'
  const [selectionSet, setSelectionSet] = useState(null);
  const [selectNote, setSelectNote] = useState(null);
  const selectionOverlayRef = useRef(null); // OverlayView; getProjection() on demand

  // Pin relocation: movingStop is the stop whose pin is being dragged to its real
  // spot; movedTo holds the dragged coords; saved to customer_notes.location_override.
  const [movingStop, setMovingStop] = useState(null);
  const [movedTo, setMovedTo] = useState(null);
  const [savingLoc, setSavingLoc] = useState(false);
  const [editAddrStop, setEditAddrStop] = useState(null);
  const [editAddrSeed, setEditAddrSeed] = useState(null); // suggested split when opened from the fix banner
  // Open the address editor, optionally seeded with a suggested addr1/addr2 split.
  const openAddrEditor = useCallback((stop, seed = null) => { setEditAddrSeed(seed || null); setEditAddrStop(stop); }, []);
  const movingMarkerRef = useRef(null);

  const { drivers, error: driverErr, lastRefreshed: driversAt } = useDriverPositions(showDrivers);
  const { snapshot, loading: snapshotLoading, error: snapshotError } = useDriverSnapshot(selectedDriver);
  const panel = useResizablePanel(viewportWidth);

  // Driver source for the DNS "barred drivers" picker. Three sources, merged &
  // de-duped case-insensitively (board form wins so a driver on today's loads
  // keeps the label used elsewhere):
  //   1. drivers assigned to the current board's loads (from the scan),
  //   2. the FULL Motive roster (fleet app) — so ANY driver can be barred, not
  //      just ones on today's board or currently positioned,
  //   3. live-positioned Motive drivers (when "Show drivers (live)" is on).
  // Synthetic {driverName} objects are fine — the notes editor only reads .driverName.
  const driverRoster = useDriverRoster();
  const notesDrivers = useMemo(() => {
    const seen = new Set();
    const out = [];
    const add = (name) => {
      const nm = (name || '').trim();
      const k = nm.toLowerCase();
      if (!nm || seen.has(k)) return;
      seen.add(k);
      out.push({ driverName: nm });
    };
    (stops || []).forEach((s) => add(s.driverName));
    (driverRoster || []).forEach((d) => add(d?.name));
    (drivers || []).forEach((d) => add(d?.driverName));
    return out.sort((a, b) => a.driverName.localeCompare(b.driverName));
  }, [drivers, stops, driverRoster]);

  const searchInputRef = useRef(null);
  const mapRef = useRef(null);
  const mapDiv = useRef(null);
  const recenterRef = useRef(null); // latest "fit to stops" fn for the custom control
  const clustererRef = useRef(null);
  const markersRef = useRef([]);
  const driverMarkersRef = useRef([]);
  const driverLabelsRef = useRef([]);
  const labelOverlayClassRef = useRef(null);
  const routePolylinesRef = useRef([]);

  // Persist label-toggle preference whenever it changes.
  useEffect(() => { safeWriteJSON(LS_DRIVER_LABELS, showDriverLabels); }, [showDriverLabels]);
  useEffect(() => { safeWriteJSON(LS_LEGEND_EXPANDED, legendExpanded); }, [legendExpanded]);
  useEffect(() => { safeWriteJSON(LS_TABLE_COLUMNS, tableColumns); }, [tableColumns]);
  useEffect(() => { safeWriteJSON(LS_MAP_FILTERS, mapFilters); }, [mapFilters]);
  useEffect(() => { safeWriteJSON(LS_FILTER_TOOLBAR_COLLAPSED, toolbarCollapsed); }, [toolbarCollapsed]);
  useEffect(() => { safeWriteJSON(LS_STATUS_PILL_COLLAPSED, statusCollapsed); }, [statusCollapsed]);
  useEffect(() => { safeWriteJSON(LS_MOBILE_DRAWER_TAB, mobileDrawerTab); }, [mobileDrawerTab]);
  useEffect(() => { safeWriteJSON(LS_SHOW_ROUTES, showRoutes); }, [showRoutes]);
  useEffect(() => { safeWriteJSON(LS_ROUTE_LEGEND_EXPANDED, routeLegendExpanded); }, [routeLegendExpanded]);
  useEffect(() => { safeWriteJSON(LS_BOTTOM_TABLE_OPEN, bottomTableOpen); }, [bottomTableOpen]);

  // M5 — date change side effects: close any open sidebars (their data was for
  // the previous day) and surface a one-shot note if live drivers were on for a
  // now-non-today date. Stops + routes refetch automatically (date is a dep of
  // useStops + the routes memo). The auto-scanner re-runs when new stops land.
  const [driverGateNote, setDriverGateNote] = useState(false);
  const prevDateRef = useRef(selectedDate);
  useEffect(() => {
    if (prevDateRef.current === selectedDate) return;
    prevDateRef.current = selectedDate;
    setSelectedStop(null);
    setSelectedDriver(null);
    if (!dateIsToday && mapFilters.showVehicleLocation) {
      setDriverGateNote(true);
      setTimeout(() => setDriverGateNote(false), 4000);
    }
  }, [selectedDate, dateIsToday, mapFilters.showVehicleLocation]);

  const goToToday = useCallback(() => setSelectedDate(todayInET()), []);

  // M4.4 — Compute stem-out set client-side. Stem-out = first non-terminal stop
  // in each load (i.e. the outbound leg from terminal to first customer).
  // Stops without a load assignment can't be marked stem-out.
  const stemOutKeys = useMemo(() => {
    const firstSeqByLoad = new Map();
    for (const s of stops) {
      if (!s.loadNbr || s.isTerminal || s.loadStopSeq == null) continue;
      const prev = firstSeqByLoad.get(s.loadNbr);
      if (prev == null || s.loadStopSeq < prev.seq) {
        firstSeqByLoad.set(s.loadNbr, { seq: s.loadStopSeq, key: s.stopNbr });
      }
    }
    const out = new Set();
    for (const v of firstSeqByLoad.values()) if (v.key) out.add(v.key);
    return out;
  }, [stops]);

  // M4.4 — Apply filter toolbar toggles after the existing flag/restriction
  // filter pipeline. Each toggle is a simple inclusion/exclusion test.
  const applyMapFilters = useCallback((rows) => {
    return rows.filter((s) => {
      if (mapFilters.hideTerminal && s.isTerminal) return false;
      if (mapFilters.hideStemOut && stemOutKeys.has(s.stopNbr)) return false;
      // "Unplanned only" ON → hide everything that IS planned (on a load/route);
      // OFF → show all. (isUnplanned means "no driver yet" — wrong signal here;
      // a routed stop with no driver assigned is still planned.)
      if (mapFilters.unplannedOnly && s.isPlanned) return false;
      return true;
    });
  }, [mapFilters.hideTerminal, mapFilters.hideStemOut, mapFilters.unplannedOnly, stemOutKeys]);

  // Filter pipeline: filters → mapFilters → search. Memoized so we don't recompute on each render.
  // A saved customer_notes.location_override replaces the (often wrong) NuVizz
  // geocode for that customer, so the corrected pin sticks for every future load.
  const filteredStops = useMemo(
    () => applyMapFilters(applyFilters(stops, notes, filters)).map((s) => {
      const ov = notes.get(s.matchKey)?.location_override;
      return (ov && typeof ov.lat === 'number' && typeof ov.lng === 'number') ? { ...s, lat: ov.lat, lng: ov.lng } : s;
    }),
    [stops, notes, filters, applyMapFilters],
  );
  // Total pallet count across the loaded board. NuVizz records the pallet count
  // in its carton field (stop.cartons), so we sum that and label it pallets.
  const totalPalletsCount = useMemo(
    () => stops.reduce((sum, s) => sum + (Number(s.cartons) || 0), 0),
    [stops],
  );
  const carryoverCount = useMemo(() => stops.reduce((n, s) => n + (s.carryover ? 1 : 0), 0), [stops]);

  // ── Box / lasso selection ──────────────────────────────────────────────────
  // The live pixel<->LatLng projection is published by an OverlayView created in
  // the map-init effect (must run after mapRef exists). Converts the drawn
  // shape's container pixels to LatLng for the shared enclosure geometry.
  const pxToLatLng = useCallback((x, y) => {
    const proj = selectionOverlayRef.current?.getProjection();
    if (!proj) return null;
    const ll = proj.fromContainerPixelToLatLng(new google.maps.Point(x, y));
    return ll ? { lat: ll.lat(), lng: ll.lng() } : null;
  }, [google]);

  const commitSelection = useCallback((hits) => {
    if (!hits.length) { setSelectNote('No stops in that area'); setTimeout(() => setSelectNote(null), 2500); return; }
    setSelectionSet(new Set(hits.map((s) => s.stopNbr)));
    setSelectNote(`${hits.length} stop${hits.length === 1 ? '' : 's'} selected`);
  }, []);

  // Box: two opposite container-pixel corners. Lasso: a container-pixel path.
  const selectByBox = useCallback((p1, p2) => {
    const a = pxToLatLng(p1.x, p1.y), b = pxToLatLng(p2.x, p2.y);
    if (!a || !b) return;
    const box = boxFromCorners(a, b);
    commitSelection(filteredStops.filter((s) => s.lat != null && s.lng != null && latLngInBounds(s.lat, s.lng, box)));
  }, [pxToLatLng, filteredStops, commitSelection]);

  const selectByLasso = useCallback((pts) => {
    const poly = pts.map((p) => pxToLatLng(p.x, p.y)).filter(Boolean).map((ll) => [ll.lat, ll.lng]);
    if (poly.length < 3) return;
    commitSelection(filteredStops.filter((s) => s.lat != null && s.lng != null && pointInPolygon(s.lat, s.lng, poly)));
  }, [pxToLatLng, filteredStops, commitSelection]);

  const clearSelection = useCallback(() => { setSelectionSet(null); setSelectNote(null); }, []);

  // SMS compose target ({ title, recipients }) — null = closed. Set by the
  // single-stop "Text" button and the bulk "Text selected" action.
  const [smsTargets, setSmsTargets] = useState(null);
  const textCustomer = useCallback((stop) => {
    if (!stop) return;
    const phone = resolveStopPhone(stop, notes.get(stop.matchKey));
    // Always open the composer; if no number is on file the dispatcher can type
    // one in (the modal validates before allowing send).
    setSmsTargets({ title: `Text ${stop.businessName || 'customer'}`, recipients: [{ to: phone, label: stop.businessName || stop.stopNbr }] });
  }, [notes]);
  const textSelected = useCallback(() => {
    if (!selectionSet?.size) return;
    const chosen = stops.filter((s) => selectionSet.has(s.stopNbr));
    const recipients = [];
    let skipped = 0;
    for (const s of chosen) {
      const phone = resolveStopPhone(s, notes.get(s.matchKey));
      if (phone) recipients.push({ to: phone, label: s.businessName || s.stopNbr });
      else skipped++;
    }
    if (!recipients.length) { setSelectNote('No phone numbers in the selected stops'); return; }
    setSmsTargets({ title: `Text ${recipients.length} selected${skipped ? ` (${skipped} have no phone)` : ''}`, recipients });
  }, [selectionSet, stops, notes]);
  // Text a driver by NAME — the phone is resolved server-side from the MarginIQ
  // employee roster (number never reaches the browser).
  const textDriver = useCallback((driverName) => {
    if (!driverName) return;
    setSmsTargets({ title: `Text ${driverName}`, recipients: [{ driverName, label: driverName }] });
  }, []);
  // Bulk: text the DISTINCT drivers of the selected stops (one text per driver).
  const textSelectedDrivers = useCallback(() => {
    if (!selectionSet?.size) return;
    const names = [...new Set(stops.filter((s) => selectionSet.has(s.stopNbr)).map((s) => s.driverName).filter(Boolean))];
    if (!names.length) { setSelectNote('No drivers assigned to the selected stops'); return; }
    setSmsTargets({ title: `Text ${names.length} driver${names.length === 1 ? '' : 's'}`, recipients: names.map((driverName) => ({ driverName, label: driverName })) });
  }, [selectionSet, stops]);

  // Pin relocation handlers + the draggable marker that the dispatcher drags.
  const startMoveLocation = useCallback((stop) => {
    setSelectedStop(null); setSelectedDriver(null);
    setMovedTo(null); setMovingStop(stop);
  }, []);
  // One-click address fix: apply the suggested split, re-geocode the clean street
  // (addr2/suite deliberately excluded) and save address_override + the corrected
  // pin. Throws on geocode/save failure so the banner can surface the error.
  const autoFixAddress = useCallback(async (stop, suggestion) => {
    if (!db || !stop || !suggestion) return;
    const fields = {
      addr1: (suggestion.addr1 || '').trim(),
      addr2: (suggestion.addr2 || '').trim(),
      city: stop.city || '', state: stop.state || '', zip: stop.zip || '',
    };
    const q = [fields.addr1, fields.city, fields.state, fields.zip].filter(Boolean).join(', ');
    // Geocode is best-effort: if it fails (e.g. the Geocoding API isn't enabled →
    // REQUEST_DENIED), still SAVE the corrected addr1/addr2 split so the fix isn't
    // lost — just leave the pin where it was. The dispatcher can drag it via
    // "Correct pin location", and a re-fix will move it once geocoding works.
    let geo = null, geoErr = null;
    try { geo = await geocodeAddress(google, q); } catch (e) { geoErr = e; }
    const payload = {
      match_key: stop.matchKey,
      raw_name: stop.businessName || '',
      address_override: fields,
      address_override_at: serverTimestamp(),
      last_updated: serverTimestamp(),
    };
    if (geo) { payload.location_override = { lat: geo.lat, lng: geo.lng }; payload.location_override_at = serverTimestamp(); }
    await setDoc(doc(db, 'customer_notes', stop.matchKey), payload, { merge: true });
    refresh({ silent: true });
    // Saved the address; surface (non-fatally) that the pin couldn't be moved.
    if (geoErr) throw new Error(`Address saved, but the pin couldn’t be moved — ${geoErr.message}. Enable the Geocoding API or use “Correct pin location” to drag it.`);
  }, [google, refresh]);
  const cancelMoveLocation = useCallback(() => { setMovingStop(null); setMovedTo(null); }, []);
  const saveStopLocation = useCallback(async () => {
    if (!db || !movingStop || !movedTo) return;
    setSavingLoc(true);
    try {
      await setDoc(doc(db, 'customer_notes', movingStop.matchKey), {
        match_key: movingStop.matchKey,
        raw_name: movingStop.businessName || '',
        location_override: { lat: movedTo.lat, lng: movedTo.lng },
        location_override_at: serverTimestamp(),
        last_updated: serverTimestamp(),
      }, { merge: true });
      setMovingStop(null); setMovedTo(null);
    } catch (e) { console.error('save location override', e); }
    finally { setSavingLoc(false); }
  }, [movingStop, movedTo]);
  const resetStopLocation = useCallback(async () => {
    if (!db || !movingStop) return;
    setSavingLoc(true);
    try {
      await setDoc(doc(db, 'customer_notes', movingStop.matchKey), {
        match_key: movingStop.matchKey, location_override: null, last_updated: serverTimestamp(),
      }, { merge: true });
      setMovingStop(null); setMovedTo(null);
    } catch (e) { console.error('reset location override', e); }
    finally { setSavingLoc(false); }
  }, [movingStop]);

  useEffect(() => {
    if (movingMarkerRef.current) { movingMarkerRef.current.setMap(null); movingMarkerRef.current = null; }
    if (!google || !mapRef.current || !movingStop) return;
    const ov = notes.get(movingStop.matchKey)?.location_override;
    const start = {
      lat: (ov && typeof ov.lat === 'number') ? ov.lat : movingStop.lat,
      lng: (ov && typeof ov.lng === 'number') ? ov.lng : movingStop.lng,
    };
    if (start.lat == null || start.lng == null) return;
    setMovedTo(start);
    const m = new google.maps.Marker({
      position: start, map: mapRef.current, draggable: true, zIndex: 99999,
      icon: { url: pinSvgStatus('#1e5b92', {}), scaledSize: new google.maps.Size(34, 44), anchor: new google.maps.Point(17, 42) },
      title: 'Drag to the correct location',
      animation: google.maps.Animation.DROP,
    });
    m.addListener('dragend', () => { const p = m.getPosition(); if (p) setMovedTo({ lat: p.lat(), lng: p.lng() }); });
    movingMarkerRef.current = m;
    mapRef.current.panTo(start);
    if ((mapRef.current.getZoom() || 0) < 16) mapRef.current.setZoom(18);
    return () => { m.setMap(null); };
  }, [google, movingStop]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchMatchSet = useMemo(() => {
    if (aiMode) return null;                       // AI mode: literal keyword filter suspended
    if (!debouncedSearch.trim()) return null;      // null sentinel = no search active
    const set = new Set();
    for (const s of filteredStops) {
      if (stopMatchesSearch(s, notes.get(s.matchKey), debouncedSearch)) set.add(s.stopNbr);
    }
    return set;
  }, [filteredStops, notes, debouncedSearch, aiMode]);

  // M6 — an active AI result (search parse or chat highlight) takes precedence
  // over the literal keyword set. Everything downstream (list + map dim/fit) reads
  // effectiveMatchSet so all surfaces share one filter mechanism. Box/lasso
  // selection takes precedence over search/AI when active.
  const effectiveMatchSet = selectionSet || (aiResult ? aiResult.set : searchMatchSet);

  const visibleStops = useMemo(() => {
    if (!effectiveMatchSet) return filteredStops;
    return filteredStops.filter((s) => effectiveMatchSet.has(s.stopNbr));
  }, [filteredStops, effectiveMatchSet]);

  // M6 — AI search/chat handlers. runAiSearch parses the NL query and applies the
  // returned spec locally; runChat builds the trimmed context and asks the model.
  const runAiSearch = useCallback(async (q) => {
    const query = (q || '').trim();
    if (!query) return;
    setAiBusy(true); setAiError(null);
    try {
      const { spec } = await aiParse(query);
      const set = applyFilterSpec(filteredStops, notes, spec);
      const empty = !spec || ((spec.predicates || []).length === 0 && !spec.text_match);
      if (empty || set.size === 0) {
        // Nothing parseable / no matches → fall back to literal keyword search.
        setAiResult(null);
        setAiMode(false);
        setSearchInput(query);
        setAiError(empty ? 'Couldn’t turn that into a filter — showing keyword matches.' : 'No stops matched that — showing keyword matches.');
        return;
      }
      setAiResult({ set, summary: summarizeSpec(spec, set.size), source: 'search' });
      remember(query);
    } catch (e) {
      setAiError(e?.code === 'ai_key_missing'
        ? 'AI search isn’t configured yet (missing API key).'
        : 'AI search is unavailable right now.');
    } finally {
      setAiBusy(false);
    }
  }, [filteredStops, notes, remember]);

  const clearAi = useCallback(() => { setAiResult(null); setAiError(null); }, []);

  const handleChatSend = useCallback(async (q) => {
    const { stops: ctx, truncated, sent, total } = buildTrimmedStops(filteredStops, notes, 400);
    const res = await aiChat(q, ctx);
    return { ...res, truncated, sent, total };
  }, [filteredStops, notes]);

  // Highlight the stops a chat answer referenced. Uses the model's MATCHED_PRO_IDS
  // line AND any stop numbers it listed in the prose — the latter covers long
  // answers where the trailing IDs line got cut off by the token cap. Returns the
  // count so the chat bubble can report it. Only sets a highlight when non-empty.
  const handleChatHighlight = useCallback((proIds, answerText) => {
    const wanted = new Set((proIds || []).map((p) => String(p).trim()));
    const text = String(answerText || '');
    const set = new Set();
    for (const s of filteredStops) {
      const id = String(s.stopNbr);
      if (wanted.has(id) || (id && text.includes(id))) set.add(s.stopNbr);
    }
    if (set.size) setAiResult({ set, summary: `${set.size} stop${set.size === 1 ? '' : 's'} from chat`, source: 'chat' });
    return set.size;
  }, [filteredStops]);

  // M5 — route grouping (client-side, mirrors parent app src/screens/MapScreen.jsx).
  // Group positioned stops by loadNbr (sequence restarts per load, so one
  // polyline per load keeps order correct). Color by DRIVER so a driver's
  // multiple loads share a color (brief P3.1). Legend aggregates per driver.
  const routeData = useMemo(() => {
    if (!showRoutes) return { byLoad: [], legend: [] };
    const positioned = stops
      .map((s) => { const ov = notes.get(s.matchKey)?.location_override; return (ov && typeof ov.lat === 'number' && typeof ov.lng === 'number') ? { ...s, lat: ov.lat, lng: ov.lng } : s; })
      .filter((s) => s.lat != null && s.lng != null && s.loadNbr && s.driverUserName);
    const loadGroups = new Map();
    for (const s of positioned) {
      if (!loadGroups.has(s.loadNbr)) {
        loadGroups.set(s.loadNbr, {
          loadNbr: s.loadNbr,
          driverUserName: s.driverUserName,
          driverName: s.driverName || s.driverUserName,
          stops: [],
        });
      }
      loadGroups.get(s.loadNbr).stops.push(s);
    }
    const byLoad = [];
    const driverAgg = new Map();
    // Stable, evenly-spread color per driver: sort distinct drivers, assign each
    // a golden-angle hue by index so no two routes share a color (until there are
    // a huge number) and adjacent drivers look clearly different.
    const driverList = [...new Set([...loadGroups.values()].map((g) => g.driverUserName))]
      .sort((a, b) => String(a).localeCompare(String(b)));
    const colorByDriver = new Map(driverList.map((d, i) => [d, routeColorByIndex(i)]));
    for (const g of loadGroups.values()) {
      const ordered = orderRouteStops(g.stops);
      const color = colorByDriver.get(g.driverUserName);
      if (ordered.length >= 2) {
        byLoad.push({ loadNbr: g.loadNbr, driverUserName: g.driverUserName, color, path: ordered });
      }
      const agg = driverAgg.get(g.driverUserName)
        || { driverUserName: g.driverUserName, driverName: g.driverName, color, stopCount: 0 };
      agg.stopCount += g.stops.length;
      driverAgg.set(g.driverUserName, agg);
    }
    const legend = [...driverAgg.values()].sort((a, b) => a.driverUserName.localeCompare(b.driverUserName));
    return { byLoad, legend };
  }, [showRoutes, stops, notes]);

  // M5.2 — the stops on the currently-opened route, kept separate from routeData
  // (which depends on showRoutes). The route detail must render even when the
  // polyline layer is hidden, so derive directly from `stops`.
  const selectedRouteStops = useMemo(() => {
    if (!selectedRoute) return [];
    return stops.filter((s) => s.loadNbr === selectedRoute);
  }, [stops, selectedRoute]);

  // The day's loads, grouped from the board by loadNbr — powers the mobile Loads
  // tab. Delivered count is tolerant of status casing; pallet/weight are summed.
  const loads = useMemo(() => {
    const m = new Map();
    for (const s of stops) {
      if (!s.loadNbr) continue;
      let g = m.get(s.loadNbr);
      if (!g) { g = { loadNbr: s.loadNbr, routeName: s.routeName || null, driverName: s.driverName || null, stops: 0, delivered: 0, pallets: 0, weight: 0 }; m.set(s.loadNbr, g); }
      g.stops++;
      if (/deliver/i.test(s.normalizedStatus || s.status || '')) g.delivered++;
      g.pallets += Number(s.pallets) || 0;
      g.weight += Number(s.weight) || 0;
      if (!g.driverName && s.driverName) g.driverName = s.driverName;
      if (!g.routeName && s.routeName) g.routeName = s.routeName;
    }
    return [...m.values()].sort((a, b) => String(a.routeName || a.loadNbr).localeCompare(String(b.routeName || b.loadNbr)));
  }, [stops]);

  // Init map once google + container are ready.
  useEffect(() => {
    if (!google || !mapDiv.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: BUFORD,
      zoom: 10,
      // Exactly the vector-map control set the dispatcher asked for: the rotate
      // compass + 2D/3D tilt (rotateControl on a vector mapId), zoom, the Street
      // View pegman, and a custom Recenter crosshair (added below). Map-type +
      // fullscreen are dropped (the Filters panel has the Satellite toggle).
      ...(MAP_ID ? { mapId: MAP_ID } : {}),
      mapTypeControl: false,
      streetViewControl: true,
      streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      fullscreenControl: false,
      zoomControl: true,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      rotateControl: true,
      rotateControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      scaleControl: false,
      keyboardShortcuts: false,
      tiltInteractionEnabled: true,
      headingInteractionEnabled: true,
      gestureHandling: 'greedy',
    });
    labelOverlayClassRef.current = makeDriverLabelOverlayClass(google);
    // Custom "Recenter on stops" control (the crosshair). A ref holds the latest
    // fit function so the once-created button always recenters the current board.
    const recenterBtn = document.createElement('button');
    recenterBtn.type = 'button';
    recenterBtn.title = 'Recenter on stops';
    recenterBtn.setAttribute('aria-label', 'Recenter on stops');
    recenterBtn.style.cssText = 'background:#fff;border:none;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,0.3);width:40px;height:40px;margin:0 10px 10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    recenterBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2"><circle cx="12" cy="12" r="6"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/><circle cx="12" cy="12" r="1.5" fill="#5f6368" stroke="none"/></svg>';
    recenterBtn.addEventListener('click', () => recenterRef.current && recenterRef.current());
    mapRef.current.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(recenterBtn);
    // Box/lasso projection: an invisible OverlayView exposes the live
    // pixel<->LatLng projection. Created HERE (not a separate [google] effect)
    // so it runs AFTER mapRef is set — otherwise it no-ops and selection breaks.
    const projOv = new google.maps.OverlayView();
    projOv.onAdd = projOv.draw = projOv.onRemove = () => {};
    projOv.setMap(mapRef.current);
    selectionOverlayRef.current = projOv;
  }, [google]);

  // Keep the Recenter button's action pointed at the current board: fit to all
  // currently-shown stops (or fall back to the default center when none).
  useEffect(() => {
    recenterRef.current = () => {
      if (!google || !mapRef.current) return;
      const pts = filteredStops.filter((s) => s.lat != null && s.lng != null);
      if (!pts.length) { mapRef.current.panTo(BUFORD); mapRef.current.setZoom(10); return; }
      const b = new google.maps.LatLngBounds();
      pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
      mapRef.current.fitBounds(b, 60);
    };
  }, [google, filteredStops]);

  // M4.4 — satellite/roadmap toggle. 'hybrid' = satellite imagery + road labels,
  // which is most useful for spotting docks/yards while keeping street names.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    mapRef.current.setMapTypeId(mapFilters.satellite ? 'hybrid' : 'roadmap');
  }, [google, mapFilters.satellite]);

  // Tell Google Maps to redraw as soon as the panel width changes — otherwise
  // the map tiles leave a gap until the next interaction.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    google.maps.event.trigger(mapRef.current, 'resize');
  }, [google, panel.width]);

  // M4.1: render stop markers with full set + search opacity. We render ALL
  // filteredStops as markers but dim non-matches when a search is active so
  // the dispatcher keeps spatial context. Faded pins still cluster — at
  // zoomed-out levels cluster counts include all in view; at zoom-in the
  // 30%-opacity pins are obviously deprioritized.
  useEffect(() => {
    if (!google || !mapRef.current) return;

    if (clustererRef.current) clustererRef.current.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    // Day-aware receiving-hours clock: only light the clock on the weekday the
    // map is showing. A Friday-only customer's clock appears on Fridays only.
    const selectedDayKey = weekdayKeyFromDate(selectedDate);
    const positioned = filteredStops.filter((s) => s.lat != null && s.lng != null);
    // When a route is open, number its stops in delivery sequence (planned-ETA
    // order = NuVizz's optimized order) and render numbered pins; dim the rest.
    const routeSeqByStop = new Map();
    if (selectedRoute && selectedRouteStops.length) {
      // Number by NuVizz's own sequence value (routeSeq) so the pins read exactly
      // like the Route Workbench — co-located orders share a number, and the order
      // is correct even before a route starts. Fall back to dense position for any
      // stop missing routeSeq (old cached doc).
      orderRouteStops(selectedRouteStops).forEach((s, i) => {
        const rs = routeSeqOf(s);
        routeSeqByStop.set(s.stopNbr, rs != null ? rs : i + 1);
      });
    }
    const newMarkers = positioned.map((s) => {
      const note = notes.get(s.matchKey);
      const seq = routeSeqByStop.get(s.stopNbr);
      const inRoute = seq != null;
      const matched = effectiveMatchSet && effectiveMatchSet.has(s.stopNbr);
      const dim = (effectiveMatchSet && !matched) || (!!selectedRoute && !inRoute);
      // The rich per-stop icon (DNS / numbered route / status-flag-window /
      // restriction) is built by the shared stopMarkerIcon helper so the Map and
      // Routing screens stay pixel-identical.
      const icon = stopMarkerIcon(google, s, note, { selectedDayKey, matched, inRoute, seq });
      const marker = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        icon,
        title: s.businessName || '',
        opacity: dim ? 0.3 : 1,
      });
      marker.addListener('click', () => {
        setSelectedDriver(null);
        setSelectedStop(s);
        handlePanToStop(s);   // match list/search behavior: recenter + zoom to STOP_ZOOM
      });
      return marker;
    });

    markersRef.current = newMarkers;
    // M4.4 — when clustering is disabled, attach markers directly to the map
    // instead of routing through MarkerClusterer. Skipping clustering on 600+
    // pins is intentionally slow at zoom-out; the toolbar surfaces a warning.
    if (mapFilters.showClustered) {
      clustererRef.current = new MarkerClusterer({ map: mapRef.current, markers: newMarkers });
    } else {
      newMarkers.forEach((m) => m.setMap(mapRef.current));
    }
  }, [google, filteredStops, notes, effectiveMatchSet, mapFilters.showClustered, selectedDate, selectedRoute, selectedRouteStops]);

  // Center/zoom the map to fit a route's stops when it's opened (per dispatcher
  // request — NuVizz frames the route on open). Restores the prior board view on close.
  const preRouteViewRef = useRef(null);
  useEffect(() => {
    if (!google || !mapRef.current) return;
    if (selectedRoute) {
      const pts = selectedRouteStops.filter((s) => s.lat != null && s.lng != null);
      if (!pts.length) return;
      if (!preRouteViewRef.current) {
        const c = mapRef.current.getCenter();
        if (c) preRouteViewRef.current = { center: c.toJSON(), zoom: mapRef.current.getZoom() || 10 };
      }
      const b = new google.maps.LatLngBounds();
      pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
      mapRef.current.fitBounds(b, 80);
    } else if (preRouteViewRef.current) {
      mapRef.current.panTo(preRouteViewRef.current.center);
      mapRef.current.setZoom(preRouteViewRef.current.zoom);
      preRouteViewRef.current = null;
    }
  }, [google, selectedRoute, selectedRouteStops]);

  // M5 — route polylines. One straight-line Polyline per load, ordered by
  // loadStopSeq, colored by driver. zIndex 1 keeps them below markers so pins
  // stay clickable. Google redraws on pan/zoom itself — we only rebuild when
  // routeData changes (toggle, refresh, or selectedDate change all flow through
  // routeData via the stops dependency).
  useEffect(() => {
    if (!google || !mapRef.current) return;
    routePolylinesRef.current.forEach((p) => p.setMap(null));
    routePolylinesRef.current = [];
    if (!showRoutes) return;
    for (const route of routeData.byLoad) {
      const path = route.path
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat, lng: s.lng }));
      if (path.length < 2) continue;
      // M5.2 — highlight the open route (thicker, on top, full opacity); when ANY
      // route is open, dim the rest so the dispatcher's eye locks onto the path
      // they're inspecting. No selection → all routes render at normal weight.
      const isSelected = selectedRoute && route.loadNbr === selectedRoute;
      const anySelected = !!selectedRoute;
      const poly = new google.maps.Polyline({
        path,
        strokeColor: route.color,
        strokeOpacity: isSelected ? 1 : (anySelected ? 0.25 : 0.7),
        strokeWeight: isSelected ? 6 : 3,
        geodesic: false,
        zIndex: isSelected ? 3 : 1,
        map: mapRef.current,
      });
      routePolylinesRef.current.push(poly);
    }
  }, [google, showRoutes, routeData, selectedRoute]);

  // Auto-zoom on search results: 1 match → center + open sidebar, 2-10 → fit bounds.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    if (!effectiveMatchSet) return;
    const matched = filteredStops.filter((s) => effectiveMatchSet.has(s.stopNbr) && s.lat != null && s.lng != null);
    if (matched.length === 1) {
      const s = matched[0];
      // Don't auto-open if user already navigated away from search results.
      if (!selectedDriver) { setSelectedStop(s); handlePanToStop(s); }   // saves board view → closing zooms back out
      else { mapRef.current.panTo({ lat: s.lat, lng: s.lng }); mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, STOP_ZOOM)); }
    } else if (matched.length >= 2 && matched.length <= 10) {
      const bounds = new google.maps.LatLngBounds();
      matched.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }));
      mapRef.current.fitBounds(bounds, 60);
    }
  }, [google, effectiveMatchSet]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Build the driver-status line2 text. Route assignment is managed in NuVizz,
  // not Motive, so we do NOT show a "No route assigned" line on the Motive driver
  // tag — only movement status (en route / stopped / stale). If Motive ever does
  // carry route progress we surface it, but its absence is not reported.
  const driverStatusLine = useCallback((d) => {
    let base = '';
    if (d.routeAssigned && d.routeProgress) {
      base = `Stop ${d.routeProgress.completed} of ${d.routeProgress.total}`;
    } else if (d.routeAssigned && d.routeId) {
      base = `Route ${d.routeId} · ${d.routeTotalStops ?? '?'} stops`;
    }
    const suffix = [];
    if (d.speedMph != null && d.speedMph > 5) suffix.push('en route');
    else if (d.speedMph != null && d.speedMph <= 5 && d.stoppedMinutes != null && d.stoppedMinutes > 5) suffix.push('stopped');
    if (d.locatedAt) {
      const ageMin = (Date.now() - new Date(d.locatedAt).getTime()) / 60000;
      if (ageMin > 30) suffix.push('stale');
    }
    return [base, ...suffix].filter(Boolean).join(' · ');
  }, []);

  // M4: driver markers + M4.1 labels — separate layer, larger truck icon.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    driverMarkersRef.current.forEach((m) => m.setMap(null));
    driverMarkersRef.current = [];
    driverLabelsRef.current.forEach((l) => l.setMap(null));
    driverLabelsRef.current = [];
    if (!showDrivers) return;

    const positioned = drivers.filter((d) => d.lat != null && d.lng != null);

    driverMarkersRef.current = positioned.map((d) => {
      const ageMin = d.locatedAt ? (Date.now() - new Date(d.locatedAt).getTime()) / 60000 : 0;
      const stale = ageMin > 30;
      const marker = new google.maps.Marker({
        position: { lat: d.lat, lng: d.lng },
        map: mapRef.current,
        icon: {
          url: truckSvg(DRIVER_TINT),
          scaledSize: new google.maps.Size(40, 40),
          anchor: new google.maps.Point(20, 20),
        },
        title: `${d.driverName || 'Driver'} · ${d.vehicleNumber || ''}`,
        opacity: stale ? 0.55 : 1,
        zIndex: 1000,
      });
      marker.addListener('click', () => {
        setSelectedStop(null);
        setSelectedDriver(d);
      });
      return marker;
    });

    if (showDriverLabels && labelOverlayClassRef.current) {
      const Klass = labelOverlayClassRef.current;
      driverLabelsRef.current = positioned.map((d) => {
        const ageMin = d.locatedAt ? (Date.now() - new Date(d.locatedAt).getTime()) / 60000 : 0;
        const stale = ageMin > 30;
        const first = d.driverFirstName || (d.driverName ? d.driverName.split(/\s+/)[0] : null);
        const lastInit = d.driverLastInitial || (d.driverName ? (d.driverName.split(/\s+/).slice(-1)[0]?.[0] || '') : '');
        const driverPart = d.driverName ? `${first}${lastInit ? ' ' + lastInit + '.' : ''}` : '(no driver)';
        const line1 = `${d.vehicleNumber || '?'} · ${driverPart}`;
        const line2 = driverStatusLine(d);
        const overlay = new Klass(
          new google.maps.LatLng(d.lat, d.lng),
          line1,
          line2,
          { stale },
        );
        overlay.setMap(mapRef.current);
        return overlay;
      });
    }
  }, [google, drivers, showDrivers, showDriverLabels, driverStatusLine]);

  // Keyboard shortcuts: `/` focuses search; Escape clears + blurs (handled in input).
  useEffect(() => {
    const onKey = (e) => {
      // Don't hijack `/` if user is already typing in any input/textarea.
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Trigger map resize once after mount so the initial fit isn't clipped.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    const id = setTimeout(() => google.maps.event.trigger(mapRef.current, 'resize'), 50);
    return () => clearTimeout(id);
  }, [google]);

  const handleSave = async (draft) => {
    if (!db || !selectedStop) return;
    setSaving(true);
    setSaveError(null);
    try {
      const key = selectedStop.matchKey;
      const existing = notes.get(key);
      const pro = selectedStop.pro;
      const proHistory = pro ? bumpProHistory(existing?.pro_history, pro) : (existing?.pro_history || []);
      const payload = {
        ...draft,
        match_key: key,
        raw_name: draft.raw_name || selectedStop.businessName || '',
        raw_address: draft.raw_address || [selectedStop.addr1, selectedStop.city, selectedStop.state, selectedStop.zip].filter(Boolean).join(', '),
        pro_history: proHistory,
        last_updated: serverTimestamp(),
        updated_by: NOTES_UPDATED_BY,
      };
      await setDoc(doc(db, 'customer_notes', key), payload, { merge: true });
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Remembers the board view (center+zoom) from BEFORE we zoomed into a stop, so
  // deselecting restores it (see the selectedStop effect below).
  const preStopViewRef = useRef(null);
  const handlePanToStop = (stopFromSnapshot) => {
    if (!google || !mapRef.current) return;
    if (stopFromSnapshot.lat == null || stopFromSnapshot.lng == null) return;
    // Save the current (board) view once, before the first stop zoom-in.
    if (!preStopViewRef.current) {
      const c = mapRef.current.getCenter();
      if (c) preStopViewRef.current = { center: c.toJSON(), zoom: mapRef.current.getZoom() || 10 };
    }
    mapRef.current.panTo({ lat: stopFromSnapshot.lat, lng: stopFromSnapshot.lng });
    mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, STOP_ZOOM));
  };

  // When the selected stop is cleared, zoom/pan back out to the saved board view.
  useEffect(() => {
    if (selectedStop) return;
    const v = preStopViewRef.current;
    if (v && mapRef.current) {
      mapRef.current.panTo(v.center);
      mapRef.current.setZoom(v.zoom);
    }
    preStopViewRef.current = null;
  }, [selectedStop]);

  // On mobile we drop the resize handle and let the panel be a top-edge sheet.
  // Stretch goal per brief — we ship the simple desktop-only resize and
  // collapse the panel by default on mobile; see HANDOFF.md.
  const panelStyle = isMobile
    ? { width: '100%', maxHeight: '40vh' }
    : { width: panel.width, minWidth: PANEL_MIN_WIDTH, maxWidth: panel.maxWidth };

  // Per brief width tiers (still used for the customer-name truncation cutoff):
  //   240-300px: compact (names truncate)
  //   300px+:    extended names
  // Column visibility itself is user-controlled via the Columns gear (persisted
  // to LS_TABLE_COLUMNS).
  const useExtendedNames = !isMobile && panel.width >= 300;

  // Mobile path: map fills the area, FAB + drawer surface the lists/filters,
  // and the existing stop/driver sidebars switch to absolute full-screen
  // overlay mode. PR 2 of M4.5 will swap those overlays for proper drawers.
  if (isMobile) {
    const pickStopFromMobile = (s) => {
      setSelectedDriver(null);
      setSelectedStop(s);
      setMobileDrawerOpen(false);
      handlePanToStop(s);   // saves the board view so closing zooms back out
    };
    const pickDriverFromMobile = (d) => {
      setSelectedStop(null);
      setSelectedDriver(d);
      setMobileDrawerOpen(false);
      if (google && mapRef.current && d.lat != null && d.lng != null) {
        mapRef.current.panTo({ lat: d.lat, lng: d.lng });
        mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 13));
      }
    };
    // Tap a load → open its route detail (reuses the route drawer) and close the sheet.
    const pickLoadFromMobile = (loadNbr) => {
      setSelectedStop(null);
      setSelectedDriver(null);
      setMobileDrawerOpen(false);
      setSelectedRoute(loadNbr);
    };
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {smsTargets && <SmsComposeModal title={smsTargets.title} recipients={smsTargets.recipients} onClose={() => setSmsTargets(null)} />}
        <div className="flex-1 relative min-w-0 overflow-hidden">
        <div ref={mapDiv} className="absolute inset-0" />
        {/* Box/lasso multi-select: capture overlay (while a tool is armed) + the
            tool controls (kept above the overlay so you can switch/cancel). */}
        {selectMode && (
          <SelectionOverlay
            mode={selectMode}
            onBox={(a, b) => { selectByBox(a, b); setSelectMode(null); }}
            onLasso={(pts) => { selectByLasso(pts); setSelectMode(null); }}
          />
        )}
        <div className="absolute top-12 left-2 z-[16] flex flex-col items-start gap-1">
          <SelectionControls mode={selectMode} setMode={setSelectMode} count={selectionSet?.size || 0} onClear={clearSelection} onText={textSelected} onTextDrivers={textSelectedDrivers} />
          {selectNote && <div className="text-[10px] bg-white/95 border border-slate-200 rounded px-1.5 py-0.5 shadow text-slate-700">{selectNote}</div>}
        </div>
        {/* Top overlay row: date chip (left) + status pill (right) share one
            flex row anchored left-2/right-2, so on a narrow phone they lay out
            side-by-side and can NEVER overlap (the old separate top-2 left/right
            absolutes collided in the middle). The wrapper passes map gestures
            through the gap (pointer-events-none) while each control stays tappable. */}
        <div className="absolute top-2 left-2 right-2 z-10 flex items-start justify-between gap-2 pointer-events-none">
          {/* date chip (P2.7): core control, visible without opening the drawer. */}
          <div className="flex items-center gap-1 bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-1.5 py-1 pointer-events-auto flex-shrink-0">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value); }}
              className="text-[11px] border-0 p-0 focus:outline-none bg-transparent w-[124px]"
              aria-label="Select delivery date"
            />
            {!dateIsToday && (
              <button
                onClick={goToToday}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-blue-300 text-blue-700 active:bg-blue-50"
                title="Today"
              >
                Today
              </button>
            )}
          </div>

          {/* Compact status pill — collapsible to just the stops count (shares
              statusCollapsed with desktop). min-w-0 lets it shrink before it can
              ever reach the date chip. */}
          <div className="bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-2.5 py-1.5 text-[11px] pointer-events-auto min-w-0 flex-shrink max-w-[60vw] overflow-hidden">
            {/* Header row — always visible: collapse toggle + stops, scan, filters. */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setStatusCollapsed((c) => !c)}
                className="flex items-center gap-1 font-semibold min-w-0"
                aria-expanded={!statusCollapsed}
                title={statusCollapsed ? 'Show details' : 'Collapse'}
              >
                {statusCollapsed ? <ChevronDown size={13} className="text-slate-400 flex-shrink-0" /> : <ChevronUp size={13} className="text-slate-400 flex-shrink-0" />}
                <span className="truncate">{stops.length} stops{carryoverCount > 0 ? <span className="text-amber-700 font-normal"> · {carryoverCount} c/o</span> : null}</span>
              </button>
              <button
                onClick={manualScan}
                disabled={scanning || scanCooldown}
                className="ml-auto p-1 rounded hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50 flex-shrink-0"
                aria-label="Scan now"
                title={scanCooldown ? 'Just scanned — try again shortly' : 'Scan now (fresh pull from NuVizz)'}
              >
                <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
              </button>
              <span className="w-px self-stretch bg-slate-200 flex-shrink-0" aria-hidden />
              <button
                onClick={() => { setMobileDrawerTab('filters'); setMobileDrawerOpen(true); }}
                className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-100 active:bg-slate-200 font-semibold text-slate-700 flex-shrink-0"
                aria-label="Open filters"
              >
                <Filter size={14} /> Filters
              </button>
            </div>
            {/* Stacked details — hidden when collapsed (mirrors desktop). */}
            {!statusCollapsed && (
              <div className="mt-0.5 leading-tight min-w-0 [&>div]:truncate">
                <div className="text-slate-600 text-[10px]">{totalPalletsCount.toLocaleString()} total pallets</div>
                <FeedTimestamps loadAt={lastLoadScanAt} unplannedAt={lastUnplannedScanAt} isToday={dateIsToday} className="text-slate-500 text-[10px]" stacked />
                {ops && typeof ops.dayCount === 'number' && (
                  <>
                    <div className="text-slate-500 text-[10px]" title={`Today's NuVizz API calls (${ops.mode})${ops.byRoute && Object.keys(ops.byRoute).length ? ' · ' + Object.entries(ops.byRoute).map(([k, v]) => `${k}:${v}`).join(' ') : ''}`}>
                      NuVizz calls: {ops.dayCount.toLocaleString()}{ops.ceiling ? ` / ${ops.ceiling.toLocaleString()}` : ''} <span className="text-slate-400">({ops.mode}{ops.breaker ? ', halted' : ''})</span>
                    </div>
                    <HourlyCalls byHour={ops.byHour} className="text-slate-400 text-[10px] mt-0.5" />
                  </>
                )}
                {scanState?.halted && (
                  <div className="text-[10px] font-semibold text-red-700">
                    {scanState.reason === 'ceiling'
                      ? 'Daily scan limit reached — updates resume after midnight UTC'
                      : 'Scanning paused (kill switch) — board may be stale'}
                  </div>
                )}
                {scanErr && <div className="text-[10px] text-red-600">{scanErr}</div>}
              </div>
            )}
          </div>
        </div>
        {driverGateNote && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-amber-50 border border-amber-300 rounded shadow px-2 py-1 text-[10px] text-amber-800">
            Live drivers only available for today.
          </div>
        )}
        {mapsError && (
          <div className="absolute top-2 left-2 right-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-800 z-10">
            <div className="font-semibold">Google Maps failed to load</div>
            <div className="mt-0.5">{mapsError}</div>
          </div>
        )}
        {!visibleStops.length && !loading && !mapsError && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded shadow px-3 py-1 text-[11px] text-slate-600 z-10">
            {debouncedSearch ? `No stops match "${debouncedSearch}"` : 'No stops match filters'}
          </div>
        )}

        {error && (
          <div className="absolute bottom-24 left-2 right-2 bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 z-10">
            ⚠ {error}
          </div>
        )}

        {/* APP_VERSION chip — above the FAB so they don't overlap.
            Brief P3.5: 11px gray, white background. */}
        <div
          className="absolute right-3 text-[11px] text-slate-500 bg-white/95 rounded px-1.5 py-0.5 z-10 border border-slate-200"
          style={{ bottom: `calc(80px + env(safe-area-inset-bottom))` }}
        >
          v{APP_VERSION}
        </div>

        {/* Navigation is the persistent bottom tab bar (below the map area). */}

        {/* Floating launchers (mobile), bottom-left: texting (message bubble) +
            AI assistant ("?"). Hidden while a panel/overlay is open. */}
        {!chatOpen && !selectedStop && !selectedDriver && !selectedRoute && !mobileDrawerOpen && (
          <div className="absolute left-3 z-[39] flex flex-col gap-2" style={{ bottom: `calc(20px + env(safe-area-inset-bottom))` }}>
            {onOpenMessages && <MessagesLauncher onClick={onOpenMessages} unread={smsUnread} />}
            {aiAvailable && <ChatLauncher onClick={() => setChatOpen(true)} active={aiResult?.source === 'chat'} />}
          </div>
        )}
        <ChatPanel
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onSend={handleChatSend}
          onHighlight={handleChatHighlight}
          onClear={clearAi}
          highlightActive={aiResult?.source === 'chat'}
          stopCount={filteredStops.length}
        />
        {movingStop && (
          <MoveLocationBar
            stop={movingStop}
            saving={savingLoc}
            onSave={saveStopLocation}
            onCancel={cancelMoveLocation}
            onReset={resetStopLocation}
          />
        )}
        {editAddrStop && (
          <AddressEditModal
            stop={editAddrStop}
            note={notes.get(editAddrStop.matchKey)}
            google={google}
            seed={editAddrSeed}
            onClose={() => { setEditAddrStop(null); setEditAddrSeed(null); }}
            onSaved={() => refresh({ silent: true })}
          />
        )}

        <MobileDrawer
          open={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          activeTab={mobileDrawerTab}
          setActiveTab={setMobileDrawerTab}
        >
          {mobileDrawerTab === 'stops' && (
            <MobileStopsTab
              stops={visibleStops}
              notes={notes}
              drivers={drivers}
              searchInput={searchInput}
              setSearchInput={setSearchInput}
              resultCount={visibleStops.length}
              totalCount={filteredStops.length}
              onPickStop={pickStopFromMobile}
              aiAvailable={aiAvailable}
              onAskAi={runAiSearch}
              aiBusy={aiBusy}
              aiSummary={aiResult?.source === 'search' ? aiResult.summary : null}
              aiError={aiError}
              onClearAi={clearAi}
            />
          )}
          {mobileDrawerTab === 'filters' && (
            <MobileFiltersTab
              filters={filters}
              setFilters={setFilters}
              counts={{ visible: visibleStops.length, total: stops.length }}
              mapFilters={mapFilters}
              setMapFilters={setMapFilters}
              showRoutes={showRoutes}
              setShowRoutes={setShowRoutes}
              vehicleDisabled={!dateIsToday}
            />
          )}
          {mobileDrawerTab === 'loads' && (
            <MobileLoadsTab
              loads={loads}
              onPickLoad={pickLoadFromMobile}
            />
          )}
        </MobileDrawer>

        {/* Stop detail drawer — slides up over the map. Tabs Info / Notes /
            Hours / PROs. Editing on Notes or Hours pins a sticky Save bar. */}
        {!selectedDriver && !selectedRoute && selectedStop && (
          <MobileStopDetailDrawer
            stop={selectedStop}
            note={notes.get(selectedStop.matchKey)}
            drivers={notesDrivers}
            onText={textCustomer}
            onClose={() => setSelectedStop(null)}
            onMoveLocation={startMoveLocation}
            onEditAddress={openAddrEditor}
            onAutoFixAddress={autoFixAddress}
            onOpenRoute={(loadNbr) => { setSelectedStop(null); setSelectedRoute(loadNbr); }}
            onSave={async (draft) => {
              await handleSave(draft);
              // handleSave clears saveError on success; close the drawer if
              // there was no error this cycle. (saveError is checked on the
              // next render, so we read the post-save state via a setTimeout
              // tick — but simplest: leave the drawer open on save so the
              // user can confirm the green state, and rely on the X to dismiss.)
            }}
            saving={saving}
            saveError={saveError}
          />
        )}

        {/* M5.2 — route detail drawer (mobile). Same bottom-sheet pattern as the
            stop detail; opened from the stop detail's "View full route" button. */}
        {!selectedDriver && selectedRoute && (
          <MobileRouteDetailDrawer
            loadNbr={selectedRoute}
            stops={selectedRouteStops}
            onClose={() => setSelectedRoute(null)}
            onPickStop={(s) => {
              setSelectedRoute(null);
              setSelectedStop(s);
              handlePanToStop(s);   // saves the board view so closing zooms back out
            }}
          />
        )}

        {/* Driver snapshot drawer — slides up over the map. Tap a stop row in
            the snapshot to dismiss the drawer, pan the map, and open the stop
            detail drawer for that stop. */}
        {selectedDriver && (
          <MobileDriverSnapshotDrawer
            driver={selectedDriver}
            snapshot={snapshot}
            loading={snapshotLoading}
            error={snapshotError}
            onText={textDriver}
            onClose={() => setSelectedDriver(null)}
            onPickStopFromSnapshot={(snapshotStop) => {
              // Try to resolve the snapshot stop (which has its own row shape)
              // back to a live stop from today's map so we can open the full
              // stop detail drawer. Match on the primary PRO; fall back to any
              // PRO in the stop.pros array. If no match, just pan the map.
              const targetPros = new Set();
              if (snapshotStop.primaryPro) targetPros.add(snapshotStop.primaryPro);
              if (snapshotStop.pro) targetPros.add(snapshotStop.pro);
              if (Array.isArray(snapshotStop.pros)) {
                for (const p of snapshotStop.pros) targetPros.add(p);
              }
              const liveMatch = targetPros.size
                ? stops.find((s) => {
                    if (s.pro && targetPros.has(s.pro)) return true;
                    if (Array.isArray(s.pros)) {
                      for (const p of s.pros) if (targetPros.has(p)) return true;
                    }
                    return false;
                  })
                : null;
              setSelectedDriver(null);
              if (liveMatch) {
                setSelectedStop(liveMatch);
                handlePanToStop(liveMatch);   // saves the board view so closing zooms back out
              } else {
                handlePanToStop(snapshotStop);
              }
            }}
          />
        )}
        </div>
        <MobileTabBar
          active={mobileDrawerOpen ? mobileDrawerTab : selectedRoute ? 'loads' : selectedStop ? 'stops' : 'map'}
          onMap={() => { setMobileDrawerOpen(false); setSelectedStop(null); setSelectedRoute(null); setSelectedDriver(null); }}
          onStops={() => { setSelectedStop(null); setSelectedRoute(null); setSelectedDriver(null); setMobileDrawerTab('stops'); setMobileDrawerOpen(true); }}
          onFilters={() => { setSelectedStop(null); setSelectedRoute(null); setSelectedDriver(null); setMobileDrawerTab('filters'); setMobileDrawerOpen(true); }}
          onLoads={() => { setSelectedStop(null); setSelectedRoute(null); setSelectedDriver(null); setMobileDrawerTab('loads'); setMobileDrawerOpen(true); }}
        />
      </div>
    );
  }

  // Desktop / tablet (≥768px): existing layout unchanged.
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Historical PRO / customer-history lookup — overlay (desktop). Prefilled
          with whatever's typed in the live search so it searches immediately. */}
      {histOpen && (
        <div
          className="fixed inset-0 z-[1100] bg-slate-900/40 flex items-start justify-center p-4 sm:p-8"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setHistOpen(false); }}
        >
          <div className="w-full max-w-lg max-h-[85vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <PastProSearch
              notes={notes}
              initialQuery={searchInput}
              onPickCustomer={(s) => { setHistOpen(false); setSelectedDriver(null); setSelectedStop(s); }}
              onClose={() => setHistOpen(false)}
            />
          </div>
        </div>
      )}
      {smsTargets && <SmsComposeModal title={smsTargets.title} recipients={smsTargets.recipients} onClose={() => setSmsTargets(null)} />}
      {/* Left filter rail */}
      <div
        className="flex-shrink-0 bg-white border-r overflow-y-auto"
        style={panelStyle}
      >
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          onSubmit={(v) => { if (v.trim()) remember(v.trim()); }}
          history={history}
          inputRef={searchInputRef}
          resultCount={visibleStops.length}
          totalCount={filteredStops.length}
          aiAvailable={aiAvailable}
          aiMode={aiMode}
          setAiMode={(v) => { setAiMode(v); if (!v) clearAi(); }}
          onAskAi={runAiSearch}
          aiBusy={aiBusy}
          aiSummary={aiResult?.source === 'search' ? aiResult.summary : null}
          aiError={aiError}
          onClearAi={clearAi}
        />
        <div className="px-3 pt-2">
          <button
            onClick={() => setHistOpen(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg py-2 hover:bg-slate-50 active:bg-slate-100"
          >
            <Clock size={13} /> Search past PROs / customer history
          </button>
        </div>
        <FilterPanel
          filters={filters}
          setFilters={setFilters}
          counts={{ visible: visibleStops.length, total: stops.length }}
        />
        <Legend expanded={legendExpanded} setExpanded={setLegendExpanded} />
        {showRoutes && (
          <DriverRouteLegend legend={routeData.legend} expanded={routeLegendExpanded} setExpanded={setRouteLegendExpanded} />
        )}
        {/* M4.4 — Vehicle visibility moved to the map filter toolbar. This
        block keeps only the driver-status text + label-toggle, which are
        secondary to the visibility decision. Hidden entirely when vehicles
        are off. */}
        {showDrivers && (
          <div className="border-t p-3 space-y-2">
            <button
              onClick={() => setShowDriverLabels((v) => !v)}
              className="w-full text-xs py-1 rounded inline-flex items-center justify-center gap-1.5 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
              title="Toggle truck/driver labels"
            >
              {showDriverLabels ? <Tags size={12} /> : <Tag size={12} />}
              {showDriverLabels ? 'Hide labels' : 'Show labels'}
            </button>
            <div className="text-[10px] text-slate-500">
              {driverErr ? <span className="text-red-600">⚠ {driverErr}</span> : `${drivers.length} drivers · refresh 60s${driversAt ? ` · ${fmtTimeAgo(driversAt)}` : ''}`}
            </div>
          </div>
        )}

        <StopMiniTable
          stops={visibleStops}
          notes={notes}
          onPick={(s) => { setSelectedDriver(null); setSelectedStop(s); handlePanToStop(s); }}
          columns={tableColumns}
          onColumnsChange={setTableColumns}
          searchQuery={debouncedSearch}
          truncateNames={!useExtendedNames}
        />
      </div>

      {/* Resize handle — desktop only */}
      <ResizeHandle onMouseDown={panel.onMouseDown} onDoubleClick={panel.onDoubleClick} />

      {/* Map */}
      <div className="flex-1 relative min-w-0">
        <div ref={mapDiv} className="absolute inset-0" />
        {/* Box/lasso multi-select: capture overlay + tool controls (above it). */}
        {selectMode && (
          <SelectionOverlay
            mode={selectMode}
            onBox={(a, b) => { selectByBox(a, b); setSelectMode(null); }}
            onLasso={(pts) => { selectByLasso(pts); setSelectMode(null); }}
          />
        )}
        {/* M5 — date picker, top-left of the map canvas. */}
        {!isMobile && (
          <div className="absolute top-3 left-3 z-[16] flex flex-col items-start gap-2">
            <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} onToday={goToToday} />
            <SelectionControls mode={selectMode} setMode={setSelectMode} count={selectionSet?.size || 0} onClear={clearSelection} onText={textSelected} onTextDrivers={textSelectedDrivers} />
            {selectNote && <div className="text-[11px] bg-white/95 border border-slate-200 rounded px-2 py-0.5 shadow text-slate-700">{selectNote}</div>}
          </div>
        )}
        {/* M5.1 — top-right controls live in ONE right-aligned vertical column:
            status pill (row), then the filter toolbar. Stacking them in-flow
            (instead of absolute offsets) means the toolbar can never be buried
            under the pill regardless of the pill's height — the overlap bug
            that hid the toolbar. "Show routes" now lives inside the toolbar. */}
        {!isMobile && (
          <div className="absolute top-3 right-3 z-[6] flex flex-col items-end gap-2">
            <div className="bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-2.5 py-1.5 text-xs">
              {/* Header row: stops count + collapse/refresh — always visible. */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStatusCollapsed((c) => !c)}
                  className="flex items-center gap-1 font-semibold hover:text-slate-600"
                  title={statusCollapsed ? 'Show details' : 'Collapse'}
                  aria-expanded={!statusCollapsed}
                >
                  {statusCollapsed ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronUp size={13} className="text-slate-400" />}
                  <span>{stops.length} stops{carryoverCount > 0 ? <span className="text-amber-700 font-normal"> · {carryoverCount} c/o</span> : null}</span>
                </button>
                <button
                  onClick={manualScan}
                  disabled={scanning || scanCooldown}
                  className="ml-auto p-1 rounded hover:bg-slate-100 disabled:opacity-50"
                  title={scanCooldown ? 'Just scanned — try again shortly' : 'Scan now (fresh pull from NuVizz)'}
                >
                  <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} />
                </button>
              </div>
              {/* Stacked details — hidden when collapsed. */}
              {!statusCollapsed && (
                <div className="mt-0.5 leading-tight">
                  <div className="text-slate-600">{totalPalletsCount.toLocaleString()} total pallets</div>
                  <FeedTimestamps loadAt={lastLoadScanAt} unplannedAt={lastUnplannedScanAt} isToday={dateIsToday} className="text-slate-500" stacked />
                  {ops && typeof ops.dayCount === 'number' && (
                    <>
                      <div className="text-slate-500" title={`Today's NuVizz API calls (${ops.mode})${ops.byRoute && Object.keys(ops.byRoute).length ? ' · ' + Object.entries(ops.byRoute).map(([k, v]) => `${k}:${v}`).join(' ') : ''}`}>
                        NuVizz calls: {ops.dayCount.toLocaleString()}{ops.ceiling ? ` / ${ops.ceiling.toLocaleString()}` : ''} <span className="text-slate-400">({ops.mode}{ops.breaker ? ', halted' : ''})</span>
                      </div>
                      <HourlyCalls byHour={ops.byHour} className="text-slate-400 text-[10px] mt-0.5" />
                    </>
                  )}
                  {scanErr && <div className="text-[11px] text-red-600">{scanErr}</div>}
                </div>
              )}
            </div>
            <FilterToolbar
              filters={mapFilters}
              setFilters={setMapFilters}
              collapsed={toolbarCollapsed}
              setCollapsed={setToolbarCollapsed}
              stopCount={filteredStops.length}
              vehicleDisabled={!dateIsToday}
              showRoutes={showRoutes}
              setShowRoutes={setShowRoutes}
            />
            {/* Launchers at the bottom of the right control column: texting
                (message bubble) + AI assistant ("?"). */}
            {onOpenMessages && <MessagesLauncher onClick={onOpenMessages} unread={smsUnread} />}
            {aiAvailable && !chatOpen && (
              <ChatLauncher onClick={() => setChatOpen(true)} active={aiResult?.source === 'chat'} />
            )}
          </div>
        )}
        {/* M6 — chat panel (fixed; renders as a card on desktop). */}
        <ChatPanel
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onSend={handleChatSend}
          onHighlight={handleChatHighlight}
          onClear={clearAi}
          highlightActive={aiResult?.source === 'chat'}
          stopCount={filteredStops.length}
        />
        {movingStop && (
          <MoveLocationBar
            stop={movingStop}
            saving={savingLoc}
            onSave={saveStopLocation}
            onCancel={cancelMoveLocation}
            onReset={resetStopLocation}
          />
        )}
        {editAddrStop && (
          <AddressEditModal
            stop={editAddrStop}
            note={notes.get(editAddrStop.matchKey)}
            google={google}
            seed={editAddrSeed}
            onClose={() => { setEditAddrStop(null); setEditAddrSeed(null); }}
            onSaved={() => refresh({ silent: true })}
          />
        )}
        {/* M5 — one-shot note when live drivers were auto-disabled for a past/future date. */}
        {driverGateNote && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[7] bg-amber-50 border border-amber-300 rounded shadow px-3 py-1.5 text-xs text-amber-800">
            Live drivers only available for today's date.
          </div>
        )}
        {mapsError && (
          <div className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800 z-[8]">
            <div className="font-semibold">Google Maps failed to load</div>
            <div className="text-xs mt-1">{mapsError}</div>
            <div className="text-xs mt-1 text-red-600">Set VITE_GOOGLE_MAPS_API_KEY in your .env / Netlify env.</div>
          </div>
        )}
        {!visibleStops.length && !loading && !mapsError && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded shadow px-3 py-1.5 text-xs text-slate-600 z-[5] text-center max-w-xs">
            {debouncedSearch
              ? `No stops match "${debouncedSearch}"`
              : dateIsToday
                ? 'No stops match the current filters.'
                : 'No loads are built for this date yet.'}
          </div>
        )}

        {error && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 rounded px-3 py-1.5 text-xs text-red-700">
            ⚠ {error}
          </div>
        )}

        {/* NuVizz-style bottom data grid — collapsible spreadsheet of the board. */}
        <BottomStopsTable
          stops={visibleStops}
          loadStops={stops}
          boardDate={selectedDate}
          notes={notes}
          totalCount={filteredStops.length}
          open={bottomTableOpen}
          setOpen={setBottomTableOpen}
          onPick={(s) => { setSelectedDriver(null); setSelectedStop(s); handlePanToStop(s); }}
          onPickLoad={(loadNbr) => {
            // Open the load's route drawer (same surface as "View route" on a
            // stop) and frame the map on that load's positioned stops.
            setSelectedDriver(null);
            setSelectedStop(null);
            setSelectedRoute(loadNbr);
            if (google && mapRef.current) {
              const pts = stops.filter((s) => s.loadNbr === loadNbr && s.lat != null && s.lng != null);
              if (pts.length) {
                const b = new google.maps.LatLngBounds();
                pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
                mapRef.current.fitBounds(b, 60);
              }
            }
          }}
        />
      </div>

      {/* Right sidebar — driver snapshot takes priority when a driver is selected. */}
      {selectedDriver && (
        <DriverSnapshotSidebar
          driver={selectedDriver}
          snapshot={snapshot}
          loading={snapshotLoading}
          error={snapshotError}
          onText={textDriver}
          onClose={() => setSelectedDriver(null)}
          onPanToStop={handlePanToStop}
        />
      )}
      {!selectedDriver && !selectedRoute && selectedStop && (
        <StopSidebar
          stop={selectedStop}
          note={notes.get(selectedStop.matchKey)}
          drivers={notesDrivers}
          onText={textCustomer}
          onClose={() => setSelectedStop(null)}
          onMoveLocation={startMoveLocation}
          onEditAddress={openAddrEditor}
          onAutoFixAddress={autoFixAddress}
          onSave={handleSave}
          saving={saving}
          saveError={saveError}
          onOpenRoute={(loadNbr) => { setSelectedStop(null); setSelectedRoute(loadNbr); }}
        />
      )}
      {!selectedDriver && selectedRoute && (
        <RouteDetailSidebar
          loadNbr={selectedRoute}
          stops={selectedRouteStops}
          onClose={() => setSelectedRoute(null)}
          onPickStop={(s) => {
            setSelectedRoute(null);
            setSelectedStop(s);
            handlePanToStop(s);   // saves the board view so closing zooms back out
          }}
        />
      )}
    </div>
  );
}

// Render the PRO cell content per brief: matched PRO first when a search is
// active; "+N" suffix when proCount > 1; em dash when empty. Returns a
// fragment so the parent <td> stays the layout boundary.
function renderProCell(stop, searchQuery) {
  const pros = stop.pros || (stop.pro ? [stop.pro] : []);
  if (pros.length === 0) return <span>—</span>;
  const matched = searchQuery ? matchedPro(stop, searchQuery) : null;
  const head = matched || pros[0];
  const rest = pros.length - 1;
  const tooltip = pros.length > 1 ? pros.join('\n') : undefined;
  return (
    <span title={tooltip} tabIndex={pros.length > 1 ? 0 : -1}>
      {head}{rest > 0 ? <span className="text-slate-400"> +{rest}</span> : null}
    </span>
  );
}

// Columns gear menu — anchored to the top-right of the StopMiniTable header.
// Click toggles a checkbox; localStorage persistence is handled by parent.
function ColumnsMenu({ columns, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-1 rounded hover:bg-slate-100 text-slate-500"
        title="Toggle table columns"
        aria-label="Toggle table columns"
      >
        <Settings size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[140px]">
          {TABLE_COLUMN_DEFS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={!!columns[key]}
                onChange={(e) => onChange({ ...columns, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// NuVizz-style bottom data grid. Spans the map width, fully collapsible (the
// header bar stays as the toggle). Rows mirror the loaded board (respects
// filters/search/box-lasso selection via the `stops` it's handed). Click a row
// to open + center that stop. Horizontally scrollable for the wide column set.
// NuVizz status buckets for the bottom-table status filter. Each maps to one or
// more of the app's classifyStopStatus() values.
const TABLE_STATUS_BUCKETS = [
  { k: 'unplanned', label: 'Un-Planned', match: ['UNPLANNED'], codes: ['10'] },
  { k: 'planned', label: 'Planned', match: ['SCHEDULED'], codes: ['20'] },
  { k: 'in_transit', label: 'In-Transit', match: ['OUT_FOR_DEL', 'ARRIVED'], codes: ['40', '50'] },
  { k: 'completed', label: 'Completed', match: ['DELIVERED'], codes: ['90', '91'] },
  { k: 'cancelled', label: 'Cancelled', match: ['EXCEPTION'], codes: ['99'] },
];
function tableStatusBucket(stop) {
  const st = classifyStopStatus(stop);
  const b = TABLE_STATUS_BUCKETS.find((x) => x.match.includes(st));
  return b ? b.k : 'planned';
}
// Compact per-status chips for the Loads view status breakdown.
const LOAD_BUCKET_ABBR = { unplanned: 'Un', planned: 'Pl', in_transit: 'Tr', completed: 'Dn', cancelled: 'Ex' };
const LOAD_BUCKET_STYLE = {
  unplanned: 'bg-slate-100 text-slate-600',
  planned: 'bg-blue-100 text-blue-700',
  in_transit: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

function BottomStopsTable({ stops, loadStops, boardDate, notes, totalCount, open, setOpen, onPick, onPickLoad }) {
  // Loads view groups the FULL board's loads (loadStops) so stop-level filters —
  // notably "Unplanned only" — don't empty it. Falls back to the visible stops.
  const loadSrc = loadStops || stops;
  const [q, setQ] = useState('');
  const [view, setView] = useState('stops'); // 'stops' | 'loads'
  // The day's full load ROSTER (incl. empty loads with no orders yet), pulled on demand
  // when the Loads view is open. Empty loads can't appear from stop-grouping (no stops to
  // group), so we merge these in. Follows the selected board date.
  const [roster, setRoster] = useState([]);
  const [statusSel, setStatusSel] = useState(() => new Set()); // empty = all
  const [statusOpen, setStatusOpen] = useState(false);
  // NuVizz live pull (desktop toolbar): when nvWindow is set, the grid shows stops
  // fetched straight from NuVizz's stop list (any delivery-date window / status)
  // instead of today's board — e.g. "all unplanned ±7 days". Driver is a local
  // refinement applied to whatever rows are shown.
  const [nvWindow, setNvWindow] = useState(''); // '' = board; else arrival period ('0d','+/-7d')
  const [nvRows, setNvRows] = useState([]);
  const [nvTotal, setNvTotal] = useState(0);
  const [nvLoading, setNvLoading] = useState(false);
  const [nvErr, setNvErr] = useState(null);
  const [driverSel, setDriverSel] = useState('');
  // Drag-resizable height (px), persisted. Drag the top handle up/down.
  const [height, setHeight] = useState(() => {
    const v = safeReadJSON(LS_BOTTOM_TABLE_HEIGHT, 300);
    return typeof v === 'number' && v > 0 ? v : 300;
  });
  useEffect(() => { safeWriteJSON(LS_BOTTOM_TABLE_HEIGHT, height); }, [height]);
  const onResizeDown = (e) => {
    e.preventDefault();
    const move = (ev) => {
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      setHeight(Math.max(120, Math.min(window.innerHeight * 0.85, window.innerHeight - y)));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  const cols = [
    { k: 'stop', label: 'Stop #', w: 96, get: (s) => <span className="font-mono text-blue-700">{s.stopNbr}</span>, sortVal: (s) => (Number.isFinite(Number(s.stopNbr)) ? Number(s.stopNbr) : s.stopNbr) },
    { k: 'name', label: 'Ship To Name', w: 220, get: (s) => s.businessName || '—', sortVal: (s) => s.businessName },
    { k: 'addr1', label: 'Address 1', w: 200, get: (s) => s.addr1 || '—', sortVal: (s) => s.addr1 },
    { k: 'addr2', label: 'Address 2', w: 150, get: (s) => s.addr2 || '', sortVal: (s) => s.addr2 },
    { k: 'city', label: 'City', w: 120, get: (s) => s.city || '—', sortVal: (s) => s.city },
    { k: 'zip', label: 'Zip', w: 70, get: (s) => s.zip || '', sortVal: (s) => s.zip },
    { k: 'cartons', label: 'Pallets', w: 70, get: (s) => (s.cartons ?? '—'), align: 'right', sortVal: (s) => (typeof s.cartons === 'number' ? s.cartons : null) },
    { k: 'volume', label: 'Loose', w: 64, get: (s) => (s.volume ?? '—'), align: 'right', sortVal: (s) => (typeof s.volume === 'number' ? s.volume : null) },
    { k: 'weight', label: 'Weight', w: 80, get: (s) => (s.weight != null ? Number(s.weight).toLocaleString() : '—'), align: 'right', sortVal: (s) => (s.weight != null ? Number(s.weight) : null) },
    { k: 'restr', label: 'Restrictions', w: 160, get: (s) => {
        const keys = getRestrictionBadgeKeys(notes.get(s.matchKey) || null);
        return keys.length ? keys.map((k) => RESTRICTION_ICONS[k]?.short || k).join(', ') : '';
      }, sortVal: (s) => getRestrictionBadgeKeys(notes.get(s.matchKey) || null).map((k) => RESTRICTION_ICONS[k]?.short || k).join(', ') },
    { k: 'load', label: 'Load', w: 150, get: (s) => s.routeName || s.loadNbr || '', sortVal: (s) => s.routeName || s.loadNbr || '' },
    { k: 'driver', label: 'Driver', w: 150, get: (s) => s.driverName || '', sortVal: (s) => s.driverName },
  ];
  // Board mode shows today's loaded stops; NuVizz mode shows the live-pulled set.
  const baseStops = nvWindow ? nvRows : stops;
  // Pull from NuVizz whenever a date window is selected (re-pull when the status
  // selection changes so status filters server-side, not just on the loaded page).
  useEffect(() => {
    if (!nvWindow) { setNvErr(null); return; }
    let cancelled = false;
    const codes = TABLE_STATUS_BUCKETS.filter((b) => statusSel.has(b.k)).flatMap((b) => b.codes);
    setNvLoading(true); setNvErr(null);
    fetch('/.netlify/functions/nuvizz-stop-explorer', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arrivalPeriod: nvWindow, statusCodes: codes, page: 1, pageSize: 200 }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error || 'pull failed');
        const decorated = (j.rows || []).map((s) => ({
          ...s,
          matchKey: normalizeMatchKey(s.businessName || '', s.addr1 || '', s.city || '', s.zip || ''),
          loadNbr: s.routeName || '',
        }));
        setNvRows(decorated); setNvTotal(j.total ?? decorated.length);
      })
      .catch((e) => { if (!cancelled) { setNvErr(e.message); setNvRows([]); setNvTotal(0); } })
      .finally(() => { if (!cancelled) setNvLoading(false); });
    return () => { cancelled = true; };
  }, [nvWindow, statusSel]);
  const driverOptions = useMemo(() => {
    const set = new Set();
    for (const s of baseStops) if (s.driverName) set.add(s.driverName);
    return [...set].sort();
  }, [baseStops]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return baseStops.filter((s) => {
      // Status: client-side in board mode; server-side (already filtered) in NuVizz mode.
      if (!nvWindow && statusSel.size && !statusSel.has(tableStatusBucket(s))) return false;
      if (driverSel && (s.driverName || '') !== driverSel) return false;
      if (needle) {
        const hay = [s.stopNbr, s.businessName, s.addr1, s.addr2, s.city, s.zip, s.routeName, s.loadNbr, s.driverName]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [baseStops, q, statusSel, driverSel, nvWindow]);
  // Pull the day's full load ROSTER (incl. empty loads) when the Loads view is open in
  // board mode — empty loads have no stops to group, so this is the only way to see them.
  useEffect(() => {
    if (view !== 'loads' || nvWindow || !boardDate) return;
    let cancelled = false;
    fetch('/.netlify/functions/nuvizz-loads-roster?date=' + encodeURIComponent(boardDate), { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setRoster(j.ok ? (j.loads || []) : []); })
      .catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  }, [view, nvWindow, boardDate]);

  // Loads view — group the same board (the `stops` we're handed) by loadNbr so
  // dispatchers can browse current loads instead of individual stops. Each row
  // aggregates driver, stop count, a per-status breakdown, and pallet/weight
  // totals. Click a row to open that load's route drawer + frame it on the map.
  // Empty loads (no orders assigned yet) are merged in from the roster below.
  const loadRows = useMemo(() => {
    const m = new Map();
    for (const s of loadSrc) {
      if (!s.loadNbr) continue; // only real (built) loads
      let g = m.get(s.loadNbr);
      if (!g) { g = { loadNbr: s.loadNbr, routeName: s.routeName || '', driverName: s.driverName || '', stops: [] }; m.set(s.loadNbr, g); }
      if (!g.routeName && s.routeName) g.routeName = s.routeName;
      if (!g.driverName && s.driverName) g.driverName = s.driverName;
      g.stops.push(s);
    }
    const needle = q.trim().toLowerCase();
    let arr = [...m.values()].map((g) => {
      const buckets = {};
      let pallets = 0, loose = 0, weight = 0;
      for (const s of g.stops) {
        const bk = tableStatusBucket(s); buckets[bk] = (buckets[bk] || 0) + 1;
        if (typeof s.cartons === 'number') pallets += s.cartons;
        if (typeof s.volume === 'number') loose += s.volume;
        if (s.weight != null) weight += Number(s.weight) || 0;
      }
      return { loadNbr: g.loadNbr, routeName: g.routeName, driverName: g.driverName, count: g.stops.length, buckets, pallets, loose, weight };
    });
    // Merge in EMPTY loads from the day's roster — loads created but with no orders assigned
    // yet have no stops to group, so they never appear from stop-grouping. Match by route
    // name to avoid duplicating loads we already built from stops.
    if (!nvWindow && roster.length) {
      const haveNames = new Set(arr.map((g) => String(g.routeName || '').trim().toLowerCase()).filter(Boolean));
      for (const r of roster) {
        const nm = String(r.name || '').trim();
        if (!nm || haveNames.has(nm.toLowerCase())) continue;
        arr.push({ loadNbr: r.loadId, routeName: nm, driverName: '', count: r.trips || 0, buckets: {}, pallets: 0, loose: 0, weight: 0, empty: true, rosterStatus: r.status });
      }
    }
    if (needle) arr = arr.filter((g) => [g.loadNbr, g.routeName, g.driverName].filter(Boolean).join(' ').toLowerCase().includes(needle));
    arr.sort((a, b) => String(a.driverName || '~').localeCompare(String(b.driverName || '~')) || String(a.routeName || a.loadNbr).localeCompare(String(b.routeName || b.loadNbr)));
    return arr;
  }, [loadSrc, q, roster, nvWindow]);
  const loadCols = [
    { k: 'load', label: 'Load', w: 150, get: (g) => <span className="font-mono text-blue-700">{g.routeName || g.loadNbr}</span>, sortVal: (g) => g.routeName || g.loadNbr },
    { k: 'driver', label: 'Driver', w: 180, get: (g) => g.driverName || '—', sortVal: (g) => g.driverName },
    { k: 'count', label: 'Stops', w: 60, align: 'right', get: (g) => g.count, sortVal: (g) => g.count },
    { k: 'status', label: 'Status', w: 210, get: (g) => (g.empty
        ? <span className="inline-flex items-center gap-1 px-1.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200" title={g.rosterStatus ? ('Load status: ' + g.rosterStatus) : 'No orders assigned yet'}>No orders yet{g.rosterStatus ? ' · ' + g.rosterStatus : ''}</span>
        : (
        <span className="inline-flex gap-1">
          {TABLE_STATUS_BUCKETS.map((b) => g.buckets[b.k]
            ? <span key={b.k} className={'px-1 rounded text-[10px] font-medium ' + (LOAD_BUCKET_STYLE[b.k] || '')} title={b.label}>{(LOAD_BUCKET_ABBR[b.k] || b.k)} {g.buckets[b.k]}</span>
            : null)}
        </span>
      )), sortVal: (g) => (g.empty ? -1 : (g.count ? (g.buckets.completed || 0) / g.count : 0)) /* % delivered; empty loads sort first */ },
    { k: 'pallets', label: 'Pallets', w: 70, align: 'right', get: (g) => g.pallets || '—', sortVal: (g) => g.pallets },
    { k: 'loose', label: 'Loose', w: 64, align: 'right', get: (g) => g.loose || '—', sortVal: (g) => g.loose },
    { k: 'weight', label: 'Weight', w: 90, align: 'right', get: (g) => g.weight ? Math.round(g.weight).toLocaleString() : '—', sortVal: (g) => g.weight },
  ];
  // Per-table column sort. null key = original order; click cycles asc → desc.
  // Stops and Loads keep independent sort so switching tabs preserves each.
  const [stopSort, setStopSort] = useState({ key: null, dir: 'asc' });
  const [loadSort, setLoadSort] = useState({ key: null, dir: 'asc' });
  const cycleSort = (setSort) => (k) => setSort((p) => (p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  const toggleStopSort = cycleSort(setStopSort);
  const toggleLoadSort = cycleSort(setLoadSort);
  const sortedRows = useMemo(() => sortRows(rows, cols, stopSort), [rows, stopSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortedLoadRows = useMemo(() => sortRows(loadRows, loadCols, loadSort), [loadRows, loadSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleStatus = (k) => setStatusSel((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <div className="absolute left-0 right-0 bottom-0 z-[12] bg-white border-t border-slate-200 shadow-[0_-2px_10px_rgba(0,0,0,0.10)] flex flex-col" style={{ height: open ? height : undefined }}>
      {open && (
        <div
          onPointerDown={onResizeDown}
          className="absolute -top-1.5 left-0 right-0 h-3 cursor-row-resize z-10 flex items-center justify-center group"
          title="Drag to resize"
          style={{ touchAction: 'none' }}
        >
          <div className="w-10 h-1 rounded-full bg-slate-300 group-hover:bg-slate-400" />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100">
        <button onClick={() => setOpen(!open)} className="inline-flex items-center text-slate-600 hover:text-slate-900" aria-expanded={open} title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs font-semibold whitespace-nowrap">
          <button
            onClick={() => { setView('stops'); setOpen(true); }}
            className={'inline-flex items-center gap-1.5 px-2.5 py-1 ' + (view === 'stops' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50')}
          >
            <LayoutList size={13} /> Stops
            <span className="font-normal opacity-60">{rows.length}{nvWindow ? (nvTotal && nvTotal !== rows.length ? `/${nvTotal.toLocaleString()}` : '') : (totalCount != null && totalCount !== rows.length ? `/${totalCount}` : '')}</span>
          </button>
          <button
            onClick={() => { setView('loads'); setOpen(true); }}
            className={'inline-flex items-center gap-1.5 px-2.5 py-1 border-l border-slate-200 ' + (view === 'loads' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50')}
          >
            <Truck size={13} /> Loads
            <span className="font-normal opacity-60">{loadRows.length}</span>
          </button>
        </div>
        {open && (
          <>
            <div className="relative flex-1 max-w-xs">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={view === 'loads' ? 'Search loads…' : 'Search table…'}
                className="w-full border border-slate-300 rounded pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
              />
            </div>
            {view === 'stops' && (
              <div className="relative">
                <button
                  onClick={() => setStatusOpen((v) => !v)}
                  className={'inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ' + (statusSel.size ? 'border-blue-400 text-blue-700 bg-blue-50' : 'border-slate-300 text-slate-600 hover:bg-slate-50')}
                >
                  <Filter size={12} /> Status{statusSel.size ? ` (${statusSel.size})` : ''}
                </button>
                {statusOpen && (
                  <div className="absolute right-0 bottom-full mb-1 w-40 bg-white border border-slate-200 rounded-lg shadow-lg z-20 p-1">
                    {TABLE_STATUS_BUCKETS.map((b) => (
                      <label key={b.k} className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-slate-50 rounded cursor-pointer">
                        <input type="checkbox" checked={statusSel.has(b.k)} onChange={() => toggleStatus(b.k)} className="rounded border-slate-300" />
                        {b.label}
                      </label>
                    ))}
                    {statusSel.size > 0 && (
                      <button onClick={() => setStatusSel(new Set())} className="w-full text-left px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 rounded border-t border-slate-100 mt-1">Clear</button>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* NuVizz live pull (desktop): delivery-date window + driver, on the same
                top row as search. Window = Board uses today's loaded data (no calls);
                a NuVizz window pulls the stop list straight from NuVizz. */}
            {view === 'stops' && (
              <>
                <select
                  value={nvWindow}
                  onChange={(e) => setNvWindow(e.target.value)}
                  title="Data source / delivery-date window"
                  className="hidden sm:inline-block border border-slate-300 rounded px-1.5 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
                >
                  <option value="">Board (today)</option>
                  <option value="0d">NuVizz · Today</option>
                  <option value="+/-7d">NuVizz · ±7 days</option>
                </select>
                <select
                  value={driverSel}
                  onChange={(e) => setDriverSel(e.target.value)}
                  title="Filter by driver"
                  className="hidden sm:inline-block border border-slate-300 rounded px-1.5 py-1 text-xs text-slate-700 max-w-[150px] focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
                >
                  <option value="">All drivers</option>
                  {driverOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                {nvWindow && (
                  <span className="hidden sm:inline text-[11px] text-slate-500 whitespace-nowrap">
                    {nvLoading
                      ? <span className="inline-flex items-center gap-1"><RefreshCw size={11} className="animate-spin" /> pulling…</span>
                      : nvErr
                        ? <span className="text-red-600">NuVizz: {nvErr}</span>
                        : <>NuVizz · {nvTotal.toLocaleString()} stops</>}
                  </span>
                )}
              </>
            )}
          </>
        )}
      </div>
      {open && view === 'stops' && (
        <div className="overflow-auto flex-1 min-h-0">
          <table className="text-[11px] border-collapse" style={{ minWidth: cols.reduce((a, c) => a + c.w, 0) }}>
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr>
                {cols.map((c) => (
                  <GridSortTh key={c.k} col={c} sort={stopSort} onToggle={toggleStopSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 && (
                <tr><td colSpan={cols.length} className="px-3 py-4 text-slate-400 italic text-center">No stops match.</td></tr>
              )}
              {sortedRows.map((s) => (
                <tr
                  key={s.stopNbr}
                  onClick={() => onPick(s)}
                  className={'cursor-pointer hover:bg-blue-50 ' + (s.carryover ? 'bg-amber-50/60' : '')}
                  title={s.carryover ? `Carry-over from ${s.scheduledDate}` : undefined}
                >
                  {cols.map((c) => (
                    <td key={c.k} className="px-2 py-1 border-b border-slate-100 whitespace-nowrap overflow-hidden text-ellipsis" style={{ maxWidth: c.w, textAlign: c.align || 'left' }}>{c.get(s)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && view === 'loads' && (
        <div className="overflow-auto flex-1 min-h-0">
          <table className="text-[11px] border-collapse" style={{ minWidth: loadCols.reduce((a, c) => a + c.w, 0) }}>
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr>
                {loadCols.map((c) => (
                  <GridSortTh key={c.k} col={c} sort={loadSort} onToggle={toggleLoadSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedLoadRows.length === 0 && (
                <tr><td colSpan={loadCols.length} className="px-3 py-4 text-slate-400 italic text-center">No loads on the current board.</td></tr>
              )}
              {sortedLoadRows.map((g) => (
                <tr
                  key={g.loadNbr}
                  onClick={() => onPickLoad && onPickLoad(g.loadNbr)}
                  className="cursor-pointer hover:bg-blue-50"
                >
                  {loadCols.map((c) => (
                    <td key={c.k} className="px-2 py-1 border-b border-slate-100 whitespace-nowrap overflow-hidden text-ellipsis" style={{ maxWidth: c.w, textAlign: c.align || 'left' }}>{c.get(g)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StopMiniTable({ stops, notes, onPick, columns, onColumnsChange, searchQuery = '', truncateNames = true }) {
  const cols = columns || DEFAULT_TABLE_COLUMNS;
  // Decorate rows with flag for sorting. _proSort puts empty PROs last for asc.
  const rows = useMemo(() => stops.map((s) => {
    const n = notes.get(s.matchKey);
    return {
      ...s,
      _flag: n?.priority_flag || 'none',
      _hasNote: !!n,
      _dnsNote: n?.do_not_send ? n : null,
      _priorityRank: n?.priority_flag === 'red' ? 0 : n?.priority_flag === 'yellow' ? 1 : n?.priority_flag === 'green' ? 2 : n?.priority_flag === 'question' ? 3 : 4,
      _proSort: s.primaryPro || s.pro || '￿',
    };
  }), [stops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'businessName', 'asc');
  // Horizontal scroll if columns exceed panel width.
  return (
    <div className="border-t">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-600">Stops ({rows.length})</div>
        {onColumnsChange && <ColumnsMenu columns={cols} onChange={onColumnsChange} />}
      </div>
      <div className="max-h-[40vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr>
              {cols.flag && <SortableTh label="Flag" k="_flag" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.customer && <SortableTh label="Customer" k="businessName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.city && <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.pro && <SortableTh label="PRO" k="_proSort" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.priority && <SortableTh label="Pri" k="_priorityRank" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.stopNbr} onClick={() => onPick(s)} className="cursor-pointer hover:bg-blue-50 border-t">
                {cols.flag && (
                  <td className="px-2 py-1">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s._flag !== 'none' ? FLAG_COLORS[s._flag] : (s._hasNote ? RESTRICTION_TINT : '#cbd5e1') }} />
                  </td>
                )}
                {cols.customer && (
                  <td
                    className={`px-2 py-1 ${truncateNames ? 'truncate max-w-[160px]' : ''}`}
                    title={s.businessName}
                    style={!truncateNames ? { maxWidth: 320 } : undefined}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className={truncateNames ? 'truncate' : ''}>{s.businessName}</span>
                      <DnsBadge note={s._dnsNote} />
                    </span>
                  </td>
                )}
                {cols.city && <td className="px-2 py-1 text-slate-600 whitespace-nowrap">{s.city}</td>}
                {cols.pro && (
                  <td className="px-2 py-1 font-mono text-[10px] text-slate-500 whitespace-nowrap">
                    {renderProCell(s, searchQuery)}
                  </td>
                )}
                {cols.priority && (
                  <td className="px-2 py-1 text-[10px] uppercase">
                    {s._flag !== 'none' ? (
                      <span style={{ color: FLAG_COLORS[s._flag] }} className="font-semibold">{s._flag.charAt(0)}</span>
                    ) : (s._hasNote ? <span className="text-purple-600 font-semibold">R</span> : <span className="text-slate-300">—</span>)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- M3 stub ----------

function DiagnosticsScreen({ stops, notes, ops, lastLoadScanAt, lastUnplannedScanAt, onRefresh, refreshing }) {
  const [scanning, setScanning] = useState(false);
  const scanNow = useCallback(async () => {
    setScanning(true);
    try {
      const r = await fetch(`${SCAN_NOW_URL}?manual=1`, { method: 'POST' });
      if (!r.ok && r.status !== 202) throw new Error('scan unavailable');
      // Background scan runs async — re-pull stats a couple times as results land.
      setTimeout(() => onRefresh?.(), 6000);
      setTimeout(() => onRefresh?.(), 16000);
    } catch { /* the stats refresh will reflect reality either way */ }
    finally { setTimeout(() => setScanning(false), 16000); }
  }, [onRefresh]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Diagnostics</h2>
        <p className="text-sm text-slate-600 mt-1">NuVizz API usage and the live scan schedule. Schedule edits apply to the running scanner.</p>
      </div>

      <ApiCallsPanel ops={ops} lastLoadScanAt={lastLoadScanAt} lastUnplannedScanAt={lastUnplannedScanAt} onRefresh={onRefresh} refreshing={refreshing} onScanNow={scanNow} scanning={scanning} />
      <SchedulePanel onScanNow={scanNow} scanning={scanning} onSaved={onRefresh} />

      <details className="group">
        <summary className="cursor-pointer text-xs font-semibold text-slate-400 hover:text-slate-600 select-none">Data-quality checks (M3, in progress)</summary>
        <div className="space-y-4 sm:space-y-6 mt-3">
      <Panel title="Unmatched Stops Today">
        {/*
          TODO (M3-A):
          Walk through `stops` and surface rows that have NO matching customer_notes doc
          (notes.get(stop.matchKey) is undefined). Render as a sortable table with
          columns: business, address, PRO, count-today. Add a "Create notes" button per
          row that pre-fills the sidebar form (lift selectedStop state up if needed).
          This is the dispatcher's daily "what's new?" view.
        */}
        <Placeholder count={stops.filter((s) => !notes.get(s.matchKey)).length} hint="unmatched today" />
      </Panel>

      <Panel title="Stale Customers (90+ days)">
        {/*
          TODO (M3-B):
          Iterate notes and filter where last_updated (Firestore Timestamp) is older
          than 90 days. Render sortable table: customer, last_updated date, days-since.
          Add a "Review" button that opens the customer in the editor even if they
          don't appear in today's stops. Need to handle the "not on today's map" case —
          maybe a separate compact editor modal that doesn't depend on a selected stop.
        */}
        <Placeholder count={0} hint="stale customers" />
      </Panel>

      <Panel title="Address Line 2 Migration">
        {/*
          TODO (M3-C):
          Group today's stops by addr2 (non-empty), then for each unique addr2 string
          show: text, list of business names that use it, "Promote to Notes" action.
          Promotion = create or update customer_notes for each customer with the
          appropriate field set (e.g. addr2 says "Liftgate" → set liftgate_required=true).
          This is the cleanup pass to drain Chad's addr2 dumping ground into structured fields.
          Heuristic ideas: regex for "liftgate", "appt", "no tractor", "26ft", "ground only".
        */}
        <Placeholder count={stops.filter((s) => (s.addr2 || '').trim()).length} hint="addr2 fields populated today" />
      </Panel>
        </div>
      </details>
    </div>
  );
}

function Panel({ title, action, children }) {
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Placeholder({ count, hint }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500 italic">
      <Activity size={16} />
      <span>{count} {hint} · not implemented (see TODO)</span>
    </div>
  );
}

// ============================================================================
// Diagnostics — NuVizz API-call analytics + live-editable scan schedule.
// Reads call volume from the pull endpoint (ops); reads/writes the schedule via
// /.netlify/functions/nuvizz-scan-config (persists to Firestore, scanner obeys it).
// ============================================================================
const SCAN_CONFIG_URL = '/.netlify/functions/nuvizz-scan-config';
const SCAN_NOW_URL = '/.netlify/functions/nuvizz-refresh-stops-background';

// Small pill badge with a few semantic tones.
function MiniBadge({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
    violet: 'bg-violet-100 text-violet-700',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone] || tones.slate}`}>{children}</span>;
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md bg-slate-50 border border-slate-100 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-800 tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

// 24-bar hourly call chart with axis ticks, peak marker, and per-bar tooltip.
function HourBarChart({ byHour }) {
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const vals = hours.map((h) => (byHour && byHour[h]) || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return <div className="text-sm text-slate-400 italic">No calls recorded yet today.</div>;
  const max = Math.max(...vals);
  const peak = vals.indexOf(max);
  return (
    <div>
      <div className="flex items-end gap-[3px] h-28" role="img" aria-label="NuVizz API calls per ET hour">
        {vals.map((v, h) => (
          <div key={h} className="flex-1 flex flex-col justify-end items-center group relative">
            <div
              className={`w-full rounded-t transition-colors ${v ? `${h === peak ? 'bg-violet-600' : 'bg-violet-400/70'} group-hover:bg-violet-700` : 'bg-slate-200'}`}
              style={{ height: `${v ? Math.max(3, Math.round((v / max) * 104)) : 2}px` }}
            />
            <div className="pointer-events-none absolute -top-7 hidden group-hover:block whitespace-nowrap rounded bg-slate-900 text-white text-[10px] px-1.5 py-0.5 z-10">
              {hours[h]}:00 · {v.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-400 mt-1">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
      <div className="text-[11px] text-slate-500 mt-1">Peak {hours[peak]}:00 ET · {max.toLocaleString()} calls · {total.toLocaleString()} total</div>
    </div>
  );
}

// Per-endpoint breakdown as labeled horizontal bars (sorted desc).
function RouteBars({ byRoute }) {
  const entries = Object.entries(byRoute || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="text-sm text-slate-400 italic">No per-endpoint data yet.</div>;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div className="space-y-1.5">
      {entries.map(([route, v]) => (
        <div key={route} className="flex items-center gap-2 text-xs">
          <div className="w-28 shrink-0 truncate text-slate-600 font-mono" title={route}>{route}</div>
          <div className="flex-1 bg-slate-100 rounded h-4 overflow-hidden">
            <div className="h-full bg-sky-400/80 rounded" style={{ width: `${Math.max(2, Math.round((v / max) * 100))}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right tabular-nums text-slate-700 font-semibold">{v.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

// Generic labeled horizontal-bar breakdown (by app / by trigger), sorted desc. Same
// shape as RouteBars but with a configurable bar color and a wider label column so
// "scheduled-scan" / "dispatch-map" read cleanly.
function LabelBars({ data, color = 'bg-violet-400/80' }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="text-sm text-slate-400 italic">No data yet.</div>;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div className="space-y-1.5">
      {entries.map(([label, v]) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <div className="w-32 shrink-0 truncate text-slate-600" title={label}>{label}</div>
          <div className="flex-1 bg-slate-100 rounded h-4 overflow-hidden">
            <div className={`h-full ${color} rounded`} style={{ width: `${Math.max(2, Math.round((v / max) * 100))}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right tabular-nums text-slate-700 font-semibold">{v.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function ApiCallsPanel({ ops, lastLoadScanAt, lastUnplannedScanAt, onRefresh, refreshing, onScanNow, scanning }) {
  const headerBtns = (
    <div className="flex items-center gap-2">
      <button onClick={onScanNow} disabled={scanning}
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> Scan now
      </button>
      <button onClick={onRefresh} disabled={refreshing} aria-label="Refresh stats"
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
      </button>
    </div>
  );
  if (!ops) {
    return (
      <Panel title="NuVizz API Calls (today)" action={headerBtns}>
        <div className="text-sm text-slate-400 italic">No call data available (Firestore off, or no scans yet today).</div>
      </Panel>
    );
  }
  const used = ops.dayCount || 0;
  const ceiling = ops.ceiling || 0;
  const pct = ceiling ? Math.min(100, Math.round((used / ceiling) * 100)) : 0;
  const tone = pct >= 85 ? 'red' : pct >= 60 ? 'amber' : 'green';
  const barColor = pct >= 85 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500';
  const learn = ops.scanLearning || {};
  return (
    <Panel title="NuVizz API Calls (today)" action={headerBtns}>
      <div className="space-y-4">
        <div>
          <div className="flex items-end justify-between mb-1 flex-wrap gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900 tabular-nums">{used.toLocaleString()}</span>
              <span className="text-sm text-slate-500">/ {ceiling.toLocaleString()} calls</span>
            </div>
            <div className="flex items-center gap-1.5">
              <MiniBadge tone={ops.mode === 'enforce' ? 'violet' : 'slate'}><Gauge size={11} /> {ops.mode}</MiniBadge>
              {ops.breaker
                ? <MiniBadge tone="red"><Ban size={11} /> halted</MiniBadge>
                : <MiniBadge tone={tone}>{pct}% of cap</MiniBadge>}
            </div>
          </div>
          <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1"><Clock size={12} /> Calls by hour (ET)</div>
          <HourBarChart byHour={ops.byHour} />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">By endpoint</div>
          <RouteBars byRoute={ops.byRoute} />
        </div>

        {ops.byTrigger && Object.keys(ops.byTrigger).length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">By trigger (why)</div>
            <LabelBars data={ops.byTrigger} color="bg-violet-400/80" />
          </div>
        )}

        {ops.byApp && Object.keys(ops.byApp).length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">By app</div>
            <LabelBars data={ops.byApp} color="bg-emerald-400/80" />
          </div>
        )}

        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Scanner learning</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Stat label="Recent scans" value={learn.scans ?? '—'} />
            <Stat label="Loads found / scan" value={learn.lastFoundLoads ?? '—'} />
            <Stat label="Max ID gap" value={learn.maxGap ?? '—'} />
            <Stat label="Rec. empty-stop" value={learn.recommendedEmptyStop ?? '—'} />
            <Stat label="New loads/day (max)" value={learn.maxNewLoads ?? '—'} />
            <Stat label="Missed scans" value={learn.missedScans ?? '—'} />
          </div>
        </div>

        <div className="text-[11px] text-slate-400 flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t">
          <span title={fmtAbsoluteET(lastLoadScanAt)}>Loads scanned {fmtFeedAge(lastLoadScanAt) || '—'}</span>
          <span title={fmtAbsoluteET(lastUnplannedScanAt)}>Orders scanned {fmtFeedAge(lastUnplannedScanAt) || '—'}</span>
        </div>
      </div>
    </Panel>
  );
}

// One numeric field bound to the schedule form, with bounds + default hint and an
// "edited" highlight when the value differs from the site default.
function NumberField({ label, hint, value, def, bound, unit, onChange }) {
  const [lo, hi] = bound || [0, 9999];
  const overridden = def != null && Number(value) !== Number(def);
  return (
    <label className="block">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">{label}</span>
        {overridden && <span className="text-[10px] text-violet-600 font-semibold">edited</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="number" min={lo} max={hi} value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className={`w-full rounded-md border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-sky-300 ${overridden ? 'border-violet-300 bg-violet-50/40' : 'border-slate-300'}`}
        />
        {unit && <span className="text-xs text-slate-400 shrink-0">{unit}</span>}
      </div>
      {hint && <div className="text-[10px] text-slate-400 mt-0.5">{hint}{def != null ? ` · default ${def}` : ''}</div>}
    </label>
  );
}

function SwitchToggle({ checked, onChange, label, hint }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2">
      <div>
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
      </div>
      <button
        role="switch" aria-checked={checked} aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function SchedSection({ icon, title, desc, children }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-1">{icon} {title}</div>
      {desc && <div className="text-[11px] text-slate-400 mt-0.5 mb-2">{desc}</div>}
      {children}
    </div>
  );
}

// Rough daily-scan-count estimate from the cadence form, so the cost impact of an
// edit is visible before saving.
function EstimateLine({ form }) {
  const dayStart = Number(form.dayBandStartHour), dayEnd = Number(form.dayBandEndHour);
  const dayHours = Math.max(0, dayEnd - dayStart);
  const nightHours = Math.max(0, 24 - dayHours);
  const dayScans = Number(form.intervalDayMin) > 0 ? (dayHours * 60) / Number(form.intervalDayMin) : 0;
  const nightScans = Number(form.intervalNightMin) > 0 ? (nightHours * 60) / Number(form.intervalNightMin) : 0;
  const total = Math.round(dayScans + nightScans);
  if (!Number.isFinite(total) || total <= 0) return null;
  return <div className="text-[11px] text-slate-500 mt-2">≈ <span className="font-semibold">{total}</span> scans/day at this cadence (weekday, outside blackout).</div>;
}

function SchedulePanel({ onScanNow, scanning, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState('loading'); // loading|ready|saving|saved|error
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading'); setErr(null);
    try {
      const r = await fetch(SCAN_CONFIG_URL, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setData(j); setForm({ ...j.config }); setStatus('ready');
    } catch (e) { setErr(e.message); setStatus('error'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (status === 'loading' || !form) {
    return <Panel title="Scan Schedule"><div className="text-sm text-slate-400 italic flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading schedule…</div></Panel>;
  }
  if (status === 'error' && !data) {
    return <Panel title="Scan Schedule"><div className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={14} /> Couldn't load schedule: {err}</div></Panel>;
  }

  const { defaults, bounds, persistent, stored } = data;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(data.config);

  const save = async (override) => {
    setStatus('saving'); setErr(null);
    try {
      const payload = override || form;
      const r = await fetch(SCAN_CONFIG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setData(j); setForm({ ...j.config }); setStatus('saved');
      onSaved?.(); // refetch the top API-calls panel so a changed ceiling shows immediately
      setTimeout(() => setStatus('ready'), 2500);
    } catch (e) { setErr(e.message); setStatus('error'); }
  };
  const resetDefaults = () => { setForm({ ...defaults }); save({ ...defaults }); };

  const action = (
    <div className="flex items-center gap-2">
      {!persistent && <MiniBadge tone="amber"><AlertTriangle size={11} /> read-only</MiniBadge>}
      {status === 'saved' && <MiniBadge tone="green">saved</MiniBadge>}
      <button onClick={onScanNow} disabled={scanning}
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> Scan now
      </button>
    </div>
  );

  return (
    <Panel title="Scan Schedule" action={action}>
      <div className="space-y-5">
        <SwitchToggle
          label="Scheduled scans enabled"
          hint="Master switch — off pauses automatic scanning (Scan now still works)."
          checked={form.scansEnabled !== false}
          onChange={set('scansEnabled')}
        />

        <SchedSection icon={<Clock size={12} />} title="Cadence" desc="How often the scanner runs, by ET time of day.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumberField label="Day interval" hint="between scans, day band" unit="min" value={form.intervalDayMin} def={defaults.intervalDayMin} bound={bounds.intervalDayMin} onChange={set('intervalDayMin')} />
            <NumberField label="Night interval" hint="between scans, overnight" unit="min" value={form.intervalNightMin} def={defaults.intervalNightMin} bound={bounds.intervalNightMin} onChange={set('intervalNightMin')} />
            <NumberField label="Day band start" hint="ET hour faster cadence begins" unit="h ET" value={form.dayBandStartHour} def={defaults.dayBandStartHour} bound={bounds.dayBandStartHour} onChange={set('dayBandStartHour')} />
            <NumberField label="Day band end" hint="ET hour it ends (exclusive)" unit="h ET" value={form.dayBandEndHour} def={defaults.dayBandEndHour} bound={bounds.dayBandEndHour} onChange={set('dayBandEndHour')} />
          </div>
          <EstimateLine form={form} />
        </SchedSection>

        <SchedSection icon={<Gauge size={12} />} title="Spend cap" desc="Daily NuVizz call ceiling — the breaker threshold and the gauge up top.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumberField label="Daily ceiling" hint="max calls per day" unit="calls" value={form.dailyCeiling} def={defaults.dailyCeiling} bound={bounds.dailyCeiling} onChange={set('dailyCeiling')} />
          </div>
        </SchedSection>

        <SchedSection icon={<Clock size={12} />} title="Deep sweep" desc="The once-a-day full reconciliation, held off the 10am open to avoid a spike.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumberField label="Min hours between" hint="how often a full sweep may run" unit="h" value={form.deepSweepHours} def={defaults.deepSweepHours} bound={bounds.deepSweepHours} onChange={set('deepSweepHours')} />
            <NumberField label="Earliest hour" hint="off-peak ET hour it's allowed" unit="h ET" value={form.deepSweepHour} def={defaults.deepSweepHour} bound={bounds.deepSweepHour} onChange={set('deepSweepHour')} />
          </div>
        </SchedSection>

        <SchedSection icon={<Settings size={12} />} title="Windows" desc="Overnight routing window (thorough vs lean discovery) and the weekend blackout.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumberField label="Routing window start" hint="overnight window opens" unit="h ET" value={form.routingWindowStart} def={defaults.routingWindowStart} bound={bounds.routingWindowStart} onChange={set('routingWindowStart')} />
            <NumberField label="Routing window end" hint="window closes (wraps midnight)" unit="h ET" value={form.routingWindowEnd} def={defaults.routingWindowEnd} bound={bounds.routingWindowEnd} onChange={set('routingWindowEnd')} />
            <NumberField label="Weekend blackout start" hint="Friday scans stop" unit="h ET" value={form.weekendBlackoutStart} def={defaults.weekendBlackoutStart} bound={bounds.weekendBlackoutStart} onChange={set('weekendBlackoutStart')} />
            <NumberField label="Weekend blackout end" hint="Sunday scans resume" unit="h ET" value={form.weekendBlackoutEnd} def={defaults.weekendBlackoutEnd} bound={bounds.weekendBlackoutEnd} onChange={set('weekendBlackoutEnd')} />
          </div>
        </SchedSection>

        {err && <div className="text-sm text-red-600 flex items-center gap-1"><AlertTriangle size={14} /> {err}</div>}

        <div className="flex items-center justify-between gap-2 pt-1 border-t">
          <button onClick={resetDefaults} disabled={!persistent || status === 'saving'}
            className="text-xs text-slate-500 hover:text-slate-700 underline disabled:opacity-50">Reset to defaults</button>
          <div className="flex items-center gap-2">
            {stored?.updatedAt && <span className="text-[10px] text-slate-400">edited {fmtFeedAge(stored.updatedAt) || ''}</span>}
            <button onClick={() => save()} disabled={!persistent || !dirty || status === 'saving'}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed">
              <Save size={14} /> {status === 'saving' ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">Saved changes take effect on the next scheduled scan (~15 min). Out-of-range values are clamped to safe limits automatically.</p>
      </div>
    </Panel>
  );
}

// ============================================================================
// Phase 2 (PR 2/2) — Routing (beta) tab. Inline per the single-file rule.
// CHEAP BY DEFAULT (Appendix B): builds run free haversine unless the dispatcher
// explicitly opts into Google live drive-times, and the per-build cost is shown.
// Wires to the merged engine via the routing_jobs job-doc lifecycle; renders
// exactly what the engine returns (no client-side feasibility/sequencing).
// ============================================================================

// Feature flag — Chad turned the Routing (beta) tab ON for all dispatchers
// (v0.14.2). It is now VISIBLE BY DEFAULT. A kill switch remains so it can be
// hidden again without a revert: set env VITE_ROUTING_BETA='false', or append
// ?routing=0 to the URL. Cheap-by-default still holds (free estimate unless the
// Google toggle is used), so exposing it carries no automatic cost.
const ROUTING_FLAG = (() => {
  try {
    if (import.meta.env.VITE_ROUTING_BETA === 'false') return false;
    if (typeof window !== 'undefined' && /[?&]routing=0\b/.test(window.location.search)) return false;
  } catch { /* ignore */ }
  return true;
})();

const ROUTING_DEPOT = { name: 'Buford Terminal', lat: 34.14838, lng: -83.95948 };
const ROUTING_STRATEGIES = [
  ['MIN_DISTANCE', 'Min distance'],
  ['MIN_TIME', 'Min time'],
  ['CLOSEST_FIRST', 'Closest first'],
  ['FARTHEST_FIRST', 'Farthest first'],
];
const ROUTING_MAX_SELECTION = 150; // matrix cost is quadratic (Appendix B)
const BASIC_RATE_PER_1K_USD = 5.0; // mirror of routing-types BASIC_MATRIX_RATE (display only)

// Client-side mirror of the server seed profiles (truck-profiles.mts). Used only
// to seed the truck_profiles collection on first run; the server remains the
// source of truth for a build (it reads truck_profiles by id).
const CLIENT_DEFAULT_TRUCKS = [
  { id: 'box_26', label: '26ft Box', truckClass: 'BOX_26', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, deckWidthIn: 96, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true }, active: true },
  { id: 'tractor_53', label: '53ft Trailer', truckClass: 'TRACTOR_53', maxSkids: 28, maxWeightLbs: 44000, deckLengthIn: 636, deckWidthIn: 100, capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true }, active: true },
];

// ETAs are epoch-seconds anchored to the planning clock (date + depart in UTC),
// so format in UTC to show the intended wall-clock time (e.g. 8:00 AM depart).
function formatRoutingEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  return new Date(sec * 1000).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
}

// A selected stop "looks oversize" for the live tally if any line item is NuVizz
// category L. (The authoritative geometry is computed server-side at build time.)
function stopLooksOversize(s) {
  return Array.isArray(s?.stopDetails) && s.stopDetails.some((d) => String(d?.productCategory || '').toUpperCase() === 'L');
}

// Live truck_profiles, seeded on first run. Returns profiles + a persist helper.
function useTruckProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!db) { setReady(true); return; }
    const unsub = onSnapshot(collection(db, 'truck_profiles'), async (snap) => {
      if (snap.empty) {
        // Seed defaults once; the snapshot will re-fire with them.
        try { await Promise.all(CLIENT_DEFAULT_TRUCKS.map((p) => setDoc(doc(db, 'truck_profiles', p.id), p))); } catch { /* ignore */ }
        return;
      }
      setProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setReady(true);
    }, () => setReady(true));
    return () => unsub();
  }, []);
  const saveProfile = useCallback(async (p) => {
    if (!db) return;
    await setDoc(doc(db, 'truck_profiles', p.id), p, { merge: true });
  }, []);
  return { profiles, ready, saveProfile };
}

// Shared, live-synced saved loads. Subscribes to routing_routes (created_at desc)
// so a save/rename/delete/dispatch on ANY device shows here within seconds, no
// refresh. Clean teardown on unmount. Surfaces loading + error explicitly (never
// a silent catch). Each load carries its own `result` (the saved plan).
function useSavedLoads() {
  const [loads, setLoads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!db) { setLoading(false); setError('Firestore not configured'); return; }
    let active = true;
    const q = query(collection(db, 'routing_routes'), orderBy('created_at', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      if (!active) return;
      setLoads(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
      setError(null);
    }, (err) => {
      if (!active) return;
      console.error('routing_routes snapshot error', err);
      setError(err?.message || 'failed to load saved loads');
      setLoading(false);
    });
    return () => { active = false; unsub(); };
  }, []);
  return { loads, loading, error };
}

// Load-vs-capacity bar (one dimension). Amber ≥90%, red >100% (shouldn't happen).
function CapacityBar({ label, used, cap, unit }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const over = used > cap;
  const tight = !over && used > cap * 0.9;
  const color = over ? '#dc2626' : tight ? '#f59e0b' : '#16a34a';
  return (
    <div className="text-[11px]">
      <div className="flex justify-between text-slate-600">
        <span>{label}</span>
        <span>{Math.round(used).toLocaleString()} / {Math.round(cap).toLocaleString()} {unit}</span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded overflow-hidden">
        <div style={{ width: `${pct}%`, background: color }} className="h-full" />
      </div>
    </div>
  );
}

// Drill-in detail for one selected stop. Reuses the parent app's customer_notes
// helpers (getRestrictionBadgeKeys / RESTRICTION_ICONS / formatReceivingHours)
// so a routing stop shows the SAME intelligence as the map markers, plus the
// per-line products from stopDetails[]. Degrades cleanly: a stop with no note
// shows no false flags, and an empty stopDetails[] shows "No line items".
// A stop's PRO / order number as a clickable link that opens the detail popup.
// Falls back to plain text when there's no opener (e.g. inside the popup itself)
// or no number. Never a dead link.
function ProLink({ stop, onOpen, className = '' }) {
  const pro = stop?.pro || stop?.stopNbr || stop?.primaryPro || null;
  if (!pro) return null;
  if (!onOpen) return <span className={className}>#{pro}</span>;
  return (
    <button onClick={(e) => { e.stopPropagation(); onOpen(stop); }} className={`text-blue-700 underline hover:text-blue-900 ${className}`} title="Open stop details">#{pro}</button>
  );
}

// Appointment window label from a stop's scheduled times, e.g. "8:00a–8:05a".
function apptWindowLabel(stop) {
  const from = stop?.scheduledFrom, to = stop?.scheduledTo;
  if (!from && !to) return null;
  return `${from ? fmtTime12(from) : '?'}–${to ? fmtTime12(to) : '?'}`;
}

function RoutingStopDetail({ stop, note, onOpen, windowViolated }) {
  const keys = getRestrictionBadgeKeys(note);
  const oversize = stopLooksOversize(stop);
  const hoursStr = formatReceivingHours(note);
  const lines = Array.isArray(stop.stopDetails) ? stop.stopDetails : [];
  const addr = [stop.addr1, [stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' · ');
  const contact = (stop.contact && (stop.contact.name || stop.contact.phone)) ? stop.contact
    : (note?.contacts && note.contacts[0]) || null;
  const Cap = ({ children }) => <div className="text-[9px] uppercase font-semibold text-slate-500 tracking-wide">{children}</div>;
  const pro = stop.pro || stop.stopNbr || stop.primaryPro || null;
  return (
    <div className="rounded bg-slate-50 border border-slate-200 p-2 space-y-1.5 text-[11px]">
      <div className="flex gap-6 flex-wrap">
        <div><Cap>Order / PRO</Cap><div className="text-slate-800"><ProLink stop={stop} onOpen={onOpen} className="font-medium" /> {!pro && '—'}</div></div>
        {stop.loadNbr && <div><Cap>Load</Cap><div className="text-slate-800">{stop.loadNbr}</div></div>}
        {stop.bol && <div><Cap>BOL</Cap><div className="text-slate-800">{stop.bol}</div></div>}
        {stop.customerAccount && <div><Cap>Account</Cap><div className="text-slate-800">{stop.customerAccount}</div></div>}
      </div>
      <div><Cap>Business</Cap><div className="text-slate-800 font-medium">{stop.businessName || '—'}</div></div>
      <div><Cap>Address</Cap><div className="text-slate-800">{addr || '—'}</div></div>
      {contact && (
        <div><Cap>Contact</Cap><div className="text-slate-800">{[contact.name, contact.phone].filter(Boolean).join(' · ') || '—'}</div></div>
      )}
      <div className="flex gap-6 flex-wrap">
        <div><Cap>Skids</Cap><div className="text-slate-800">{Number(stop.cartons) || 0}</div></div>
        <div><Cap>Loose pcs</Cap><div className="text-slate-800">{Number(stop.volume) || 0}</div></div>
        <div><Cap>Total pcs</Cap><div className="text-slate-800">{Number(stop.pallets) || 0}</div></div>
        <div><Cap>Weight</Cap><div className="text-slate-800">{(Number(stop.weight) || 0).toLocaleString()} lb</div></div>
      </div>
      {(keys.length > 0 || oversize) && (
        <div>
          <Cap>Restrictions</Cap>
          <ul className="mt-0.5">
            {keys.map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5 mr-2 mb-0.5 align-middle">
                <RestrictionIcon kind={k} size={14} /><span>{RESTRICTION_ICONS[k]?.label || k}</span>
              </li>
            ))}
            {oversize && (
              <li className="inline-flex items-center gap-1.5 mr-2 mb-0.5 align-middle">
                <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1">OS</span><span>Oversize freight</span>
              </li>
            )}
          </ul>
        </div>
      )}
      {note?.appointment_required && (
        <div><Cap>Appointment</Cap><div className="text-slate-800">Required{note.appointment_notes ? ` — ${note.appointment_notes}` : ''}</div></div>
      )}
      {(apptWindowLabel(stop) || windowViolated) && (
        <div>
          <Cap>Appointment window</Cap>
          <div className="text-slate-800">
            {apptWindowLabel(stop) || '—'}{String(stop.timeConstraint || '').toUpperCase() === 'STRICT' ? ' (strict)' : ''}
            {windowViolated && <span className="ml-1 text-amber-700 font-semibold">⚠ outside appointment window</span>}
          </div>
        </div>
      )}
      {hoursStr && <div><Cap>Receiving hours</Cap><div className="text-slate-800">{hoursStr}</div></div>}
      <div>
        <Cap>Products / line items</Cap>
        {lines.length === 0 ? (
          <div className="text-slate-400 italic">No line items</div>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {lines.map((d, i) => {
              const name = d.product || d.sku || 'Item';
              const sku = d.sku && d.product ? ` (${d.sku})` : '';
              const qty = d.quantity != null ? `${d.quantity}${d.quantityUOM ? ` ${d.quantityUOM}` : ''}` : null;
              const wt = d.weight != null ? `${Number(d.weight).toLocaleString()}${d.weightUOM ? ` ${d.weightUOM}` : ''}` : null;
              const dims = lineItemDims(d);
              const meta = [qty, wt, dims].filter(Boolean).join(' · ');
              return (
                <li key={i} className="text-slate-800">
                  {name}{sku}{String(d.productCategory || '').toUpperCase() === 'L' && <span className="ml-1 text-[9px] font-bold text-amber-700">·OS</span>}
                  {meta && <span className="text-slate-500"> — {meta}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// Full-detail popup for a stop, opened from any PRO/order-number link. Body reuses
// RoutingStopDetail (the single detail view). Closes via X, backdrop, or Esc.
// Never opens empty — guards a null stop.
function RoutingStopModal({ stop, notes, onClose, windowViolatedSet }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!stop) return null;
  const note = notes?.get?.(stop.matchKey) || null;
  const pro = stop.pro || stop.stopNbr || stop.primaryPro || '';
  const windowViolated = !!(windowViolatedSet && windowViolatedSet.has(String(stop.stopNbr || stop.pro)));
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md max-h-[85dvh] flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <div className="min-w-0">
            <div className="font-bold text-slate-800 truncate">{stop.businessName || `Stop ${pro}`}</div>
            {pro && <div className="text-[11px] text-slate-500">Order / PRO #{pro}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-1 shrink-0">×</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <RoutingStopDetail stop={stop} note={note} windowViolated={windowViolated} />
        </div>
      </div>
    </div>
  );
}

// The selected-stops list — the source of truth for "what is actually selected".
// Mobile: collapsed by default, tap the header to expand. Desktop: persistent
// (parent opens it by default). Each row taps open an inline detail accordion;
// the × removes the stop from the selection (two-way sync via onRemove). Columns
// are sortable via the shared useSortable hook.
function RoutingSelectedList({ selectedStops, notes, onRemove, open, setOpen, onOpenStop }) {
  const [detailId, setDetailId] = useState(null);
  const rows = useMemo(() => selectedStops.map((s) => {
    const note = notes.get(s.matchKey) || null;
    return {
      id: String(s.stopNbr), stop: s, note,
      keys: getRestrictionBadgeKeys(note),
      oversize: stopLooksOversize(s),
      customer: s.businessName || String(s.stopNbr),
      city: s.city || '',
      skids: Number(s.cartons) || 0,         // NuVizz totalCartons = real skids
      loose: Number(s.volume) || 0,          // NuVizz volume = loose pieces
      pieces: Number(s.pallets) || 0,        // NuVizz totalPallets = total pieces
      weight: Number(s.weight) || 0,
    };
  }), [selectedStops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'customer', 'asc');
  const SortBtn = ({ label, k }) => (
    <button onClick={() => toggle(k)} className="inline-flex items-center gap-0.5 hover:text-slate-700">
      {label}{sortKey === k ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}
    </button>
  );
  return (
    <div className="border rounded">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-2 py-1.5 text-[12px] font-semibold text-slate-700">
        <span>Selected stops ({rows.length})</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (rows.length === 0 ? (
        <div className="px-2 pb-2 text-[11px] text-slate-400">No stops selected yet. Tap a stop on the map, or use Add in view / Box / Lasso.</div>
      ) : (
        <div className="border-t">
          <div className="flex items-center gap-3 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b bg-slate-50">
            <SortBtn label="Customer" k="customer" /><SortBtn label="City" k="city" /><SortBtn label="Skids" k="skids" /><SortBtn label="Loose" k="loose" /><SortBtn label="Pcs" k="pieces" /><SortBtn label="Wt" k="weight" />
          </div>
          <div className="max-h-[42vh] overflow-y-auto divide-y">
            {sorted.map((r) => (
              <div key={r.id}>
                <div className="flex items-start gap-2 px-2 py-1.5">
                  <button onClick={() => setDetailId((d) => (d === r.id ? null : r.id))} className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate">{r.customer}</span>
                      {detailId === r.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{[r.city, `${r.skids} skid${r.skids === 1 ? '' : 's'}`, `${r.loose} loose`, `${r.pieces} pc${r.pieces === 1 ? '' : 's'}`, `${r.weight.toLocaleString()} lb`].filter(Boolean).join(' · ')}</div>
                    {(r.keys.length > 0 || r.oversize) && (
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {r.keys.map((k) => <RestrictionIcon key={k} kind={k} size={14} />)}
                        {r.oversize && <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1" title="Oversize freight">OS</span>}
                      </div>
                    )}
                  </button>
                  <span className="text-[11px] shrink-0"><ProLink stop={r.stop} onOpen={onOpenStop} /></span>
                  <button onClick={() => onRemove(r.id)} aria-label={`Remove ${r.customer} from selection`} className="text-slate-400 hover:text-red-600 px-1 leading-none text-lg shrink-0">×</button>
                </div>
                {detailId === r.id && <div className="px-2 pb-2"><RoutingStopDetail stop={r.stop} note={r.note} onOpen={onOpenStop} /></div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Desktop right-rail variant of the selected-stops list: a full, always-visible
// sortable table with live map<->list hover linkage (hovering a row emphasizes
// its marker and vice-versa via the shared hoverId), a per-row remove, and a
// docked detail panel below the table. Reuses RoutingStopDetail + the same
// customer_notes / stopDetails helpers. The selection is the single source of
// truth (rows derive from selectedStops; remove flows back through onRemove).
function RoutingStopsPanel({ selectedStops, notes, onRemove, hoverId, setHoverId, onOpenStop }) {
  const [detailId, setDetailId] = useState(null);
  const rowRefs = useRef(new Map());
  const rows = useMemo(() => selectedStops.map((s) => {
    const note = notes.get(s.matchKey) || null;
    return {
      id: String(s.stopNbr), stop: s, note,
      keys: getRestrictionBadgeKeys(note), oversize: stopLooksOversize(s),
      customer: s.businessName || String(s.stopNbr), city: s.city || '',
      skids: Number(s.cartons) || 0, loose: Number(s.volume) || 0, pieces: Number(s.pallets) || 0, weight: Number(s.weight) || 0,
    };
  }), [selectedStops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'customer', 'asc');
  // Keep the hovered row visible. block:'nearest' is a no-op when the row is
  // already on screen (pointer hover), so this only scrolls for map-driven hover.
  useEffect(() => {
    if (hoverId) rowRefs.current.get(hoverId)?.scrollIntoView({ block: 'nearest' });
  }, [hoverId]);
  // The active detail stop may have been removed from the selection.
  const detailRow = rows.find((r) => r.id === detailId) || null;

  if (rows.length === 0) {
    return <div className="p-4 text-[12px] text-slate-400">No stops selected yet. Click a stop on the map, drag a box, lasso, or use “Add stops in view”.</div>;
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 sticky top-0 z-10">
            <tr>
              <SortableTh label="Customer" k="customer" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Skids" k="skids" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Loose" k="loose" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Pcs" k="pieces" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Wt" k="weight" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <th className="px-1" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const active = detailId === r.id, hot = hoverId === r.id;
              return (
                <tr
                  key={r.id}
                  ref={(el) => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }}
                  onMouseEnter={() => setHoverId(r.id)}
                  onMouseLeave={() => setHoverId((h) => (h === r.id ? null : h))}
                  onClick={() => setDetailId((d) => (d === r.id ? null : r.id))}
                  className={`border-t cursor-pointer ${active ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : hot ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-2 py-1.5 max-w-[180px]">
                    <div className="truncate font-medium" title={r.customer}>{r.customer}</div>
                    {(r.keys.length > 0 || r.oversize) && (
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {r.keys.map((k) => <RestrictionIcon key={k} kind={k} size={13} />)}
                        {r.oversize && <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1" title="Oversize freight">OS</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 max-w-[110px] truncate" title={r.city}>{r.city}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.skids}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.loose}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.pieces}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.weight.toLocaleString()}</td>
                  <td className="px-1 py-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <ProLink stop={r.stop} onOpen={onOpenStop} className="text-[11px] mr-1" />
                    <button onClick={(e) => { e.stopPropagation(); onRemove(r.id); }} aria-label={`Remove ${r.customer} from selection`} className="text-slate-400 hover:text-red-600 leading-none text-lg">×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detailRow && (
        <div className="shrink-0 border-t bg-white max-h-[42%] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-slate-50">
            <div className="font-semibold text-[13px] truncate">{detailRow.customer}</div>
            <button onClick={() => setDetailId(null)} className="text-slate-400 hover:text-slate-700 text-lg leading-none" aria-label="Close detail">×</button>
          </div>
          <div className="p-3"><RoutingStopDetail stop={detailRow.stop} note={detailRow.note} onOpen={onOpenStop} /></div>
        </div>
      )}
    </div>
  );
}

// Persistent build badge for the Routing surface (the map-view chip + desktop
// footer don't reach here). Sits in the map's top-right corner — visible on every
// routing tab (Stops/Loads/Result) at both widths since the map is always shown.
// pointer-events-none so it never blocks map drag/selection. Shows app version +
// short commit + deploy context; degrades to "local · dev" with no Netlify env.
function RoutingBuildBadge({ onClick }) {
  const built = BUILD_TIME ? ` · built ${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : '';
  return (
    <button
      onClick={onClick}
      className="absolute top-2 right-2 z-20 select-none bg-white/85 hover:bg-white border border-slate-200 rounded px-1.5 py-0.5 text-[10px] leading-none text-slate-500 shadow-sm"
      title={`Dispatch Map v${APP_VERSION} · ${BUILD_SHORT} · ${BUILD_CONTEXT}${built} — tap for version history`}
    >
      v{APP_VERSION} · {BUILD_SHORT} · {BUILD_CONTEXT}
    </button>
  );
}

// Beta version history popup (opened from the build badge).
function VersionLogModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm max-h-[85dvh] flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/davis-logo.jpg" alt="Davis Delivery Service" className="h-7 w-auto" />
            <div className="font-bold text-slate-800 border-l border-slate-200 pl-2">Version history</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-1">×</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          <div className="px-1 pb-2 text-[10px] text-slate-400">Build {BUILD_SHORT} · {BUILD_CONTEXT}</div>
          <ul className="divide-y">
            {VERSION_LOG.map(([v, note]) => {
              const current = v === APP_VERSION;
              return (
                <li key={v} className={`flex gap-2 px-1 py-1.5 text-[12px] ${current ? 'bg-emerald-50 rounded' : ''}`}>
                  <span className="font-bold tabular-nums shrink-0" style={{ color: current ? '#16a34a' : '#334155' }}>v{v}</span>
                  <span className="text-slate-600">{note}{current ? ' — current' : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function RoutingScreen() {
  const [selectedDate, setSelectedDate] = useState(() => todayInET());
  const { stops, loading, error: stopsError } = useStops(selectedDate);
  const { notes } = useCustomerNotes();
  const { profiles, saveProfile } = useTruckProfiles();
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const polylinesRef = useRef([]);
  const [mapReady, setMapReady] = useState(0);

  // Touch-native selection. No DrawingManager (its drag-to-draw never worked on
  // a phone and its async load could silently no-op): Box = tap two corners,
  // Lasso = tap vertices then Done — both driven by plain map click listeners,
  // so every tool works identically on touch and mouse. Refs hold the in-flight
  // geometry + preview overlays; state drives the prompts.
  const [selectMode, setSelectMode] = useState(null);   // null | 'box' | 'lasso'
  const [boxStep, setBoxStep] = useState(0);             // corners placed so far
  const [lassoCount, setLassoCount] = useState(0);       // vertices placed so far
  const [lastAction, setLastAction] = useState(null);    // visible "N added" feedback
  const selectModeRef = useRef(null);
  const boxCornersRef = useRef([]);
  const lassoVtxRef = useRef([]);
  const tempMarkersRef = useRef([]);   // corner/vertex dots
  const tempShapeRef = useRef(null);   // lasso preview polyline
  const handleSelectPointRef = useRef(() => {});
  useEffect(() => { selectModeRef.current = selectMode; }, [selectMode]);

  // Live map<->list linkage: the hovered stop id is shared between the markers
  // and the desktop stop table, so emphasis is two-directional.
  const [hoverId, setHoverId] = useState(null);
  const hoverIdRef = useRef(null);
  useEffect(() => { hoverIdRef.current = hoverId; }, [hoverId]);
  const markerByIdRef = useRef(new Map());  // stopId -> { marker, sel, routed }
  const lastEmphRef = useRef(null);

  // Desktop click-drag rubber-band box. The overlay (rendered over the map only
  // while Box mode is armed on desktop) captures the drag so it doesn't pan the
  // map; mouseup converts the two pixel corners to LatLng via the map projection
  // and reuses the proven boxFromCorners + latLngInBounds geometry.
  const overlayRef = useRef(null);         // google.maps.OverlayView for px->latlng
  const dragStartRef = useRef(null);
  const [dragRect, setDragRect] = useState(null);

  // Desktop freehand drag-lasso: a pointer-captured SVG path (NOT DrawingManager).
  // While lasso mode is armed the overlay intercepts pointer events so the map
  // can't pan; pointer-up converts the pixel path to LatLng and selects via
  // pointInPolygon. (Touch keeps the tap-vertices lasso — no overlay on mobile.)
  const lassoDrawingRef = useRef(false);
  const lassoPxRef = useRef([]);
  const [lassoPath, setLassoPath] = useState([]);

  // PRO-number detail popup — the stop being shown, or null.
  const [detailModalStop, setDetailModalStop] = useState(null);
  const [versionLogOpen, setVersionLogOpen] = useState(false);
  const openStop = useCallback((s) => setDetailModalStop(s || null), []);

  // The NuVizz-style bottom data grid (same spreadsheet as the dispatch Map) —
  // collapsed by default so it doesn't cover the map until opened.
  const [bottomTableOpen, setBottomTableOpen] = useState(false);

  // Desktop right rail: Stops | Result. Persisted as a view pref (localStorage ok).
  const [desktopRail, setDesktopRail] = useState(() => {
    try { return localStorage.getItem('routing.rail') === 'result' ? 'result' : 'stops'; } catch { return 'stops'; }
  });
  useEffect(() => { try { localStorage.setItem('routing.rail', desktopRail); } catch { /* ignore */ } }, [desktopRail]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedTruckIds, setSelectedTruckIds] = useState(() => new Set());
  const [intent, setIntent] = useState('');
  const [strategy, setStrategy] = useState('MIN_DISTANCE');
  const [useGoogle, setUseGoogle] = useState(false);
  const [job, setJob] = useState(null);     // { status, result, error }
  const [building, setBuilding] = useState(false);
  const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | error string
  const [lastRequest, setLastRequest] = useState(null);

  const positioned = useMemo(() => stops.filter((s) => s.lat != null && s.lng != null), [stops]);
  const stopById = useMemo(() => new Map(positioned.map((s) => [String(s.stopNbr), s])), [positioned]);
  const positionedRef = useRef(positioned);
  useEffect(() => { positionedRef.current = positioned; }, [positioned]);

  // Default trucks selected once profiles load.
  useEffect(() => {
    if (profiles.length && selectedTruckIds.size === 0) setSelectedTruckIds(new Set(profiles.map((p) => p.id)));
  }, [profiles]); // eslint-disable-line

  const result = job?.status === 'done' ? job.result : null;

  // ── Shared loads (live) + "view a saved load" mode ──
  // Viewing a saved load NEVER touches the live build state (selectedIds /
  // routeState / job / selectedDate). It only swaps what's RENDERED: baseResult +
  // the effective stop map. "Back to build" clears it and the in-progress build is
  // exactly as it was.
  const { loads, loading: loadsLoading, error: loadsError } = useSavedLoads();
  const [viewedLoad, setViewedLoad] = useState(null);
  const [manageError, setManageError] = useState(null);
  const viewing = !!viewedLoad;
  const baseResult = viewedLoad ? viewedLoad.result : result;

  // A saved load carries its own stop snapshot so it renders on the map on any day
  // (names + coords), independent of today's live cache. Old saves without it fall
  // back to the live stopById (same-day loads still work).
  const snapStopById = useMemo(() => {
    const snap = viewedLoad?.stops_snapshot;
    if (!snap) return null;
    const m = new Map();
    for (const [id, v] of Object.entries(snap)) {
      m.set(String(id), { stopNbr: String(id), businessName: v.name ?? id, lat: v.lat, lng: v.lng, pallets: v.pallets ?? null, cartons: v.cartons ?? null, weight: v.weight ?? null });
    }
    return m;
  }, [viewedLoad]);

  // ── Manual route reorder (client-side override of the engine's order) ──
  // routeState holds the CURRENT order per truck (the panel is the source of
  // truth) plus a `reordered` flag. It seeds from the engine result and the
  // dispatcher drags / moves stops to mutate it; the map + panel + recompute all
  // read from here. The engine is never called to reorder.
  const [routeState, setRouteState] = useState(null);
  useEffect(() => {
    if (result && Array.isArray(result.routes)) {
      const init = {};
      for (const r of result.routes) init[r.truckId] = { order: [...r.orderedStopIds], reordered: false };
      setRouteState(init);
    } else {
      setRouteState(null);
    }
  }, [result]);

  const reorderStop = useCallback((truckId, from, to) => {
    setRouteState((prev) => {
      if (!prev || !prev[truckId]) return prev;
      const order = moveItem(prev[truckId].order, from, to);
      if (order === prev[truckId].order || order.length !== prev[truckId].order.length) return prev;
      // moveItem returns a new array even on no-op; detect a real change:
      const changed = order.some((id, i) => id !== prev[truckId].order[i]);
      if (!changed) return prev;
      return { ...prev, [truckId]: { order, reordered: true } };
    });
  }, []);
  const moveStop = useCallback((truckId, index, dir) => reorderStop(truckId, index, index + dir), [reorderStop]);

  // Effective stop map / list — the saved load's snapshot when viewing one
  // (renders any day), else today's live stops. Selection/build always use the
  // live stopById; only the RESULT rendering switches.
  const vStopById = (viewing && snapStopById && snapStopById.size) ? snapStopById : stopById;
  const vPositioned = useMemo(
    () => (viewing ? [...vStopById.values()].filter((s) => s.lat != null && s.lng != null) : positioned),
    [viewing, vStopById, positioned],
  );

  // Per-route display: the CURRENT order, plus legs/ETAs/totals. Live build = the
  // engine's order or a haversine recompute after a manual reorder (read/write).
  // Viewing a saved load = render exactly as saved (read-only); its honesty flags
  // (manualReorder / matrixSource) carry through from the doc.
  const routesView = useMemo(() => {
    const res = baseResult;
    if (!res || !Array.isArray(res.routes)) return [];
    if (!viewing && !routeState) return [];
    const depot = res.meta?.depot || ROUTING_DEPOT;
    const departSec = Number(res.meta?.departEpochSec) || 0;
    const serviceSec = Number(res.meta?.serviceMin) > 0 ? Number(res.meta.serviceMin) * 60 : DEFAULT_SERVICE_SEC;
    const sum = (legs, k) => (Array.isArray(legs) ? legs.reduce((a, l) => a + (Number(l?.[k]) || 0), 0) : null);
    return res.routes.map((r, i) => {
      const color = ROUTE_PALETTE[i % ROUTE_PALETTE.length];
      if (viewing) {
        const reordered = !!(r.manualReorder || res.manualReorder);
        return { truckId: r.truckId, color, order: r.orderedStopIds || [], reordered, etas: r.etas, legs: r.legs,
          totalDistanceMeters: sum(r.legs, 'distanceMeters'), totalDurationSec: sum(r.legs, 'durationSec'), route: r };
      }
      const st = routeState[r.truckId] || { order: r.orderedStopIds, reordered: false };
      if (!st.reordered) {
        return { truckId: r.truckId, color, order: st.order, reordered: false, etas: r.etas, legs: r.legs,
          totalDistanceMeters: sum(r.legs, 'distanceMeters'), totalDurationSec: sum(r.legs, 'durationSec'), route: r };
      }
      const orderedStops = st.order.map((id) => { const s = stopById.get(String(id)); return s ? { id: String(id), lat: s.lat, lng: s.lng } : null; }).filter(Boolean);
      const rc = recomputeRoute(orderedStops, depot, departSec, serviceSec);
      return { truckId: r.truckId, color, order: st.order, reordered: true, etas: rc.etas, legs: rc.legs,
        totalDistanceMeters: rc.totalDistanceMeters, totalDurationSec: rc.totalDurationSec, route: r };
    });
  }, [baseResult, viewing, routeState, stopById]);

  // stopId -> { color, seq } for the numbered route markers (panel & map match).
  const routeInfo = useMemo(() => {
    const m = new Map();
    routesView.forEach((rv) => rv.order.forEach((id, idx) => m.set(String(id), { color: rv.color, seq: idx + 1 })));
    return m;
  }, [routesView]);

  // The plan to persist on Save — engine result with any manual order applied.
  const editedResultForSave = useMemo(() => {
    if (!result) return null;
    const anyReordered = routeState && Object.values(routeState).some((s) => s.reordered);
    if (!anyReordered) return result;
    const byTruck = new Map(routesView.map((rv) => [rv.truckId, rv]));
    return {
      ...result,
      manualReorder: true,
      routes: result.routes.map((r) => {
        const rv = byTruck.get(r.truckId);
        if (!rv || !rv.reordered) return r;
        return { ...r, orderedStopIds: rv.order, etas: rv.etas, legs: rv.legs, manualReorder: true, drivenEstimate: 'haversine' };
      }),
    };
  }, [result, routeState, routesView]);

  // Selection tally + a SPECIFIC per-restriction summary (replaces the old vague
  // "equipment restriction in selection" line). Counts each restriction key and
  // oversize across the selected stops, resolved through the same helpers the
  // map markers use.
  const tally = useMemo(() => {
    let skids = 0, pieces = 0, weight = 0;
    const counts = {};
    let oversize = 0;
    for (const id of selectedIds) {
      const s = stopById.get(String(id));
      if (!s) continue;
      skids += Number(s.cartons) || 0;       // NuVizz totalCartons = real skids
      pieces += Number(s.pallets) || 0;      // NuVizz totalPallets = total pieces
      weight += Number(s.weight) || 0;
      if (stopLooksOversize(s)) oversize += 1;
      const note = notes.get(s.matchKey);
      for (const k of getRestrictionBadgeKeys(note || null)) counts[k] = (counts[k] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${RESTRICTION_ICONS[k]?.short || k}`);
    if (oversize) summary.push(`${oversize} oversize`);
    return { count: selectedIds.size, skids, pieces, weight, summary };
  }, [selectedIds, stopById, notes]);

  const selectedStops = useMemo(
    () => [...selectedIds].map((id) => stopById.get(String(id))).filter(Boolean),
    [selectedIds, stopById],
  );

  const toggleStop = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); const k = String(id); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }, []);
  const removeStop = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(String(id)); return n; });
  }, []);
  const clearSelection = useCallback(() => { setSelectedIds(new Set()); setLastAction('Cleared selection'); }, []);

  // ── Bottom-table pick handlers (the dispatch-Map grid, made route-able) ──
  // Pan/zoom the map to a stop.
  const panToStop = useCallback((s) => {
    if (!s || s.lat == null || s.lng == null || !mapRef.current) return;
    mapRef.current.panTo({ lat: s.lat, lng: s.lng });
    if ((mapRef.current.getZoom() || 0) < 12) mapRef.current.setZoom(13);
  }, []);
  // Tap a table row → frame it on the map AND toggle it into the route selection,
  // so the dispatcher can build a route straight from the spreadsheet.
  const pickStopFromTable = useCallback((s) => {
    if (!s) return;
    panToStop(s);
    if (viewing) return;                       // saved-load view is read-only
    toggleStop(s.stopNbr);
  }, [panToStop, viewing, toggleStop]);
  // Tap a load → select ALL of that load's positioned stops and frame them.
  const pickLoadFromTable = useCallback((loadNbr) => {
    if (viewing || !loadNbr || !google) return;
    const pts = positioned.filter((s) => (s.routeName || s.loadNbr) === loadNbr);
    if (!pts.length) return;
    setSelectedIds((prev) => { const n = new Set(prev); pts.forEach((s) => n.add(String(s.stopNbr))); return n; });
    setLastAction(`Selected ${pts.length} stop${pts.length === 1 ? '' : 's'} from load ${loadNbr}`);
    if (mapRef.current) {
      const b = new google.maps.LatLngBounds();
      pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
      mapRef.current.fitBounds(b, 60);
    }
  }, [viewing, google, positioned]);

  // The selected-stops list: persistent on desktop, collapsed by default on mobile.
  const [listOpen, setListOpen] = useState(!isMobile);
  useEffect(() => { setListOpen(!isMobile); }, [isMobile]);

  // ── Touch-native selection primitives ──
  const clearTemp = useCallback(() => {
    tempMarkersRef.current.forEach((m) => m.setMap(null));
    tempMarkersRef.current = [];
    if (tempShapeRef.current) { tempShapeRef.current.setMap(null); tempShapeRef.current = null; }
  }, []);
  const addTempMarker = useCallback((latLng) => {
    if (!google || !mapRef.current) return;
    const m = new google.maps.Marker({
      position: latLng, map: mapRef.current, clickable: false, zIndex: 60,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 },
    });
    tempMarkersRef.current.push(m);
  }, [google]);
  const redrawLasso = useCallback(() => {
    if (!google || !mapRef.current) return;
    if (tempShapeRef.current) tempShapeRef.current.setMap(null);
    tempShapeRef.current = new google.maps.Polyline({
      path: lassoVtxRef.current.map((v) => ({ lat: v.lat, lng: v.lng })),
      strokeColor: BRAND, strokeWeight: 2, strokeOpacity: 0.9, map: mapRef.current, zIndex: 55,
    });
  }, [google]);
  const cancelMode = useCallback(() => {
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    lassoDrawingRef.current = false; lassoPxRef.current = []; setLassoPath([]);
    selectModeRef.current = null;
    setSelectMode(null); setBoxStep(0); setLassoCount(0);
  }, [clearTemp]);
  const beginMode = useCallback((mode) => {
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    selectModeRef.current = mode;
    setSelectMode(mode); setBoxStep(0); setLassoCount(0); setLastAction(null);
  }, [clearTemp]);
  const addEnclosed = useCallback((arr) => {
    if (!arr.length) { setLastAction('No stops in that area'); return; }
    setSelectedIds((prev) => { const n = new Set(prev); for (const s of arr) n.add(String(s.stopNbr)); return n; });
    setLastAction(`Added ${arr.length} stop${arr.length === 1 ? '' : 's'}`);
  }, []);
  const addInView = useCallback(() => {
    if (!google || !mapRef.current) { setLastAction('Map not ready'); return; }
    const b = mapRef.current.getBounds();
    if (!b) { setLastAction('Map not ready'); return; }
    const ne = b.getNorthEast(), sw = b.getSouthWest();
    const box = { north: ne.lat(), south: sw.lat(), east: ne.lng(), west: sw.lng() };
    addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
  }, [google, addEnclosed]);
  const finishLasso = useCallback(() => {
    const verts = lassoVtxRef.current;
    if (verts.length < 3) { setLastAction('Tap at least 3 points first'); return; }
    const poly = verts.map((v) => [v.lat, v.lng]);
    const enclosed = positionedRef.current.filter((s) => pointInPolygon(s.lat, s.lng, poly));
    addEnclosed(enclosed);
    cancelMode();
  }, [addEnclosed, cancelMode]);
  // A tap on the map (or a marker) while a draw mode is active places a corner /
  // vertex. The once-bound map listener calls the latest version via a ref.
  const handleSelectPoint = useCallback((latLng) => {
    const mode = selectModeRef.current;
    if (!mode || !google || !mapRef.current || !latLng) return;
    if (mode === 'box') {
      boxCornersRef.current.push({ lat: latLng.lat(), lng: latLng.lng() });
      addTempMarker(latLng);
      if (boxCornersRef.current.length >= 2) {
        const box = boxFromCorners(boxCornersRef.current[0], boxCornersRef.current[1]);
        addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
        cancelMode();
      } else {
        setBoxStep(1);
      }
    } else if (mode === 'lasso') {
      lassoVtxRef.current.push({ lat: latLng.lat(), lng: latLng.lng() });
      addTempMarker(latLng);
      redrawLasso();
      setLassoCount(lassoVtxRef.current.length);
    }
  }, [google, addTempMarker, addEnclosed, redrawLasso, cancelMode]);
  useEffect(() => { handleSelectPointRef.current = handleSelectPoint; }, [handleSelectPoint]);

  // The weekday key drives the receiving-hours restriction badges (same as the Map).
  const selectedDayKey = useMemo(() => weekdayKeyFromDate(selectedDate), [selectedDate]);

  // Hover emphasis for the rich image-pin markers — scale the rendered SVG up ~30%
  // and shift the anchor to match (image icons have no Symbol `scale`). Falls back
  // to the Symbol-path bump for any non-image icon (e.g. temp selection dots).
  const emphIcon = useCallback((base) => {
    if (base && base.url && base.scaledSize) {
      const f = 1.3;
      const w = Math.round(base.scaledSize.width * f), h = Math.round(base.scaledSize.height * f);
      return { ...base, scaledSize: new google.maps.Size(w, h), anchor: new google.maps.Point(base.anchor.x * f, base.anchor.y * f) };
    }
    return { ...base, scale: (base.scale || 6) + 2.5, strokeColor: '#0f172a', strokeWeight: 2 };
  }, [google]);

  // Desktop drag-box: convert a container-pixel point to LatLng via the overlay
  // projection (exact, unlike interpolating viewport bounds).
  const pxToLatLng = useCallback((px, py) => {
    const proj = overlayRef.current?.getProjection();
    if (!proj || !google) return null;
    return proj.fromContainerPixelToLatLng(new google.maps.Point(px, py));
  }, [google]);
  const relPoint = (e) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onBoxDown = useCallback((e) => { const p = relPoint(e); dragStartRef.current = p; setDragRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }, []);
  const onBoxMove = useCallback((e) => { if (!dragStartRef.current) return; const p = relPoint(e); setDragRect({ x0: dragStartRef.current.x, y0: dragStartRef.current.y, x1: p.x, y1: p.y }); }, []);
  const onBoxUp = useCallback((e) => {
    const start = dragStartRef.current;
    dragStartRef.current = null; setDragRect(null);
    if (!start) return;
    const p = relPoint(e);
    if (Math.abs(p.x - start.x) < 4 && Math.abs(p.y - start.y) < 4) { cancelMode(); return; } // a click, not a drag
    const a = pxToLatLng(start.x, start.y), b = pxToLatLng(p.x, p.y);
    if (a && b) {
      const box = boxFromCorners({ lat: a.lat(), lng: a.lng() }, { lat: b.lat(), lng: b.lng() });
      addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
    }
    cancelMode();
  }, [pxToLatLng, addEnclosed, cancelMode]);

  // Desktop freehand drag-lasso (pointer-captured; stays armed for repeat draws —
  // the Cancel button / Esc exits). pointInPolygon over the drawn pixel path
  // mapped to LatLng, reusing the proven selection geometry.
  const onLassoDown = useCallback((e) => { const p = relPoint(e); lassoDrawingRef.current = true; lassoPxRef.current = [p]; setLassoPath([p]); }, []);
  const onLassoMove = useCallback((e) => {
    if (!lassoDrawingRef.current) return;
    const p = relPoint(e);
    const arr = lassoPxRef.current;
    const last = arr[arr.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 3) return; // throttle by distance
    arr.push(p); setLassoPath([...arr]);
  }, []);
  const onLassoUp = useCallback(() => {
    if (!lassoDrawingRef.current) return;
    lassoDrawingRef.current = false;
    const pts = lassoPxRef.current;
    lassoPxRef.current = []; setLassoPath([]);
    if (pts.length < 3) { setLastAction('Draw a longer shape around the stops'); return; }
    const poly = pts.map((p) => { const ll = pxToLatLng(p.x, p.y); return ll ? [ll.lat(), ll.lng()] : null; }).filter(Boolean);
    if (poly.length >= 3) addEnclosed(positionedRef.current.filter((s) => pointInPolygon(s.lat, s.lng, poly)));
    // stay in lasso mode so the dispatcher can draw more; Cancel/Esc exits.
  }, [pxToLatLng, addEnclosed]);

  // Re-sequence ONE route client-side (Min distance / Closest / Farthest / Reverse),
  // writing into routeState exactly like a manual drag so the map + ETAs update live
  // and it carries the "Manual order / straight-line estimate" treatment.
  const onResequence = useCallback((truckId, strategy) => {
    if (!strategy) return;
    const depot = result?.meta?.depot || ROUTING_DEPOT;
    const engineRoute = (result?.routes || []).find((r) => r.truckId === truckId);
    setRouteState((prev) => {
      // Seed from routeState if present, else from the freshly-built engine route —
      // so the dropdown reorders a route even before any manual edit (don't no-op).
      const curOrder = (prev && prev[truckId]) ? prev[truckId].order
        : (engineRoute ? engineRoute.orderedStopIds.map(String) : null);
      if (!curOrder) return prev;
      const stops = curOrder.map((id) => { const s = stopById.get(String(id)); return s ? { id: String(id), lat: s.lat, lng: s.lng } : null; }).filter(Boolean);
      if (stops.length < 2) return prev;
      const newOrder = resequence(stops, depot, strategy).map((s) => s.id);
      const resolved = new Set(newOrder);
      const tail = curOrder.map(String).filter((id) => !resolved.has(id)); // keep any unresolvable ids (no silent drops)
      return { ...(prev || {}), [truckId]: { order: [...newOrder, ...tail], reordered: true } };
    });
    setLastAction(`Re-sequenced ${truckId} · ${({ min: 'Min distance', closest: 'Closest first', farthest: 'Farthest first', reverse: 'Reverse' })[strategy] || strategy}`);
  }, [stopById, result]);

  // Esc cancels any armed selection mode.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e) => { if (e.key === 'Escape') cancelMode(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, cancelMode]);

  // Auto-surface the Result in the desktop right rail when a build completes
  // (Stops stays one click away).
  useEffect(() => { if (job?.status === 'done') setDesktopRail('result'); }, [job?.status]);

  // (Re)init the map into the CURRENT container. Re-runs when the viewport crosses
  // the mobile/desktop breakpoint (the map div is then a different DOM node), so
  // the markers + click listener rebind to the live map via the mapReady signal.
  useEffect(() => {
    if (!google || !mapDiv.current) return;
    // Any in-flight draw belongs to the old map node; reset it on re-init.
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    selectModeRef.current = null; setSelectMode(null); setBoxStep(0); setLassoCount(0);
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: ROUTING_DEPOT, zoom: 9, mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      gestureHandling: 'greedy', // one-finger pan/zoom on touch (no two-finger requirement)
      // Match the dispatch Map's look: the same vector map style (mapId) + satellite
      // imagery with road labels (hybrid), instead of the plain roadmap base.
      ...(MAP_ID ? { mapId: MAP_ID } : {}),
      mapTypeId: 'hybrid',
    });
    // Single click listener drives Box/Lasso. Empty-map taps place points; the
    // latest handler is read via a ref so the listener is bound only once per map.
    mapRef.current.addListener('click', (e) => { if (e.latLng) handleSelectPointRef.current(e.latLng); });
    // Invisible overlay → exact container-pixel ↔ LatLng projection for drag-box.
    const ov = new google.maps.OverlayView();
    ov.onAdd = ov.draw = ov.onRemove = () => {};
    ov.setMap(mapRef.current);
    overlayRef.current = ov;
    setMapReady((n) => n + 1);
  }, [google, isMobile]); // eslint-disable-line

  // Render stop markers — the SAME rich dispatch-map pins (status / priority flag /
  // AM-PM window / restriction icons / DNS) via the shared stopMarkerIcon helper, so
  // Routing reads exactly like the Map. Layered with routing semantics: a SELECTED
  // (not-yet-routed) stop pops ORANGE (matched), and a ROUTED stop becomes a numbered
  // pin in its truck's route color (sequence 1..N matching the panel). Click toggles
  // selection; hover drives the map<->list linkage. Numbers/colors track routeInfo so
  // a manual reorder updates the labels live.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    markersRef.current.forEach((m) => m.setMap(null));
    const byId = new Map();
    markersRef.current = vPositioned.map((s) => {
      const id = String(s.stopNbr);
      const sel = !viewing && selectedIds.has(id);
      const ri = routeInfo.get(id);              // { color, seq } when on a route
      const numbered = !!ri;
      const note = notes.get(s.matchKey) || null;
      const hovered = hoverIdRef.current === id;
      const baseIcon = stopMarkerIcon(google, s, note, {
        selectedDayKey,
        matched: sel,
        inRoute: numbered,
        seq: ri?.seq,
        routeColor: ri?.color,
      });
      const baseZ = numbered ? 30 : (sel ? 25 : 10);
      const marker = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        title: s.businessName || s.stopNbr,
        icon: hovered ? emphIcon(baseIcon) : baseIcon,
        zIndex: hovered ? 50 : baseZ,
      });
      marker.addListener('click', () => {
        if (viewing) return;                     // saved load is read-only
        if (selectModeRef.current) handleSelectPointRef.current(marker.getPosition());
        else toggleStop(s.stopNbr);
      });
      marker.addListener('mouseover', () => setHoverId(id));
      marker.addListener('mouseout', () => setHoverId((h) => (h === id ? null : h)));
      marker.setMap(mapRef.current);
      byId.set(id, { marker, baseIcon, baseZ });
      return marker;
    });
    markerByIdRef.current = byId;
    lastEmphRef.current = hoverIdRef.current; // markers were built already-emphasized
  }, [google, vPositioned, viewing, selectedIds, routeInfo, notes, toggleStop, mapReady, selectedDayKey, emphIcon]);

  // Hover emphasis — touch only the two affected markers, not all of them. Keeps
  // the sequence label intact (only the icon scale/ring change).
  useEffect(() => {
    const byId = markerByIdRef.current;
    const setEmph = (id, on) => {
      const e = byId.get(id); if (!e) return;
      e.marker.setIcon(on ? emphIcon(e.baseIcon) : e.baseIcon);
      e.marker.setZIndex(on ? 50 : e.baseZ);
    };
    if (lastEmphRef.current && lastEmphRef.current !== hoverId) setEmph(lastEmphRef.current, false);
    if (hoverId) setEmph(hoverId, true);
    lastEmphRef.current = hoverId;
  }, [hoverId, emphIcon]);

  // Route polylines (one per truck, depot-anchored). Drawn in the CURRENT order
  // (routesView), so a manual reorder redraws the path live.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];
    if (!routesView.length) return;
    routesView.forEach((rv) => {
      const path = [{ lat: ROUTING_DEPOT.lat, lng: ROUTING_DEPOT.lng }];
      for (const id of rv.order) { const s = vStopById.get(String(id)); if (s && s.lat != null && s.lng != null) path.push({ lat: s.lat, lng: s.lng }); }
      const pl = new google.maps.Polyline({ path, strokeColor: rv.color, strokeWeight: 3, strokeOpacity: 0.85, zIndex: 5 });
      pl.setMap(mapRef.current);
      polylinesRef.current.push(pl);
    });
  }, [google, routesView, vStopById, mapReady]);

  const selectedTrucks = useMemo(() => profiles.filter((p) => selectedTruckIds.has(p.id)), [profiles, selectedTruckIds]);
  const canBuild = selectedIds.size >= 1 && selectedTrucks.length >= 1 && selectedIds.size <= ROUTING_MAX_SELECTION && !building;
  const wouldBeElements = (selectedIds.size + 1) ** 2;
  const wouldBeCost = Math.round((wouldBeElements / 1000) * BASIC_RATE_PER_1K_USD * 100) / 100;

  const runBuild = useCallback(async () => {
    if (!db) { setJob({ status: 'error', error: 'Firestore not configured' }); return; }
    setBuilding(true); setJob({ status: 'queued' }); setSaveState(null);
    const jobId = `job_${(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))}`;
    const request = {
      tenant: 'davis', date: selectedDate,
      selectedStopIds: [...selectedIds],
      truckProfileIds: selectedTrucks.map((t) => t.id),
      truckSnapshots: selectedTrucks,
      intent: intent.trim(), strategy,
      matrixMode: useGoogle ? 'google' : 'haversine',
    };
    setLastRequest(request);
    try {
      await setDoc(doc(db, 'routing_jobs', jobId), { id: jobId, status: 'queued', created_at: serverTimestamp(), created_by: 'dispatcher', app_version: APP_VERSION, request });
      // Fire the background build; it returns 202 and we watch the doc.
      fetch('/.netlify/functions/routing-build-background', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) }).catch(() => {});
      const unsub = onSnapshot(doc(db, 'routing_jobs', jobId), (snap) => {
        const d = snap.data();
        if (!d) return;
        setJob(d);
        if (d.status === 'done' || d.status === 'error') { setBuilding(false); unsub(); }
      }, (e) => { setJob({ status: 'error', error: e.message }); setBuilding(false); });
    } catch (e) {
      setJob({ status: 'error', error: e.message }); setBuilding(false);
    }
  }, [selectedDate, selectedIds, selectedTrucks, intent, strategy, useGoogle]);

  // Save panel — a name (prefilled with a sensible auto-name per build) + optional
  // free-text initials. No native prompt(); no auth.
  const [saveName, setSaveName] = useState('');
  const [savedBy, setSavedBy] = useState('');
  useEffect(() => { if (result) setSaveName(buildLoadAutoName(editedResultForSave || result, Date.now())); }, [result]); // eslint-disable-line

  const savePlan = useCallback(async () => {
    if (!db || !result) return;
    setSaveState('saving');
    const id = `routeset_${(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))}`;
    const plan = editedResultForSave || result;
    const name = (saveName && saveName.trim()) || buildLoadAutoName(plan, Date.now());
    // Self-contained stop snapshot (name + coords + counts) so the load renders on
    // the map on any day, independent of today's live cache.
    const stops_snapshot = {};
    const ids = new Set();
    for (const r of plan.routes || []) for (const sid of r.orderedStopIds || []) ids.add(String(sid));
    for (const u of plan.unassigned || []) ids.add(String(u.stopId));
    for (const sid of ids) {
      const s = stopById.get(sid);
      if (s) stops_snapshot[sid] = { name: s.businessName || sid, lat: s.lat ?? null, lng: s.lng ?? null, pallets: Number(s.pallets) || 0, cartons: Number(s.cartons) || 0, weight: Number(s.weight) || 0 };
    }
    try {
      await setDoc(doc(db, 'routing_routes', id), {
        id, name, status: 'saved', dispatched: false,
        created_at: serverTimestamp(), updated_at: serverTimestamp(),
        created_by: 'dispatcher', saved_by: (savedBy && savedBy.trim()) || null,
        app_version: APP_VERSION, request: lastRequest, result: plan,
        manual_reorder: !!(editedResultForSave && editedResultForSave.manualReorder),
        stops_snapshot,
      });
      // Verify by readback (convention: never trust the write alone).
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().name !== name) throw new Error('save not confirmed by readback');
      setSaveState('saved');
    } catch (e) { setSaveState(e.message || 'save failed'); }
  }, [result, lastRequest, editedResultForSave, saveName, savedBy, stopById]);

  // Manage a saved load (rename / dispatched / delete) — every write verified by
  // readback; the live onSnapshot reflects the change everywhere.
  const renameLoad = useCallback(async (id, name) => {
    setManageError(null);
    if (!db || !name || !name.trim()) return;
    try {
      await updateDoc(doc(db, 'routing_routes', id), { name: name.trim(), updated_at: serverTimestamp() });
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().name !== name.trim()) throw new Error('rename not confirmed');
    } catch (e) { setManageError(e.message || 'rename failed'); }
  }, []);
  const toggleDispatched = useCallback(async (id, next) => {
    setManageError(null);
    if (!db) return;
    try {
      await updateDoc(doc(db, 'routing_routes', id), { dispatched: !!next, status: next ? 'dispatched' : 'saved', updated_at: serverTimestamp() });
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().dispatched !== !!next) throw new Error('dispatch toggle not confirmed');
    } catch (e) { setManageError(e.message || 'update failed'); }
  }, []);
  const deleteLoad = useCallback(async (id) => {
    setManageError(null);
    if (!db) return;
    try {
      await deleteDoc(doc(db, 'routing_routes', id));
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (back.exists()) throw new Error('delete not confirmed');
      setViewedLoad((v) => (v && v.id === id ? null : v));
    } catch (e) { setManageError(e.message || 'delete failed'); }
  }, []);

  // Keep the viewed load live: track edits from any device, close if deleted.
  // Only swap when the doc actually changed (updated_at) so unrelated snapshot
  // churn doesn't re-render the whole view.
  useEffect(() => {
    if (!viewedLoad) return;
    const fresh = loads.find((l) => l.id === viewedLoad.id);
    if (!fresh) { setViewedLoad(null); return; }
    if (tsToMillis(fresh.updated_at) !== tsToMillis(viewedLoad.updated_at)) setViewedLoad(fresh);
  }, [loads]); // eslint-disable-line

  // Frame the map to a saved load's stops when it's opened (not on every refresh).
  useEffect(() => {
    if (!google || !mapRef.current || !viewing) return;
    const pts = vPositioned.filter((s) => s.lat != null && s.lng != null);
    if (!pts.length) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
    b.extend(ROUTING_DEPOT);
    mapRef.current.fitBounds(b, 60);
  }, [viewing, viewedLoad?.id, mapReady, google]); // eslint-disable-line

  // Stops kept on a route but outside their appointment window (advisory flag from
  // the engine result). Used to flag rows + the detail popup.
  const windowViolatedSet = useMemo(() => {
    const s = new Set();
    for (const r of (baseResult?.routes || [])) for (const id of (r.windowViolatedIds || [])) s.add(String(id));
    return s;
  }, [baseResult]);

  const meta = baseResult?.meta || {};
  const usedGoogle = meta.matrixSource === 'google';

  // Responsive: desktop = three side rails; mobile = full map + a collapsible
  // bottom sheet that toggles between the Setup controls and the Result.
  const [mobilePanel, setMobilePanel] = useState('setup');
  const [sheetOpen, setSheetOpen] = useState(true);
  useEffect(() => { if (job?.status === 'done') { setMobilePanel('result'); setSheetOpen(true); } }, [job?.status]);

  // Discard the BUILT plan (output), keeping the selection + trucks (inputs) so the
  // dispatcher can adjust and rebuild without re-selecting. Purely local — no
  // Firestore write, saved Loads untouched. `planEdited` (a manual reorder or P3
  // re-sequence) gates a one-tap confirm so hand-tuning isn't lost by accident.
  const planEdited = !!(routeState && Object.values(routeState).some((s) => s.reordered));
  const discardPlan = useCallback(() => {
    setJob(null); setRouteState(null); setSaveState(null); setBuilding(false); setLastRequest(null);
    setLastAction('Discarded plan — selection kept');
    setMobilePanel('setup');
  }, []);

  const controlsContent = (
    <>
      <div className="flex items-center justify-between">
        <div className="font-bold text-slate-800">Routing <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">beta</span></div>
        <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} onToday={() => setSelectedDate(todayInET())} compact />
      </div>
      <div className="text-[11px] text-slate-500">{loading ? 'Loading stops…' : `${positioned.length} stops on ${formatDateLong(selectedDate)}`}{stopsError ? ` · ${stopsError}` : ''}</div>

      {/* Selection tools — all touch-native (no drag-to-draw). */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">1 · Select stops</div>
        {selectMode ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[12px] space-y-2">
            {selectMode === 'box' ? (
              isMobile
                ? <div>📦 <b>Tap two corners</b> on the map to box a group ({boxStep === 0 ? '1 of 2' : '2 of 2'}).</div>
                : <div>📦 <b>Drag a box</b> around the stops on the map. Esc or Cancel to stop.</div>
            ) : (
              isMobile
                ? <div>⬠ <b>Tap points</b> around the stops, then <b>Done</b> ({lassoCount} {lassoCount === 1 ? 'point' : 'points'}; need ≥3).</div>
                : <div>⬠ <b>Hold and draw</b> a shape around the stops (release to select). Esc or Cancel to stop.</div>
            )}
            <div className="flex gap-1">
              {selectMode === 'lasso' && isMobile && (
                <button onClick={finishLasso} disabled={lassoCount < 3} className="flex-1 px-2 py-2 text-xs rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>Done</button>
              )}
              <button onClick={cancelMode} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={addInView} className="w-full px-2 py-2 text-xs rounded border-2 font-semibold hover:bg-blue-50 active:bg-blue-100" style={{ borderColor: BRAND, color: BRAND }}>＋ Add stops in view</button>
            <div className="flex gap-1">
              <button onClick={() => beginMode('box')} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">▱ Box</button>
              <button onClick={() => beginMode('lasso')} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">⬠ Lasso</button>
              <button onClick={clearSelection} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">Clear</button>
            </div>
            <div className="text-[11px] text-slate-600">{isMobile ? 'Tap' : 'Click'} a stop to toggle it. Or pan/zoom, then <b>Add stops in view</b>, <b>Box</b> ({isMobile ? 'tap two corners' : 'drag'}), or <b>Lasso</b> ({isMobile ? 'tap points' : 'hold & draw'}).</div>
          </>
        )}
        {lastAction && <div className="text-[11px] text-slate-500">{lastAction}</div>}
        <div className="bg-slate-50 rounded p-2 text-[12px] space-y-0.5">
          <div className="flex justify-between"><span>Selected</span><b>{tally.count}</b></div>
          <div className="flex justify-between"><span>Skids</span><b>{tally.skids}</b></div>
          <div className="flex justify-between"><span>Loose pieces</span><b>{tally.pieces}</b></div>
          <div className="flex justify-between"><span>Weight</span><b>{tally.weight.toLocaleString()} lb</b></div>
          {tally.summary.length > 0 && (
            <div className="text-[11px] text-amber-700 pt-1">⚠ {tally.summary.join(' · ')}</div>
          )}
          {tally.count > ROUTING_MAX_SELECTION && <div className="text-[11px] text-red-600 pt-1">Over {ROUTING_MAX_SELECTION}-stop limit — narrow the selection (matrix cost is quadratic).</div>}
        </div>

        {/* On mobile the selected-stops list lives here in the Setup sheet (the #41
            pattern). On desktop it is the right rail's Stops tab instead. */}
        {isMobile && <RoutingSelectedList selectedStops={selectedStops} notes={notes} onRemove={removeStop} open={listOpen} setOpen={setListOpen} onOpenStop={openStop} />}
      </div>

      {/* Trucks */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">2 · Trucks <span className="text-[11px] text-slate-400">({selectedTrucks.length} in play)</span></div>
        {profiles.map((p) => (
          <div key={p.id} className="border rounded p-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={selectedTruckIds.has(p.id)} onChange={() => setSelectedTruckIds((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} />
              <span className="font-medium">{p.label}</span>
            </label>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[10px] text-slate-500">
              <label className="flex flex-col">Skids
                <input type="number" defaultValue={p.maxSkids} onBlur={(e) => saveProfile({ ...p, maxSkids: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
              <label className="flex flex-col">Weight
                <input type="number" defaultValue={p.maxWeightLbs} onBlur={(e) => saveProfile({ ...p, maxWeightLbs: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
              <label className="flex flex-col">Deck in
                <input type="number" defaultValue={p.deckLengthIn} onBlur={(e) => saveProfile({ ...p, deckLengthIn: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
            </div>
            <label className="flex items-center gap-1 text-[11px] mt-1">
              <input type="checkbox" defaultChecked={!!p.capabilities?.liftgate} onChange={(e) => saveProfile({ ...p, capabilities: { ...p.capabilities, liftgate: e.target.checked } })} /> liftgate
            </label>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">3 · Plan</div>
        <textarea value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Optional: tell the engine what you want (e.g. 'tight appointments first, keep the trailer off downtown')" rows={2} className="w-full border rounded p-1.5 text-[12px]" />
        <label className="flex items-center justify-between text-[12px]">Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="border rounded px-1 py-1">
            {ROUTING_STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className={`flex items-start gap-2 text-[12px] rounded p-1.5 ${useGoogle ? 'bg-amber-50 border border-amber-300' : 'bg-slate-50'}`}>
          <input type="checkbox" checked={useGoogle} onChange={(e) => setUseGoogle(e.target.checked)} className="mt-0.5" />
          <span>Use live Google drive-times <b>(costs money)</b><br /><span className="text-[11px] text-slate-500">Default is a free straight-line estimate. {selectedIds.size > 0 && <>This build ≈ {wouldBeElements} elements ≈ <b>${wouldBeCost.toFixed(2)}</b>.</>}</span></span>
        </label>
        <button onClick={runBuild} disabled={!canBuild} className="w-full py-2 rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>
          {building ? 'Building…' : useGoogle ? 'Build with Google drive-times' : 'Build (free estimate)'}
        </button>
        {!canBuild && !building && <div className="text-[11px] text-slate-400">Select ≥1 stop and ≥1 truck to build.</div>}
      </div>
    </>
  );

  const resultContent = (
    <RoutingResultPanel job={job} result={baseResult} meta={meta} usedGoogle={usedGoogle} stopById={vStopById}
      onSave={savePlan} saveState={saveState} saveName={saveName} setSaveName={setSaveName} savedBy={savedBy} setSavedBy={setSavedBy}
      onDiscard={discardPlan} planEdited={planEdited}
      routesView={routesView} onReorder={reorderStop} onMove={moveStop} onResequence={onResequence} readOnly={viewing}
      hoverId={hoverId} setHoverId={setHoverId} onOpenStop={openStop}
      savedLoad={viewedLoad} onCloseLoad={() => setViewedLoad(null)}
      onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
  );

  const loadsContent = (
    <RoutingLoadsPanel loads={loads} loading={loadsLoading} error={loadsError}
      viewedId={viewedLoad?.id || null}
      onOpen={(l) => { setViewedLoad(l); setMobilePanel('result'); setSheetOpen(true); }}
      onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
  );

  // ── Mobile: map + collapsible bottom sheet (Setup / Result) ──
  if (isMobile) {
    const tabCls = (on) => `flex-1 py-1.5 text-xs font-semibold rounded ${on ? 'text-white' : 'text-slate-600 bg-slate-100'}`;
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 relative min-w-0">
          <div ref={mapDiv} className="absolute inset-0" />
          <RoutingBuildBadge onClick={() => setVersionLogOpen(true)} />
          {mapsError && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-red-50 border border-red-300 text-red-700 text-[11px] rounded px-2 py-1">{mapsError}</div>}
          {viewing
            ? <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-indigo-600 text-white text-[11px] rounded shadow px-3 py-1.5 flex items-center gap-2 max-w-[92%]"><span className="truncate">👁 {viewedLoad?.name || viewedLoad?.id}</span><button onClick={() => setViewedLoad(null)} className="underline shrink-0">Back</button></div>
            : <div className="absolute top-2 left-2 bg-white/95 border border-slate-200 rounded shadow px-2 py-1 text-[11px]">{tally.count} selected · {tally.skids} skids · {tally.pieces} pcs</div>}
          {/* The dispatch-Map data grid — Stops/Loads spreadsheet, route-able. */}
          <BottomStopsTable
            stops={stops}
            loadStops={stops}
            boardDate={selectedDate}
            notes={notes}
            totalCount={stops.length}
            open={bottomTableOpen}
            setOpen={setBottomTableOpen}
            onPick={pickStopFromTable}
            onPickLoad={pickLoadFromTable}
          />
        </div>
        <div className="border-t bg-white flex flex-col shrink-0" style={{ height: sheetOpen ? '50%' : 'auto' }}>
          <div className="flex items-center gap-2 px-2 py-1.5 border-b">
            <button onClick={() => setSheetOpen((o) => !o)} className="text-xs px-2 py-1 rounded border border-slate-300" aria-label={sheetOpen ? 'Collapse' : 'Expand'}>{sheetOpen ? '▾' : '▴'}</button>
            <div className="flex-1 flex gap-1">
              <button onClick={() => { setMobilePanel('setup'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'setup')} style={mobilePanel === 'setup' ? { background: BRAND } : {}}>Setup{tally.count ? ` (${tally.count})` : ''}</button>
              <button onClick={() => { setMobilePanel('loads'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'loads')} style={mobilePanel === 'loads' ? { background: BRAND } : {}}>Loads{loads.length ? ` (${loads.length})` : ''}</button>
              <button onClick={() => { setMobilePanel('result'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'result')} style={mobilePanel === 'result' ? { background: BRAND } : {}}>Result{baseResult ? ` (${baseResult.routes.length})` : job?.status === 'running' || job?.status === 'queued' ? ' …' : ''}</button>
            </div>
          </div>
          {sheetOpen && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
              {mobilePanel === 'setup' ? controlsContent : mobilePanel === 'loads' ? loadsContent : resultContent}
            </div>
          )}
        </div>
        {detailModalStop && <RoutingStopModal stop={detailModalStop} notes={notes} windowViolatedSet={windowViolatedSet} onClose={() => setDetailModalStop(null)} />}
        {versionLogOpen && <VersionLogModal onClose={() => setVersionLogOpen(false)} />}
      </div>
    );
  }

  // ── Desktop: the dispatch console — Setup (left) · large map (center) ·
  //    Stops/Result (right). ──
  const railTab = (id, label) => (
    <button
      onClick={() => setDesktopRail(id)}
      className={`flex-1 py-2 text-[13px] font-semibold border-b-2 ${desktopRail === id ? 'text-slate-900' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
      style={desktopRail === id ? { borderColor: BRAND, color: BRAND } : {}}
    >{label}</button>
  );
  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: Setup stack */}
      <div className="w-[340px] shrink-0 border-r bg-white overflow-y-auto p-3 space-y-3 text-sm">
        {controlsContent}
      </div>

      {/* Center: the map canvas */}
      <div className="flex-1 relative min-w-0">
        <div ref={mapDiv} className="absolute inset-0" />
        <RoutingBuildBadge onClick={() => setVersionLogOpen(true)} />
        {mapsError && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-red-50 border border-red-300 text-red-700 text-[11px] rounded px-2 py-1">{mapsError}</div>}
        {viewing && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-indigo-600 text-white text-[12px] rounded shadow px-3 py-1.5 flex items-center gap-3 max-w-[80%]">
            <span className="truncate">👁 Viewing saved load: <b>{viewedLoad?.name || viewedLoad?.id}</b></span>
            <button onClick={() => setViewedLoad(null)} className="underline shrink-0 font-semibold">Back to build</button>
          </div>
        )}
        {/* Drag-box capture overlay — active only while Box mode is armed on desktop. */}
        {selectMode === 'box' && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onMouseDown={onBoxDown} onMouseMove={onBoxMove} onMouseUp={onBoxUp} onMouseLeave={onBoxUp}
          >
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-900/85 text-white text-[11px] rounded px-2 py-1 pointer-events-none">Drag a box around the stops · Esc to cancel</div>
            {dragRect && (
              <div className="absolute border-2 bg-blue-400/10 pointer-events-none" style={{
                borderColor: BRAND,
                left: Math.min(dragRect.x0, dragRect.x1), top: Math.min(dragRect.y0, dragRect.y1),
                width: Math.abs(dragRect.x1 - dragRect.x0), height: Math.abs(dragRect.y1 - dragRect.y0),
              }} />
            )}
          </div>
        )}
        {/* Freehand drag-lasso capture overlay — desktop, while Lasso mode is armed.
            Pointer-captured so the map can't pan; an SVG path previews the shape. */}
        {selectMode === 'lasso' && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onMouseDown={onLassoDown} onMouseMove={onLassoMove} onMouseUp={onLassoUp} onMouseLeave={onLassoUp}
          >
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-900/85 text-white text-[11px] rounded px-2 py-1 pointer-events-none">Hold and draw a shape around the stops · Esc to cancel</div>
            {lassoPath.length > 1 && (
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <polyline points={lassoPath.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(30,91,146,0.10)" stroke={BRAND} strokeWidth="2" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
        {/* The dispatch-Map data grid — Stops/Loads spreadsheet, route-able. */}
        <BottomStopsTable
          stops={stops}
          loadStops={stops}
          boardDate={selectedDate}
          notes={notes}
          totalCount={stops.length}
          open={bottomTableOpen}
          setOpen={setBottomTableOpen}
          onPick={pickStopFromTable}
          onPickLoad={pickLoadFromTable}
        />
      </div>

      {/* Right: Stops | Result */}
      <div className="w-[380px] shrink-0 border-l bg-white flex flex-col min-h-0">
        <div className="flex border-b shrink-0">
          {railTab('stops', `Stops${tally.count ? ` (${tally.count})` : ''}`)}
          {railTab('loads', `Loads${loads.length ? ` (${loads.length})` : ''}`)}
          {railTab('result', `Result${baseResult ? ` (${baseResult.routes.length})` : (job?.status === 'running' || job?.status === 'queued') ? ' …' : ''}`)}
        </div>
        {desktopRail === 'stops' ? (
          <RoutingStopsPanel selectedStops={selectedStops} notes={notes} onRemove={removeStop} hoverId={hoverId} setHoverId={setHoverId} onOpenStop={openStop} />
        ) : desktopRail === 'loads' ? (
          <RoutingLoadsPanel loads={loads} loading={loadsLoading} error={loadsError}
            viewedId={viewedLoad?.id || null}
            onOpen={(l) => { setViewedLoad(l); setDesktopRail('result'); }}
            onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm">{resultContent}</div>
        )}
      </div>
      {detailModalStop && <RoutingStopModal stop={detailModalStop} notes={notes} windowViolatedSet={windowViolatedSet} onClose={() => setDetailModalStop(null)} />}
        {versionLogOpen && <VersionLogModal onClose={() => setVersionLogOpen(false)} />}
    </div>
  );
}

function RoutingResultPanel({ job, result, meta, usedGoogle, stopById, onSave, saveState, saveName, setSaveName, savedBy, setSavedBy, onDiscard, planEdited, routesView, onReorder, onMove, onResequence, readOnly, hoverId, setHoverId, onOpenStop, savedLoad, onCloseLoad, onRename, onToggleDispatch, onDelete, manageError }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false); // risk flags are a collapsed disclosure; never auto-expand
  useEffect(() => { setConfirmDiscard(false); setRiskOpen(false); }, [job, savedLoad]);
  // Live-build status gates only apply when NOT viewing a saved load.
  if (!savedLoad) {
    if (!job) return <div className="text-[12px] text-slate-400">Build a plan to see routes, ETAs, load, spill, and cost here.</div>;
    if (job.status === 'queued' || job.status === 'running') return <div className="text-[12px] text-slate-600">⏳ Building plan… ({job.stage || job.status})</div>;
    if (job.status === 'error') return <div className="text-[12px] text-red-600">Build failed: {job.error || 'unknown error'}</div>;
    if (!result) return <div className="text-[12px] text-slate-400">No result.</div>;
  }
  if (!result || !Array.isArray(result.routes)) {
    return (
      <div className="space-y-3">
        {savedLoad && <SavedLoadManageBar load={savedLoad} onClose={onCloseLoad} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} manageError={manageError} />}
        <div className="text-[12px] text-slate-400">This load has no routes to show.</div>
      </div>
    );
  }

  const cost = meta.estimatedCostUsd || 0;
  const ai = result.aiAssist || {};
  return (
    <div className="space-y-3">
      {savedLoad ? (
        <SavedLoadManageBar load={savedLoad} onClose={onCloseLoad} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} manageError={manageError} />
      ) : (
        <div className="rounded border border-slate-300 bg-slate-50 p-2 text-[11px] text-slate-600">
          This is a <b>plan saved in our system only</b>. It has <b>NOT</b> been sent to NuVizz or dispatched to any driver.
        </div>
      )}

      {/* Cost / quality readout */}
      <div className={`rounded border p-2 text-[12px] ${usedGoogle ? 'border-amber-300 bg-amber-50' : 'border-green-300 bg-green-50'}`}>
        <div className="font-semibold">{usedGoogle ? 'Google live drive-times' : 'Free estimate (straight-line)'}</div>
        <div className="flex justify-between"><span>Matrix elements</span><b>{meta.googleElementCount ?? '—'}</b></div>
        <div className="flex justify-between"><span>Estimated cost</span><b>${Number(cost).toFixed(2)}</b></div>
        <div className="flex justify-between"><span>AI assist</span><b>{result.aiConfigured ? `${[ai.intent && 'intent', ai.explain && 'rationale', ai.geometry && 'geometry'].filter(Boolean).join(', ') || 'available, not needed'}` : 'off'}</b></div>
      </div>

      {!readOnly && <div className="text-[11px] text-slate-500">Drag a stop (or use ▲▼) to reorder a route. The map and ETAs update live.</div>}

      {/* Rationale + risk */}
      {result.rationale && <div className="text-[12px] text-slate-700"><b>Rationale.</b> {result.rationale}</div>}
      {Array.isArray(result.riskFlags) && result.riskFlags.length > 0 && (
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded">
          <button onClick={() => setRiskOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-2 py-1.5 font-semibold text-left" aria-expanded={riskOpen}>
            <span>⚠ {result.riskFlags.length} risk flag{result.riskFlags.length === 1 ? '' : 's'}</span>
            {riskOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {riskOpen && <ul className="list-disc ml-5 pr-2 pb-2 space-y-0.5">{result.riskFlags.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      )}

      {/* Routes (numbered; reorderable unless viewing a saved load) */}
      {(routesView || []).map((rv) => (
        <RoutingRouteCard key={rv.truckId} rv={rv} stopById={stopById} usedGoogle={usedGoogle} readOnly={readOnly}
          onReorder={onReorder} onMove={onMove} onResequence={onResequence} hoverId={hoverId} setHoverId={setHoverId} onOpenStop={onOpenStop} />
      ))}

      {/* Spill */}
      {result.unassigned && result.unassigned.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-[12px]">
          <div className="font-semibold text-red-700 mb-1">Could not place ({result.unassigned.length})</div>
          {result.unassigned.map((u) => {
            const s = stopById.get(String(u.stopId));
            return (
              <div key={u.stopId} className="mb-1">
                <div className="flex items-center gap-1.5"><b>{s?.businessName || u.stopId}</b>{s && <ProLink stop={s} onOpen={onOpenStop} className="text-[11px]" />}</div>
                <div className="text-[11px] text-red-600">{u.reasons.join('; ')}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Save panel (live build only) */}
      {!savedLoad && (
        <div className="border-t pt-2 space-y-1.5">
          <label className="block text-[11px] font-semibold text-slate-600">Save as
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Load name" className="mt-0.5 w-full border rounded px-2 py-1 text-[12px] font-normal text-slate-800" />
          </label>
          <input value={savedBy} onChange={(e) => setSavedBy(e.target.value)} placeholder="Saved by (initials, optional)" className="w-full border rounded px-2 py-1 text-[12px] text-slate-800" />
          <div className="flex gap-2">
            <button onClick={onSave} disabled={saveState === 'saving'} className="flex-1 py-2 rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved — shared' : 'Save load'}
            </button>
            {onDiscard && (
              confirmDiscard ? (
                <button onClick={() => { setConfirmDiscard(false); onDiscard(); }} className="shrink-0 px-3 py-2 rounded bg-red-600 text-white text-[12px] font-semibold">Discard hand-tuned plan?</button>
              ) : (
                <button
                  onClick={() => (planEdited ? setConfirmDiscard(true) : onDiscard())}
                  title="Throw away this built plan and start over (keeps your stop + truck selection)"
                  className="shrink-0 px-3 py-2 rounded border border-red-300 text-red-700 text-[12px] font-semibold hover:bg-red-50"
                >Discard plan</button>
              )
            )}
          </div>
          {saveState && saveState !== 'saving' && saveState !== 'saved' && <div className="text-[11px] text-red-600">{saveState}</div>}
          <div className="text-[10px] text-slate-400">Discard clears the routes (keeps your selection); it doesn’t touch any saved load.</div>
        </div>
      )}
    </div>
  );
}

// Saved-load header + manage row: rename (inline, no native prompt), toggle
// Dispatched, Delete (explicit confirm), and "Back to build".
function SavedLoadManageBar({ load, onClose, onRename, onToggleDispatch, onDelete, manageError }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(load?.name || '');
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setDraft(load?.name || ''); setEditing(false); setConfirmDel(false); }, [load?.id]);
  const dispatched = !!load?.dispatched;
  const created = formatDateTime(tsToMillis(load?.created_at));
  return (
    <div className="rounded border border-indigo-300 bg-indigo-50 p-2 text-[12px] space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase font-bold tracking-wide text-indigo-700">Viewing saved load</span>
        <button onClick={onClose} className="text-[11px] underline text-indigo-700 font-semibold shrink-0">← Back to build</button>
      </div>
      {editing ? (
        <div className="flex items-center gap-1">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 border rounded px-2 py-1 text-[12px]" />
          <button onClick={() => { onRename(load.id, draft); setEditing(false); }} className="px-2 py-1 text-[11px] rounded text-white font-semibold" style={{ background: BRAND }}>Save</button>
          <button onClick={() => { setDraft(load.name || ''); setEditing(false); }} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800 truncate flex-1" title={load?.name}>{load?.name || load?.id}</span>
          <button onClick={() => setEditing(true)} className="text-[11px] underline text-slate-600 shrink-0">Rename</button>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
        <span className={`px-1.5 py-0.5 rounded font-bold uppercase ${dispatched ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{dispatched ? 'Dispatched' : 'Saved'}</span>
        {load?.manual_reorder && <span className="px-1.5 py-0.5 rounded font-bold uppercase bg-amber-100 text-amber-700">Manual order</span>}
        {created && <span>{created}</span>}
        {load?.saved_by && <span>· by {load.saved_by}</span>}
        {load?.app_version && <span>· v{load.app_version}</span>}
      </div>
      <div className="flex items-center gap-1 pt-0.5">
        <button onClick={() => onToggleDispatch(load.id, !dispatched)} className="flex-1 px-2 py-1 text-[11px] rounded border border-slate-300 bg-white hover:bg-slate-50">
          {dispatched ? 'Mark not dispatched' : 'Mark dispatched'}
        </button>
        {confirmDel ? (
          <>
            <button onClick={() => onDelete(load.id)} className="px-2 py-1 text-[11px] rounded bg-red-600 text-white font-semibold">Confirm delete</button>
            <button onClick={() => setConfirmDel(false)} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="px-2 py-1 text-[11px] rounded border border-red-300 text-red-700 hover:bg-red-50">Delete</button>
        )}
      </div>
      {manageError && <div className="text-[11px] text-red-600">{manageError}</div>}
    </div>
  );
}

// The live, shared Loads list — fed by useSavedLoads (onSnapshot). Sortable;
// explicit loading / empty / error. Each row opens the load on the map.
function RoutingLoadsPanel({ loads, loading, error, viewedId, onOpen, onRename, onToggleDispatch, onDelete, manageError }) {
  const rows = useMemo(() => (loads || []).map((l) => ({
    id: l.id, doc: l,
    name: l.name || l.id,
    trucks: Array.isArray(l.result?.routes) ? l.result.routes.length : 0,
    stops: Array.isArray(l.result?.routes) ? l.result.routes.reduce((a, r) => a + (r.orderedStopIds?.length || 0), 0) : 0,
    status: l.dispatched ? 'Dispatched' : 'Saved',
    created: tsToMillis(l.created_at) || 0,
  })), [loads]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'created', 'desc');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 text-[11px] text-slate-500 border-b shrink-0">Saved loads are <b>shared live</b> — a save on any device shows here within seconds.{manageError && <span className="text-red-600"> · {manageError}</span>}</div>
      {error ? (
        <div className="p-4 text-[12px] text-red-600">Couldn’t load saved loads: {error}</div>
      ) : loading ? (
        <div className="p-4 text-[12px] text-slate-500">Loading saved loads…</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-[12px] text-slate-400">No saved loads yet. Build a plan and use <b>Save load</b>.</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="flex items-center gap-3 px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b bg-slate-50 sticky top-0">
            <button onClick={() => toggle('name')} className="flex-1 text-left inline-flex items-center gap-0.5">Name{sortKey === 'name' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('status')} className="inline-flex items-center gap-0.5">Status{sortKey === 'status' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('stops')} className="inline-flex items-center gap-0.5">Stops{sortKey === 'stops' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('created')} className="inline-flex items-center gap-0.5">Created{sortKey === 'created' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
          </div>
          <div className="divide-y">
            {sorted.map((r) => (
              <LoadRow key={r.id} row={r} active={viewedId === r.id} onOpen={onOpen} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LoadRow({ row, active, onOpen, onRename, onToggleDispatch, onDelete }) {
  const l = row.doc;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(l.name || '');
  const [confirmDel, setConfirmDel] = useState(false);
  const created = formatDateTime(row.created);
  return (
    <div className={`px-3 py-2 ${active ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
      {editing ? (
        <div className="flex items-center gap-1 mb-1">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 border rounded px-2 py-1 text-[12px]" />
          <button onClick={() => { onRename(l.id, draft); setEditing(false); }} className="px-2 py-1 text-[11px] rounded text-white font-semibold" style={{ background: BRAND }}>Save</button>
          <button onClick={() => { setDraft(l.name || ''); setEditing(false); }} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
        </div>
      ) : (
        <button onClick={() => onOpen(l)} className="w-full text-left">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[12px] truncate flex-1" title={row.name}>{row.name}</span>
            {active && <span className="text-[9px] font-bold text-indigo-700">VIEWING</span>}
          </div>
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 flex-wrap mt-0.5">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${l.dispatched ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{row.status}</span>
            {l.manual_reorder && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-700">Manual order</span>}
            <span>{row.trucks} truck{row.trucks === 1 ? '' : 's'} · {row.stops} stop{row.stops === 1 ? '' : 's'}</span>
            {created && <span>· {created}</span>}
            {l.saved_by && <span>· {l.saved_by}</span>}
            {l.app_version && <span>· v{l.app_version}</span>}
          </div>
        </button>
      )}
      <div className="flex items-center gap-2 mt-1 text-[11px]">
        <button onClick={() => onOpen(l)} className="underline text-blue-700">Open</button>
        <button onClick={() => setEditing((e) => !e)} className="underline text-slate-600">Rename</button>
        <button onClick={() => onToggleDispatch(l.id, !l.dispatched)} className="underline text-slate-600">{l.dispatched ? 'Un-dispatch' : 'Dispatch'}</button>
        {confirmDel ? (
          <span className="inline-flex items-center gap-1">
            <button onClick={() => onDelete(l.id)} className="underline text-red-700 font-semibold">Confirm</button>
            <button onClick={() => setConfirmDel(false)} className="underline text-slate-500">Cancel</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="underline text-red-600 ml-auto">Delete</button>
        )}
      </div>
    </div>
  );
}

function fmtRouteDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// One truck's route — NUMBERED stops in the CURRENT sequence (matching the map
// markers). On a live build: drag-and-drop or ▲▼ to reorder. When viewing a
// saved load (readOnly), the reorder affordances are hidden (view-only this PR).
function RoutingRouteCard({ rv, stopById, usedGoogle, readOnly, onReorder, onMove, onResequence, hoverId, setHoverId, onOpenStop }) {
  const route = rv.route;
  const rows = rv.order.map((id, idx) => {
    const s = stopById.get(String(id));
    return { seq: idx + 1, stopId: String(id), stop: s, customer: s?.businessName || id, eta: rv.etas?.[idx] ?? null,
      skids: Number(s?.cartons) || 0, pieces: Number(s?.pallets) || 0, weight: Number(s?.weight) || 0 };
  });
  const piecesTotal = rows.reduce((a, r) => a + r.pieces, 0);
  const skidsTotal = rows.reduce((a, r) => a + r.skids, 0);
  const miles = rv.totalDistanceMeters != null ? rv.totalDistanceMeters / 1609.34 : null;
  const lastIdx = rows.length - 1;
  const winViolated = new Set((route?.windowViolatedIds || []).map(String)); // advisory window flags

  const dragFrom = useRef(null);
  const [overIdx, setOverIdx] = useState(null);
  const onDragStart = (i) => (e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* some browsers */ } };
  const onDragOver = (i) => (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overIdx !== i) setOverIdx(i); };
  const onDrop = (i) => (e) => { e.preventDefault(); const from = dragFrom.current; dragFrom.current = null; setOverIdx(null); if (from != null && from !== i) onReorder(rv.truckId, from, i); };
  const onDragEnd = () => { dragFrom.current = null; setOverIdx(null); };

  return (
    <div className="rounded border border-slate-200">
      <div className="px-2 py-1.5 flex items-center gap-2 border-b flex-wrap" style={{ borderLeft: `4px solid ${rv.color}` }}>
        <span className="font-semibold">{route.truckId}</span>
        <span className="text-[11px] text-slate-500">{rows.length} stops · {skidsTotal} skid{skidsTotal === 1 ? '' : 's'} · {piecesTotal} pc{piecesTotal === 1 ? '' : 's'}{miles != null ? ` · ~${miles.toFixed(1)} mi · ~${fmtRouteDur(rv.totalDurationSec)}` : ''}</span>
        {rv.reordered && <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Manual order</span>}
        {!readOnly && onResequence && rows.length > 1 && (
          <select
            value=""
            onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) onResequence(rv.truckId, v); }}
            title="Re-sequence this route"
            className="ml-auto text-[11px] border border-slate-300 rounded px-1 py-0.5 bg-white"
          >
            <option value="">Re-sequence…</option>
            <option value="min">Min distance</option>
            <option value="closest">Closest first</option>
            <option value="farthest">Farthest first</option>
            <option value="reverse">Reverse</option>
          </select>
        )}
      </div>
      <div className="p-2 space-y-1.5">
        <CapacityBar label="Skids" used={route.load.skids} cap={route.capacity.skids} unit="" />
        <CapacityBar label="Weight" used={route.load.weightLbs} cap={route.capacity.weightLbs} unit="lb" />
        <CapacityBar label="Deck" used={route.load.linearFeetIn} cap={route.capacity.linearFeetIn} unit="in" />
      </div>
      {rv.reordered && (
        <div className="px-2 pb-1 text-[10px] text-amber-700">
          Sequence edited — drive times are straight-line estimates{usedGoogle ? ' (original Google road times no longer apply to this order)' : ''}.
        </div>
      )}
      <ul className="divide-y">
        {rows.map((row, i) => {
          const hot = hoverId === row.stopId;
          return (
            <li
              key={row.stopId}
              draggable={!readOnly}
              onDragStart={readOnly ? undefined : onDragStart(i)} onDragOver={readOnly ? undefined : onDragOver(i)} onDrop={readOnly ? undefined : onDrop(i)} onDragEnd={readOnly ? undefined : onDragEnd}
              onMouseEnter={() => setHoverId && setHoverId(row.stopId)}
              onMouseLeave={() => setHoverId && setHoverId((h) => (h === row.stopId ? null : h))}
              className={`flex items-center gap-2 px-2 py-1.5 ${overIdx === i ? 'border-t-2 border-t-blue-500' : ''} ${hot ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
            >
              {!readOnly && <span className="cursor-grab text-slate-400 select-none text-sm leading-none" title="Drag to reorder" aria-hidden>⋮⋮</span>}
              <span className="w-5 h-5 shrink-0 rounded-full text-white text-[10px] font-bold flex items-center justify-center" style={{ background: rv.color }}>{row.seq}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium text-[12px]" title={row.customer}>{row.customer}</span>
                  {row.stop && <span className="shrink-0 text-[10px]"><ProLink stop={row.stop} onOpen={onOpenStop} /></span>}
                </div>
                <div className="text-[10px] text-slate-500">{formatRoutingEta(row.eta)} · {row.skids} sk · {row.pieces} pc · {row.weight.toLocaleString()} lb</div>
                {winViolated.has(row.stopId) && <div className="text-[10px] text-amber-700 font-semibold">⚠ outside appointment window{apptWindowLabel(row.stop) ? ` (${apptWindowLabel(row.stop)})` : ''}</div>}
              </div>
              {!readOnly && (
                <div className="flex flex-col shrink-0">
                  <button onClick={() => onMove(rv.truckId, i, -1)} disabled={i === 0} aria-label={`Move ${row.customer} up`} className="text-slate-500 hover:text-slate-900 disabled:opacity-25 leading-none text-[11px]">▲</button>
                  <button onClick={() => onMove(rv.truckId, i, +1)} disabled={i === lastIdx} aria-label={`Move ${row.customer} down`} className="text-slate-500 hover:text-slate-900 disabled:opacity-25 leading-none text-[11px]">▼</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- shell ----------

function Shell() {
  const [tab, setTab] = useState('map');
  const viewportWidth = useViewportWidth();
  const { h: viewportHeight, w: visibleWidth, x: viewportLeft, y: viewportTop } = useViewportSize();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;
  const [chipMenuOpen, setChipMenuOpen] = useState(false);

  // SMS messages + unread badge. Messages is a WINDOW over the current screen
  // (it doesn't navigate away), so it's a toggle, not a tab.
  const inbound = useSmsMessages();
  const { notes } = useCustomerNotes();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [smsSeenAt, setSmsSeenAt] = useState(() => Number(safeReadJSON(LS_SMS_SEEN, 0)) || 0);
  const smsUnread = inbound.filter((m) => m.direction === 'in' && new Date(m.at || 0).getTime() > smsSeenAt).length;
  const openMessages = () => { setMessagesOpen(true); };
  const closeMessages = () => { setMessagesOpen(false); const now = Date.now(); setSmsSeenAt(now); safeWriteJSON(LS_SMS_SEEN, now); };

  // Customer contacts (phone → name) from saved notes, for the Messages contact
  // picker. Employees (drivers/contractors) come from the roster endpoint inside
  // the panel; customers are the names we already know locally.
  const customerContacts = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const n of notes.values()) for (const c of (n.contacts || [])) {
      const k = normPhone(c?.phone); if (k.length !== 10 || seen.has(k)) continue;
      seen.add(k); out.push({ phone: k, name: n.raw_name || c?.name || '' });
    }
    return out;
  }, [notes]);

  // Close chip menu on any tab change or click outside the bar.
  useEffect(() => { setChipMenuOpen(false); }, [tab]);

  const onSelectMenu = (next) => {
    setChipMenuOpen(false);
    if (next === 'messages') { openMessages(); return; }
    setTab(next === 'diagnostics' ? 'diag' : next === 'routing' ? 'routing' : 'map');
  };

  return (
    // h-screen is the SSR/first-paint fallback; once mounted we pin the shell to
    // the live visible viewport height (pixels) so iOS Safari toolbars can't hide
    // the bottom Save bar. Pixel height keeps the map container non-zero.
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{
        ...(viewportHeight ? { height: viewportHeight } : {}),
        // Pin to the visible width so iOS's slightly-wider layout viewport can't
        // push right-edge controls off-screen.
        ...(visibleWidth ? { width: visibleWidth, maxWidth: visibleWidth } : {}),
        // On mobile, anchor the shell to the visible (visual) viewport's actual
        // position. When iOS focuses an input it can scroll the visual viewport
        // sideways/up inside the wider layout viewport; without this the shell
        // stays at the layout-left and slides partly off the visible screen
        // (the "screen is shifting" / content hanging off the left edge bug).
        ...(isMobile
          ? { position: 'fixed', left: viewportLeft || 0, top: viewportTop || 0 }
          : {}),
      }}
    >
      {isMobile ? (
        <MobileAppBar
          version={APP_VERSION}
          chipMenuOpen={chipMenuOpen}
          onChipMenu={() => setChipMenuOpen((v) => !v)}
          onSelectMenu={onSelectMenu}
          smsUnread={smsUnread}
        />
      ) : (
        <header className="flex items-center justify-between px-4 py-2 border-b bg-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          <div className="flex items-center gap-3">
            <img src="/davis-logo.jpg" alt="Davis Delivery Service" className="h-9 w-auto" />
            <div className="font-bold leading-tight text-slate-800 border-l border-slate-200 pl-3">Dispatch Map</div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <TabBtn label="Map" icon={<MapPin size={14} />} active={tab === 'map'} onClick={() => setTab('map')} />
            {ROUTING_FLAG && <TabBtn label="Routing (beta)" icon={<MapPinned size={14} />} active={tab === 'routing'} onClick={() => setTab('routing')} />}
            <TabBtn label="Messages" icon={<MessageSquare size={14} />} active={messagesOpen} onClick={openMessages} badge={smsUnread} />
            <TabBtn label="Diagnostics" icon={<Activity size={14} />} active={tab === 'diag'} onClick={() => setTab('diag')} />
          </nav>
          {/* Right side intentionally empty — no auth in v0.3.0 (matches Glory Bound / MarginIQ). */}
          <div />
        </header>
      )}

      {tab === 'map' ? <MapScreen onOpenMessages={openMessages} smsUnread={smsUnread} /> : (tab === 'routing' && ROUTING_FLAG) ? <RoutingScreen /> : <DiagnosticsRoute />}

      {/* Messages floats OVER the current screen (you never leave the map). */}
      {messagesOpen && <MessagesPanel messages={inbound} seenAt={smsSeenAt} onClose={closeMessages} customerContacts={customerContacts} />}

      {/* Footer is desktop/tablet only on mobile; the in-map version chip
          and the top-bar chip cover the same info on small screens. */}
      {!isMobile && (
        <footer className="border-t bg-white px-4 py-1 text-[10px] text-slate-400 flex items-center justify-between">
          <div>Dispatch Map v{APP_VERSION} · {BUILD_COMMIT}{BUILD_TIME ? ` · built ${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : ''}</div>
          <div className="hidden sm:block">© Davis Delivery Service</div>
        </footer>
      )}
    </div>
  );
}

// Tiny diagnostics wrapper so the screen has its own data fetch
// (rather than threading the map's state through props).
function DiagnosticsRoute() {
  const { stops, ops, lastLoadScanAt, lastUnplannedScanAt, loading, refresh } = useStops();
  const { notes } = useCustomerNotes();
  return (
    <DiagnosticsScreen
      stops={stops}
      notes={notes}
      ops={ops}
      lastLoadScanAt={lastLoadScanAt}
      lastUnplannedScanAt={lastUnplannedScanAt}
      refreshing={loading}
      onRefresh={() => refresh()}
    />
  );
}

// Normalize a phone to 10 digits (drops a leading US country-code 1). Used by the
// shell to derive customer contacts handed to the Messages panel.
const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };

function TabBtn({ label, icon, active, onClick, badge = 0 }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-1.5 rounded inline-flex items-center gap-1.5 font-medium ${active ? 'text-white' : 'text-slate-600 hover:bg-slate-100'}`}
      style={active ? { background: BRAND } : {}}
    >
      {icon}{label}
      {badge > 0 && (
        <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold inline-flex items-center justify-center">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
}

export default function App() {
  return <Shell />;
}
