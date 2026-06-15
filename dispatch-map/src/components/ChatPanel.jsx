// src/components/ChatPanel.jsx
//
// M6 — AI chat panel. A collapsible assistant the dispatcher opens from the
// toolbar (desktop) or a FAB-style button (mobile). It asks questions about the
// currently-loaded board; the server answers using only the trimmed stop set and
// returns MATCHED_PRO_IDS, which the parent highlights on the map + list.
//
// The panel owns its own conversation history + busy/error state. The parent
// supplies:
//   onSend(query)   async → { answer, matchedProIds, truncated, sent, total } | throws({code})
//   onHighlight(ids) — push referenced stopNbr ids into the shared filter set
//   onClear()        — clear the active AI highlight
//   highlightActive  — whether an AI highlight is currently applied
//   stopCount        — number of currently-loaded stops (shown as scope hint)

import { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Send, Sparkles } from 'lucide-react';

const BRAND = '#1e5b92';

export default function ChatPanel({ open, onClose, onSend, onHighlight, onClear, highlightActive, stopCount }) {
  const [messages, setMessages] = useState([]); // { role:'user'|'assistant', text, meta? }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  if (!open) return null;

  const submit = async () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const res = await onSend(q);
      const ids = Array.isArray(res?.matchedProIds) ? res.matchedProIds : [];
      setMessages((m) => [...m, {
        role: 'assistant',
        text: res?.answer || '(no answer)',
        meta: { count: ids.length, truncated: res?.truncated, sent: res?.sent, total: res?.total },
      }]);
      if (ids.length) onHighlight(ids);
    } catch (e) {
      const code = e?.code || 'ai_unavailable';
      setError(
        code === 'ai_key_missing'
          ? 'AI is not configured yet (missing API key). Ask Chad to set ANTHROPIC_API_KEY.'
          : 'The assistant is unavailable right now. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed z-[40] bg-white border border-slate-200 shadow-2xl flex flex-col
                 inset-x-0 bottom-0 rounded-t-2xl max-h-[80vh]
                 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[380px] sm:h-[560px] sm:max-h-[80vh] sm:rounded-2xl"
      role="dialog"
      aria-label="AI assistant"
    >
      {/* header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ color: BRAND }}>
        <Sparkles size={16} />
        <div className="font-semibold text-sm flex-1">Ask about the board</div>
        {highlightActive && (
          <button
            onClick={onClear}
            className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 min-h-[32px]"
          >
            Clear highlight
          </button>
        )}
        <button
          onClick={onClose}
          className="p-2 rounded hover:bg-slate-100 text-slate-500 min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Close chat"
        >
          <X size={18} />
        </button>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="text-xs text-slate-500 space-y-2">
            <p>Ask about the {stopCount} stops loaded for this day. For example:</p>
            <ul className="space-y-1">
              {['Which stops are closed Fridays?', 'Any liftgate deliveries in Marietta?', 'What needs an appointment before 9am?'].map((ex) => (
                <li key={ex}>
                  <button
                    onClick={() => setDraft(ex)}
                    className="text-left underline decoration-dotted hover:text-slate-700"
                    style={{ color: BRAND }}
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                'max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ' +
                (m.role === 'user' ? 'text-white rounded-br-sm' : 'bg-slate-100 text-slate-800 rounded-bl-sm')
              }
              style={m.role === 'user' ? { background: BRAND } : undefined}
            >
              {m.text}
              {m.role === 'assistant' && m.meta && (
                <div className="mt-1.5 text-[10px] text-slate-500">
                  {m.meta.count > 0 ? `Highlighted ${m.meta.count} stop${m.meta.count === 1 ? '' : 's'} on the map.` : 'No matching stops to highlight.'}
                  {m.meta.truncated ? ` Answer covers the first ${m.meta.sent} of ${m.meta.total} loaded stops.` : ''}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-slate-100 text-slate-500 rounded-2xl rounded-bl-sm px-3 py-2 text-sm inline-flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '120ms' }} />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '240ms' }} />
              <span className="ml-1">thinking…</span>
            </div>
          </div>
        )}
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">{error}</div>}
      </div>

      {/* composer */}
      <div className="border-t p-2 flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          rows={1}
          placeholder="Ask a question…"
          className="flex-1 resize-none border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 max-h-28"
          aria-label="Ask the assistant a question"
        />
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="rounded-xl text-white disabled:opacity-40 flex items-center justify-center min-w-[44px] min-h-[44px]"
          style={{ background: BRAND }}
          aria-label="Send"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

// Floating button that opens the chat panel. Reused on desktop (toolbar column)
// and mobile (FAB). 44px min touch target.
export function ChatLauncher({ onClick, active }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full shadow-lg text-white flex items-center justify-center w-12 h-12"
      style={{ background: active ? '#16a34a' : BRAND }}
      aria-label="Open AI assistant"
      title="Ask AI about the board"
    >
      <MessageSquare size={20} />
    </button>
  );
}
