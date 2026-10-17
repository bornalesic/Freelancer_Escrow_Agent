// The live decision log: every state change with its deterministic title, and the AI's plain-language
// explanation typing in underneath. Newest at the bottom, auto-scrolls while the viewer is at the bottom.
import { useEffect, useRef, useState } from 'react';
import type { Actor, LogEvent } from '@escrow/shared';

// Inline SVG (24×24 outline) so icons render the same on every laptop, with or without emoji fonts.
const ICON_PATH: Record<Actor, string> = {
  client: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.1a7.5 7.5 0 0 1 15 0',
  freelancer: 'M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5',
  agent: 'M12 3l7.5 3v5.25c0 4.5-3.2 8.4-7.5 9.75-4.3-1.35-7.5-5.25-7.5-9.75V6L12 3Zm-3 9 2 2 4-4',
  ai: 'M9.8 15.9 9 18.75l-.8-2.85a4.5 4.5 0 0 0-3.1-3.1L2.25 12l2.85-.8a4.5 4.5 0 0 0 3.1-3.1L9 5.25l.8 2.85a4.5 4.5 0 0 0 3.1 3.1l2.85.8-2.85.8a4.5 4.5 0 0 0-3.1 3.1ZM18.25 8.5 18 9.75l-.25-1.25a3 3 0 0 0-2.25-2.25L14.25 6l1.25-.25a3 3 0 0 0 2.25-2.25L18 2.25l.25 1.25a3 3 0 0 0 2.25 2.25l1.25.25-1.25.25a3 3 0 0 0-2.25 2.25Z',
  verifier: 'm21 21-5.2-5.2M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z',
  wallet:
    'M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3',
  system: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2.25v2.5m0 14.5v2.5M4.6 4.6l1.8 1.8m11.2 11.2 1.8 1.8M2.25 12h2.5m14.5 0h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8',
};

const ACTOR: Record<Actor, { label: string; cls: string }> = {
  client: { label: 'Client', cls: 'bg-sky-100 text-sky-700' },
  freelancer: { label: 'Freelancer', cls: 'bg-indigo-100 text-indigo-700' },
  agent: { label: 'Escrow agent', cls: 'bg-slate-800 text-white' },
  ai: { label: 'QVAC', cls: 'bg-violet-100 text-violet-700' },
  verifier: { label: 'Verifier', cls: 'bg-amber-100 text-amber-700' },
  wallet: { label: 'Wallet', cls: 'bg-teal-100 text-teal-700' },
  system: { label: 'System', cls: 'bg-slate-100 text-slate-600' },
};

