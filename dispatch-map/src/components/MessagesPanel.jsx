// src/components/MessagesPanel.jsx
//
// Messages — a full texting client for the dispatch board. Three views, two layouts:
//
//   1. Conversations  — avatar + name + last-message preview + time + unread mark, searchable,
//                        filterable (All / Unread / Drivers / Customers), with a compose button.
//   2. New message    — a contact picker grouped into Drivers / Contractors /
//                        Customers / Team (the roster the dispatcher asked for),
//                        plus "Recent" and a "send to a typed number" affordance.
//   3. Conversation   — bubbles in runs under day dividers, the time and send state under each
//                        run, and a composer; outbound sends echo instantly (optimistic).
//
// PHONE (< 640px): full screen, one view at a time — list, then a conversation or the picker.
// DESKTOP (>= 1024px): a two-pane drawer — the list on the left stays put, and the conversation
// or the picker opens beside it, so moving between conversations is one click, not back + click.
// Between the two (a narrow window, a tablet) it is the phone's stacked layout in a 400px drawer.
//
// Contacts come from two sources, merged by phone:
//   • Employees (drivers / contractors / team) — /.netlify/functions/messaging-roster
//   • Customers — derived from customer_notes on the client, passed in as a prop.
//
// Sending reuses /.netlify/functions/send-sms (the browser can't hold the SMS key).
// Inbound replies + recorded outbounds stream in via the `messages` prop (a live
// Firestore subscription owned by the shell). The display rules — row times, previews,
// filters, runs, what a sent bubble may claim — live in lib/messages-view.js.

import { useState, useRef, useEffect, useMemo } from 'react';
import { MessageSquare, X, Send, ArrowLeft, Search, SquarePen, Phone, AlertCircle, RotateCw } from 'lucide-react';
// send-sms is one of the requireUser()-gated endpoints; apiFetch is the only thing that
// puts the session token on a request (see lib/api.js).
import { apiFetch } from '../lib/api.js';
import {
  LIST_FILTERS, filterThreads, listTime, fullTime, dayLabel, clockTime, previewOf, threadLayout, outboundState, NO_TEXT,
} from '../lib/messages-view.js';

const BRAND = '#1e5b92';

// ---------- phone + name helpers ----------

const digits = (p) => String(p ?? '').replace(/\D/g, '');
const normPhone = (p) => { const d = digits(p); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
function fmtPhone(raw) {
  const ten = normPhone(raw);
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (raw || '');
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function postSendSms(payload) {
  const r = await apiFetch('/.netlify/functions/send-sms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

// Employee roster (drivers / contractors / team) for the contact picker.
function useMessagingRoster() {
  const [contacts, setContacts] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch('/.netlify/functions/messaging-roster');
        const d = await r.json();
        if (!cancelled && d?.ok && Array.isArray(d.contacts)) setContacts(d.contacts);
      } catch { /* best-effort: customers + threads still work */ }
      finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  return { contacts, ready };
}

// Track the VISIBLE viewport (height + top offset). On mobile the panel is
// position:fixed, which iOS sizes to the *layout* viewport — so when the soft
// keyboard opens, a bottom-pinned composer ends up hidden BEHIND the keyboard
// ("no way to send"). Sizing the panel to window.visualViewport keeps the
// composer and Send button above the keyboard, like the rest of the app does.
function useVisualViewport() {
  const read = () => {
    if (typeof window === 'undefined') return { h: 0, top: 0 };
    const vv = window.visualViewport;
    return { h: vv ? vv.height : window.innerHeight, top: vv ? vv.offsetTop : 0 };
  };
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setVp(read());
    update();
    if (vv) { vv.addEventListener('resize', update); vv.addEventListener('scroll', update); }
    window.addEventListener('resize', update);
    return () => {
      if (vv) { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); }
      window.removeEventListener('resize', update);
    };
  }, []);
  return vp;
}

// ---------- small presentational bits ----------

// One colour per kind of contact, in quiet tints, instead of a rainbow hashed off the name:
// on a list of forty texts the colour should answer "driver or customer?" at a glance, and a
// number nobody has named reads as exactly that — grey, with a phone.
const GROUP_META = {
  driver: { chip: 'Driver', tag: 'bg-blue-50 text-blue-700 ring-blue-600/20', avatar: 'bg-blue-100 text-blue-800' },
  contractor: { chip: 'Contractor', tag: 'bg-violet-50 text-violet-700 ring-violet-600/20', avatar: 'bg-violet-100 text-violet-800' },
  customer: { chip: 'Customer', tag: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', avatar: 'bg-emerald-100 text-emerald-800' },
  team: { chip: 'Team', tag: 'bg-slate-50 text-slate-600 ring-slate-500/20', avatar: 'bg-slate-200 text-slate-700' },
};

function Avatar({ name, group, size = 40 }) {
  const text = initials(name);
  const tone = text ? (GROUP_META[group]?.avatar || GROUP_META.customer.avatar) : 'bg-slate-100 text-slate-400';
  return (
    <div
      className={`rounded-full flex items-center justify-center font-semibold flex-shrink-0 select-none ${tone}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {text || <Phone size={Math.round(size * 0.4)} strokeWidth={2} />}
    </div>
  );
}

function GroupChip({ group }) {
  const m = GROUP_META[group];
  if (!m) return null;
  return <span className={`inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium ring-1 ring-inset flex-shrink-0 ${m.tag}`}>{m.chip}</span>;
}

function IconButton({ onClick, label, children, className = '' }) {
  return (
    <button
      type="button" onClick={onClick} aria-label={label} title={label}
      className={`w-10 h-10 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 flex-shrink-0 ${className}`}
    >
      {children}
    </button>
  );
}

// ---------- main component ----------

// `sendDenied` — the sentence explaining why this account may not text, or null when it may.
// send-sms is gated at dispatcher on the server; resolved in App (LOGIN_MODE lives there) and
// handed down, because this panel floats over every screen and is a child of none of them.
//
// THE FAILURE IT PREVENTS is not an error message, it is a phone call that never happened: a
// viewer types "running late, there by 2", presses send, watches the bubble appear — and the
// customer is standing at a dock waiting on a truck nobody told them about. The optimistic
// echo makes a refused send look exactly like a delivered one until the bubble turns red.
export default function MessagesPanel({ messages, seenAt = 0, onClose, customerContacts = [], sendDenied = null }) {
  const { contacts: roster } = useMessagingRoster();
  const vp = useVisualViewport();

  const [view, setView] = useState('list');          // 'list' | 'new' | 'thread'
  const [active, setActive] = useState(null);        // { phone, name, group, isEmployee }
  const [listQuery, setListQuery] = useState('');
  const [listFilter, setListFilter] = useState('all');
  const [newQuery, setNewQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState([]);        // optimistic outbound echoes
  // Conversations opened in THIS sitting, phone → when. Closing the panel already marks every
  // text seen (App stamps seenAt on close); this only lets a conversation stop reading as unread
  // the moment it is opened, instead of every row keeping its dot until the panel shuts.
  const [readAt, setReadAt] = useState({});
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const newSearchRef = useRef(null);

  // Merge every known contact into one phone-keyed directory. Employee roster
  // entries win over customer entries for name/group (a person who is a driver
  // shouldn't be mislabeled "Customer" just because they're also on a notes card).
  const directory = useMemo(() => {
    const byPhone = new Map();
    const upsert = (phone, name, group, isEmployee) => {
      const k = normPhone(phone);
      if (k.length !== 10) return;
      const cur = byPhone.get(k) || { phone: k, name: '', group: null, isEmployee: false };
      if (isEmployee) { cur.isEmployee = true; cur.group = group; if (name) cur.name = name; }
      else { if (!cur.isEmployee) cur.group = cur.group || 'customer'; if (name && !cur.name) cur.name = name; }
      byPhone.set(k, cur);
    };
    for (const c of roster) upsert(c.phone, c.name, c.group || 'team', true);
    for (const c of customerContacts) upsert(c.phone, c.name, 'customer', false);
    return byPhone;
  }, [roster, customerContacts]);

  const resolveContact = (phone, driverTag) => {
    const k = normPhone(phone);
    const d = directory.get(k);
    if (d) return { phone: k, name: d.name || driverTag || null, group: d.group || (driverTag ? 'driver' : 'customer'), isEmployee: d.isEmployee || !!driverTag };
    if (driverTag) return { phone: k, name: driverTag, group: 'driver', isEmployee: true };
    return { phone: k, name: null, group: 'customer', isEmployee: false };
  };

  const readingPhone = view === 'thread' ? active?.phone : null;

  // Group the live message stream into conversation threads by the other party's
  // phone, enriched with the resolved contact + unread flag, newest first.
  const threads = useMemo(() => {
    const byPhone = new Map();
    for (const m of messages || []) {
      const k = normPhone(m.contactPhone);
      if (k.length !== 10) continue;
      let t = byPhone.get(k);
      if (!t) { t = { phone: k, msgs: [], driverTag: null }; byPhone.set(k, t); }
      t.msgs.push(m);
      if (m.driverName && !t.driverTag) t.driverTag = m.driverName;
    }
    const arr = [...byPhone.values()].map((t) => {
      t.msgs.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
      const last = t.msgs[t.msgs.length - 1];
      const c = resolveContact(t.phone, t.driverTag);
      const seen = Math.max(seenAt, readAt[t.phone] || 0);
      const unread = t.phone !== readingPhone && t.msgs.some((m) => m.direction === 'in' && new Date(m.at || 0).getTime() > seen);
      return { ...t, ...c, last, lastAt: last?.at || null, unread };
    });
    arr.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, directory, seenAt, readAt, readingPhone]);

  // Drop optimistic echoes once the real recorded outbound shows up in the stream.
  useEffect(() => {
    if (!pending.length) return;
    setPending((p) => p.filter((pm) => !(messages || []).some(
      (m) => m.direction === 'out' && normPhone(m.contactPhone) === pm.phone && (m.text || '').trim() === pm.text.trim(),
    )));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Focus + autoscroll behavior per view.
  useEffect(() => {
    if (view === 'thread') setTimeout(() => composerRef.current?.focus(), 60);
    if (view === 'new') setTimeout(() => newSearchRef.current?.focus(), 60);
  }, [view, active?.phone]);

  const activeThread = active ? threads.find((t) => t.phone === active.phone) : null;
  const threadMsgs = useMemo(() => {
    const real = activeThread ? activeThread.msgs : [];
    const echoes = active ? pending.filter((p) => p.phone === active.phone) : [];
    return [...real, ...echoes].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  }, [activeThread, pending, active]);
  const layout = useMemo(() => threadLayout(threadMsgs), [threadMsgs]);

  useEffect(() => {
    if (view === 'thread' && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [threadMsgs.length, view, active?.phone]);

  // The composer grows with what is typed, up to ~6 lines, then scrolls.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, view]);

  const markRead = (phone) => { if (phone) setReadAt((r) => ({ ...r, [phone]: Date.now() })); };
  // Leaving a conversation (back, another conversation, New message) counts it read up to now.
  const goTo = (next) => { if (view === 'thread') markRead(active?.phone); setView(next); };

  const openConversation = (contact) => {
    const phone = normPhone(contact.phone);
    if (view === 'thread' && active?.phone !== phone) markRead(active?.phone);
    markRead(phone);
    setActive({ phone, name: contact.name || null, group: contact.group || 'customer', isEmployee: !!contact.isEmployee });
    setDraft('');
    setView('thread');
  };

  const startNew = () => { setNewQuery(''); goTo('new'); };

  const titleOf = (c) => c?.name || fmtPhone(c?.phone);

  const sendInThread = async (retryText) => {
    const text = (retryText ?? draft).trim();
    if (!text || !active || sendDenied) return;
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setPending((p) => [...p.filter((m) => !(m.status === 'failed' && m.text.trim() === text && m.phone === active.phone)),
      { tempId, phone: active.phone, text, at: new Date().toISOString(), direction: 'out', status: 'sending' }]);
    if (retryText == null) setDraft('');
    setSending(true);
    try {
      const recipients = [{ to: active.phone, label: titleOf(active), ...(active.isEmployee && active.name ? { driverName: active.name } : {}) }];
      const res = await postSendSms({ text, recipients });
      const ok = res?.ok || res?.sent > 0;
      if (ok) {
        // Leave the echo; the snapshot effect swaps in the recorded message. Fallback
        // cleanup in case Firestore lags or is disabled in this environment. Until then it
        // reads "Sent" — send-sms answered ok, which is what that word claims and no more.
        setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: 'sent' } : m)));
        setTimeout(() => setPending((p) => p.filter((m) => m.tempId !== tempId)), 8000);
      } else {
        const err = res?.results?.find((r) => !r.ok)?.error || res?.error || 'Not delivered';
        setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: 'failed', error: err } : m)));
      }
    } catch (e) {
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: 'failed', error: e.message } : m)));
    } finally { setSending(false); }
  };

  // ----- conversation list (filtered) -----
  const filteredThreads = useMemo(
    () => filterThreads(threads, { filter: listFilter, query: listQuery, activePhone: readingPhone }),
    [threads, listFilter, listQuery, readingPhone],
  );
  const unreadCount = threads.filter((t) => t.unread).length;

  // ----- contact picker sections (New message) -----
  const sections = useMemo(() => {
    const q = newQuery.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const match = (c) => !q || (c.name || '').toLowerCase().includes(q) || (qd && c.phone.includes(qd));
    const byName = (a, b) => {
      if (!!a.name !== !!b.name) return a.name ? -1 : 1;       // named before number-only
      return (a.name || a.phone).localeCompare(b.name || b.phone);
    };
    const all = [...directory.values()].filter(match);
    const pick = (g) => all.filter((c) => (c.group || 'customer') === g).sort(byName);
    const recent = threads.filter((t) => match(t)).slice(0, 8);
    return { recent, drivers: pick('driver'), contractors: pick('contractor'), customers: pick('customer'), team: pick('team') };
  }, [directory, threads, newQuery]);

  const typedNumber = useMemo(() => {
    const k = normPhone(newQuery);
    if (k.length !== 10 || directory.has(k)) return null;
    return k;
  }, [newQuery, directory]);

  // ---------- render ----------

  // box-content: the bar is 56px tall plus whatever the phone's notch takes above it.
  const headerPad = { paddingTop: 'env(safe-area-inset-top)' };
  const closeBtn = <IconButton onClick={onClose} label="Close messages"><X size={18} /></IconButton>;
  // Back to the list exists only where the list is hidden — the stacked phone/drawer layout.
  const backBtn = (label) => (
    <IconButton onClick={() => goTo('list')} label={label} className="-ml-2 lg:hidden"><ArrowLeft size={18} /></IconButton>
  );

  const emptyListText = listQuery.trim()
    ? `No conversations match “${listQuery.trim()}”.`
    : listFilter === 'unread' ? 'You’re all caught up — no unread conversations.'
      : listFilter === 'drivers' ? 'No conversations with drivers yet.'
        : listFilter === 'customers' ? 'No conversations with customers yet.'
          : null;

  const listPane = (
    <section className={`${view === 'list' ? 'flex' : 'hidden lg:flex'} w-full lg:w-[360px] lg:border-r border-slate-200 flex-col min-h-0 flex-shrink-0 bg-white`}>
      <div className="h-14 pl-4 pr-2 flex items-center gap-1 flex-shrink-0 box-content" style={headerPad}>
        <h2 className="text-[17px] font-semibold text-slate-900 flex-1 truncate">Messages</h2>
        <button
          type="button" onClick={startNew}
          className="h-9 pl-2.5 pr-3 inline-flex items-center gap-1.5 rounded-lg text-[13px] font-semibold text-white flex-shrink-0 hover:opacity-90"
          style={{ background: BRAND }} aria-label="New message" title="New message"
        >
          <SquarePen size={15} /> New
        </button>
        <span className="lg:hidden">{closeBtn}</span>
      </div>

      <div className="px-4 pb-3 flex-shrink-0 space-y-2.5 border-b border-slate-200">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            value={listQuery} onChange={(e) => setListQuery(e.target.value)}
            placeholder="Search name, number or text"
            aria-label="Search messages"
            className="w-full h-9 rounded-lg bg-slate-100 border border-transparent pl-9 pr-3 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-slate-300 focus:ring-2 focus:ring-brand-100"
          />
        </div>
        <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label="Filter conversations">
          {LIST_FILTERS.map((f) => {
            const on = listFilter === f.key;
            return (
              <button
                key={f.key} type="button" role="tab" aria-selected={on} onClick={() => setListFilter(f.key)}
                className={`flex-auto h-8 px-2 rounded-md text-[13px] font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${on ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {f.label}
                {f.key === 'unread' && unreadCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold leading-[18px] text-white text-center flex-shrink-0" style={{ background: BRAND }}>{unreadCount}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {threads.length === 0 && !listQuery.trim() ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8 gap-3">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center text-slate-400"><MessageSquare size={26} /></div>
            <div>
              <div className="text-[15px] font-semibold text-slate-800">No conversations yet</div>
              <div className="text-[13px] text-slate-500 mt-0.5">Texts with drivers and customers show up here.</div>
            </div>
            <button type="button" onClick={startNew} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-white rounded-lg px-3.5 h-9" style={{ background: BRAND }}>
              <SquarePen size={15} /> New message
            </button>
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="px-8 py-14 text-center text-[13px] text-slate-500">{emptyListText}</div>
        ) : (
          <ul>
            {filteredThreads.map((t) => {
              const sel = view === 'thread' && active?.phone === t.phone;
              const pv = previewOf(t.last);
              return (
                <li key={t.phone}>
                  <button
                    type="button" onClick={() => openConversation(t)} aria-current={sel ? 'true' : undefined}
                    className={`relative w-full text-left pl-4 pr-3 py-3 flex items-center gap-3 border-b border-slate-100 ${sel ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                  >
                    {sel && <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: BRAND }} />}
                    <Avatar name={t.name} group={t.group} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[14px] truncate ${t.unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-800'}`}>{titleOf(t)}</span>
                        {t.group && t.group !== 'customer' && <GroupChip group={t.group} />}
                        <span
                          className={`ml-auto pl-1 text-[12px] flex-shrink-0 tabular-nums ${t.unread ? 'font-semibold' : 'text-slate-500'}`}
                          style={t.unread ? { color: BRAND } : undefined} title={fullTime(t.lastAt)}
                        >{listTime(t.lastAt)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[13px] truncate flex-1 ${pv.empty ? 'italic text-slate-400' : t.unread ? 'text-slate-700' : 'text-slate-500'}`}>
                          {pv.mine && <span className="not-italic text-slate-400">You: </span>}{pv.text}
                        </span>
                        {t.unread && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: BRAND }} aria-label="Unread" />}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );

  const paneHeader = (children) => (
    <div className="h-14 pl-4 pr-2 border-b border-slate-200 flex items-center gap-2 flex-shrink-0 box-content bg-white" style={headerPad}>
      {children}
      {closeBtn}
    </div>
  );

  const newPane = (
    <>
      {paneHeader(<>
        {backBtn('Back')}
        <h2 className="text-[16px] font-semibold text-slate-900 flex-1 truncate">New message</h2>
      </>)}
      <div className="px-4 h-12 border-b border-slate-200 flex-shrink-0 flex items-center gap-3">
        <span className="text-[13px] text-slate-500 font-medium">To</span>
        <input
          ref={newSearchRef} value={newQuery} onChange={(e) => setNewQuery(e.target.value)}
          placeholder="Name or 10-digit number"
          aria-label="Recipient"
          className="flex-1 min-w-0 h-full text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none bg-transparent"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {typedNumber && (
          <ContactRow
            contact={{ phone: typedNumber, name: null, group: 'customer', isEmployee: false }}
            subtitle="Text this number" onClick={openConversation} forceName={fmtPhone(typedNumber)}
          />
        )}
        <Section title="Recent" items={sections.recent} onPick={openConversation} keyer={(t) => `r_${t.phone}`} />
        <Section title="Drivers" items={sections.drivers} onPick={openConversation} keyer={(c) => `d_${c.phone}`} />
        <Section title="Contractors" items={sections.contractors} onPick={openConversation} keyer={(c) => `c_${c.phone}`} />
        <Section title="Customers" items={sections.customers} onPick={openConversation} keyer={(c) => `u_${c.phone}`} />
        <Section title="Team" items={sections.team} onPick={openConversation} keyer={(c) => `t_${c.phone}`} />
        {!typedNumber && !sections.recent.length && !sections.drivers.length && !sections.contractors.length && !sections.customers.length && !sections.team.length && (
          <div className="px-8 py-14 text-center text-[13px] text-slate-500">
            {newQuery ? 'No matching contacts. Type a 10-digit number to text someone new.' : 'No contacts on the roster yet.'}
          </div>
        )}
      </div>
    </>
  );

  const threadPane = active && (
    <>
      {paneHeader(<>
        {backBtn('Back to messages')}
        <Avatar name={active.name} group={active.group} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[15px] font-semibold text-slate-900 truncate leading-tight">{titleOf(active)}</span>
            {active.group && active.group !== 'customer' && <GroupChip group={active.group} />}
          </div>
          {active.name && <div className="text-[12px] text-slate-500 truncate leading-tight mt-0.5 tabular-nums">{fmtPhone(active.phone)}</div>}
        </div>
      </>)}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 bg-slate-50">
        {threadMsgs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-6">
            <Avatar name={active.name} group={active.group} size={56} />
            <div className="text-[15px] font-semibold text-slate-800 mt-1">{titleOf(active)}</div>
            <div className="text-[13px] text-slate-500 tabular-nums">{fmtPhone(active.phone)}{active.group && active.group !== 'customer' ? ` · ${GROUP_META[active.group]?.chip}` : ''}</div>
            <div className="text-[13px] text-slate-400 mt-2">Send a message to start the conversation.</div>
          </div>
        )}
        {layout.map(({ m, newDay, runStart, runEnd }, i) => {
          const out = m.direction === 'out';
          const st = outboundState(m);
          const failed = !!st?.failed;
          const empty = !String(m.text || '').trim();
          const shape = out
            ? `rounded-2xl ${runEnd ? 'rounded-br-md' : ''}`
            : `rounded-2xl ${runEnd ? 'rounded-bl-md' : ''}`;
          const tone = !out ? 'bg-white text-slate-900 ring-1 ring-slate-200'
            : failed ? 'bg-red-50 text-red-900 ring-1 ring-red-200' : 'text-white';
          return (
            <div key={m.id || m.tempId || i}>
              {newDay && (
                <div className={`flex items-center gap-3 ${i === 0 ? 'mb-4' : 'my-4'}`}>
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] font-medium text-slate-500">{dayLabel(m.at)}</span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>
              )}
              <div className={`flex ${out ? 'justify-end' : 'justify-start'} ${runStart && !newDay ? 'mt-3' : 'mt-0.5'}`}>
                <div
                  className={`max-w-[80%] px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap ${shape} ${tone} ${m.status === 'sending' ? 'opacity-70' : ''}`}
                  style={out && !failed ? { background: BRAND } : undefined}
                >
                  {empty ? <span className={`italic ${out && !failed ? 'text-white/70' : 'text-slate-400'}`}>{NO_TEXT}</span> : m.text}
                </div>
              </div>
              {runEnd && (
                <div className={`flex ${out ? 'justify-end' : 'justify-start'} mt-1 px-1`}>
                  {failed ? (
                    <button type="button" onClick={() => sendInThread(m.text)} className="inline-flex items-center gap-1 text-[11px] text-red-600 font-semibold max-w-[85%] text-right" title={st.reason || undefined}>
                      <AlertCircle size={12} className="flex-shrink-0" />
                      <span className="truncate">{st.label}{st.reason && st.reason !== st.label ? ` — ${st.reason}` : ''}</span>
                      <span className="inline-flex items-center gap-0.5 underline underline-offset-2 flex-shrink-0"><RotateCw size={11} /> Retry</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-slate-400 tabular-nums" title={fullTime(m.at)}>
                      {clockTime(m.at)}{st ? ` · ${st.label}` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-200 px-3 pt-2.5 flex-shrink-0 bg-white" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
        {/* Said ABOVE the composer, not after the press. The thread stays fully readable
            — reading a customer's "we're closed today" is a viewer's whole job — and
            only the outbound half is closed off. */}
        {sendDenied && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-300 px-2.5 py-1.5 text-[12px] font-semibold text-amber-900">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span className="min-w-0">You can read this thread but not reply. {sendDenied}</span>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white pl-3.5 pr-1.5 py-1.5 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
          <textarea
            ref={composerRef} value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInThread(); } }}
            placeholder={sendDenied ? 'Replying is not available for this account' : `Text ${active.name ? active.name.split(/\s+/)[0] : fmtPhone(active.phone)}`}
            disabled={!!sendDenied}
            aria-label="Message"
            className="flex-1 min-w-0 py-[7px] text-base sm:text-[14px] leading-[22px] text-slate-900 placeholder:text-slate-400 resize-none max-h-40 bg-transparent focus:outline-none disabled:text-slate-400"
          />
          <button
            onClick={() => sendInThread()} disabled={!draft.trim() || sending || !!sendDenied}
            title={sendDenied || 'Send'}
            className="flex-shrink-0 w-9 h-9 rounded-lg text-white flex items-center justify-center disabled:opacity-30 transition-opacity"
            style={{ background: BRAND }} aria-label="Send"
          >
            <Send size={16} />
          </button>
        </div>
        {!sendDenied && <div className="hidden lg:block text-[11px] text-slate-400 mt-1.5 px-1">Enter to send · Shift + Enter for a new line</div>}
      </div>
    </>
  );

  // Desktop only: the right pane before anything is picked.
  const idlePane = (
    <>
      {paneHeader(<div className="flex-1" />)}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-3 px-8 bg-slate-50">
        <div className="w-14 h-14 rounded-full bg-white ring-1 ring-slate-200 flex items-center justify-center text-slate-400"><MessageSquare size={26} /></div>
        <div>
          <div className="text-[15px] font-semibold text-slate-800">Select a conversation</div>
          <div className="text-[13px] text-slate-500 mt-0.5">
            {unreadCount > 0 ? `${unreadCount} unread ${unreadCount === 1 ? 'conversation' : 'conversations'} on the left.` : 'Pick one on the left, or start a new one.'}
          </div>
        </div>
        <button type="button" onClick={startNew} className="inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-lg px-3.5 h-9 bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50">
          <SquarePen size={15} /> New message
        </button>
      </div>
    </>
  );

  return (
    // Pinned to the VISIBLE viewport (height + top offset) so the bottom composer
    // stays above the iOS keyboard instead of being hidden behind it.
    <div
      className="fixed inset-x-0 z-[1200] sm:bg-slate-900/40 flex justify-end overflow-hidden"
      style={{ top: vp.top || 0, height: vp.h ? vp.h : '100%' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-[400px] lg:max-w-[880px] bg-white h-full shadow-2xl flex min-h-0">
        {listPane}
        <section className={`${view === 'list' ? 'hidden lg:flex' : 'flex'} flex-1 min-w-0 flex-col min-h-0`}>
          {view === 'thread' && active ? threadPane : view === 'new' ? newPane : idlePane}
        </section>
      </div>
    </div>
  );
}

// A labeled contact section in the New Message picker. Renders nothing when empty.
function Section({ title, items, onPick, keyer }) {
  if (!items || !items.length) return null;
  return (
    <div>
      <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200 sticky top-0 z-[1]">{title}</div>
      {items.map((c) => <ContactRow key={keyer(c)} contact={c} onClick={onPick} />)}
    </div>
  );
}

function ContactRow({ contact, onClick, subtitle, forceName }) {
  const name = forceName || contact.name;
  const sub = subtitle || (contact.name ? fmtPhone(contact.phone) : '');
  return (
    <button type="button" onClick={() => onClick(contact)} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-3 border-b border-slate-100">
      <Avatar name={contact.name} group={contact.group} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-slate-900 truncate">{name || fmtPhone(contact.phone)}</span>
          {contact.group && contact.group !== 'customer' && <GroupChip group={contact.group} />}
        </div>
        {sub && <div className="text-[12px] text-slate-500 truncate tabular-nums">{sub}</div>}
      </div>
    </button>
  );
}