function ActorIcon({ actor }: { actor: Actor }) {
  const a = ACTOR[actor] ?? ACTOR.system;
  return (
    <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${a.cls}`} title={a.label} aria-label={a.label}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden>
        <path d={ICON_PATH[actor] ?? ICON_PATH.system} />
      </svg>
    </span>
  );
}

/** Accent for events that matter most to the story. */
function tone(e: LogEvent): string {
  if (e.type === 'error') return 'border-l-red-500 bg-red-50';
  if (e.type === 'decision.made') {
    const action = e.data?.action;
    if (action === 'release') return 'border-l-emerald-500 bg-emerald-50';
    if (action === 'refund') return 'border-l-orange-500 bg-orange-50';
    if (action === 'await_approval') return 'border-l-sky-500 bg-sky-50';
    return 'border-l-amber-500 bg-amber-50';
  }
  if (e.type === 'payout.settled' || e.type === 'funding.settled' || e.type === 'terms.agreed') {
    return 'border-l-emerald-500 bg-white';
  }
  if (e.type === 'refund.settled') return 'border-l-orange-500 bg-white';
  if (e.type === 'review.report_ready') return 'border-l-violet-500 bg-white';
  if (e.type === 'review.approved' || e.type === 'review.expired') return 'border-l-emerald-500 bg-white';
  if (e.type === 'review.disputed') return 'border-l-red-500 bg-red-50';
  if (e.type === 'verify.condition_result') return e.data?.passed === false ? 'border-l-red-400 bg-white' : 'border-l-slate-200 bg-white';
  return 'border-l-slate-200 bg-white';
}

/**
 * Reveals `text` progressively when it grows after mount (typewriter). Text already present on first
 * render (from a snapshot) shows at once, so a page reload doesn't replay the whole log.
 */
function useTypewriter(text: string): string {
  const [shown, setShown] = useState(text);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (!text.startsWith(shown)) {
      setShown(text); // replaced, not extended (e.g. final text differs from the streamed one)
      return;
    }
    if (shown.length >= text.length) return;
    const t = setTimeout(() => {
      // ~60 chars/s, catching up faster when far behind
      const step = Math.max(1, Math.ceil((target.current.length - shown.length) / 20));
      setShown(target.current.slice(0, shown.length + step));
    }, 16);
    return () => clearTimeout(t);
  }, [text, shown]);

  return shown;
}

export function Explanation({ event: e }: { event: LogEvent }) {
  const shown = useTypewriter(e.explanation ?? '');
  const done = e.explanationSource !== undefined;
  const typing = !done || shown.length < (e.explanation?.length ?? 0);

  if (!e.explanation) {
    return (
      <p className="mt-2 flex items-center gap-2 text-violet-700">
        <span className="inline-flex gap-1" aria-hidden>
          <span className="h-2 w-2 animate-bounce rounded-full bg-violet-500 [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-violet-500 [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-violet-500" />
        </span>
        <span className="text-lg">QVAC is explaining…</span>
      </p>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-3">
      <span
        className={`mt-1 shrink-0 rounded-full px-2.5 py-0.5 text-sm font-semibold ${
          e.explanationSource === 'template' ? 'bg-slate-200 text-slate-600' : 'bg-violet-600 text-white'
        }`}
      >
        {e.explanationSource === 'template' ? 'template' : 'QVAC · local'}
      </span>
      <p className="leading-snug text-slate-700">
        {shown}
        {typing && <span className="ml-0.5 inline-block h-[1em] w-[3px] translate-y-[3px] animate-pulse bg-violet-600" aria-hidden />}
      </p>
    </div>
  );
}

function EventRow({ event: e }: { event: LogEvent }) {
  return (
    <article className={`animate-[log-in_400ms_ease-out] rounded-xl border border-l-8 border-slate-200 px-5 py-4 shadow-sm ${tone(e)}`}>
      <div className="flex items-start gap-4">
        <ActorIcon actor={e.actor} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-2xl font-semibold leading-tight text-slate-900">{e.title}</span>
          </div>
          <div className="mt-0.5 flex gap-3 text-base text-slate-500">
            <span>{(ACTOR[e.actor] ?? ACTOR.system).label}</span>
            <time className="tabular-nums">{new Date(e.at).toLocaleTimeString()}</time>
          </div>
          {e.explain && <Explanation event={e} />}
        </div>
      </div>
    </article>
  );
}

export function DecisionLog({ events }: { events: LogEvent[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new content unless the viewer scrolled up
  const lastTop = useRef(0);

  // Any growth (new event, streamed tokens, typewriter) keeps the bottom in view while pinned.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !content.current) return;
    const follow = () => {
      if (pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };
    const ro = new ResizeObserver(follow);
    ro.observe(content.current);
    follow();
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={scroller}
      onScroll={(ev) => {
        const el = ev.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (atBottom) pinned.current = true;
        else if (el.scrollTop < lastTop.current) pinned.current = false; // only a scroll *up* unpins
        lastTop.current = el.scrollTop;
      }}
      className="h-full overflow-y-auto pr-2 text-xl"
      aria-live="polite"
    >
      <div ref={content} className="space-y-3">
        {events.length === 0 ? (
          <p className="py-10 text-center text-slate-400">Nothing has happened yet.</p>
        ) : (
          events.map((e) => <EventRow key={e.id} event={e} />)
        )}
      </div>
    </div>
  );
}
