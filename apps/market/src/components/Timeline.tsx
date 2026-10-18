// The live decision log: every state change, titled by code, with QVAC's plain-language explanation
// streaming in underneath.
import type { Actor, LogEvent } from '@escrow/shared';
import { displayText, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';

const ACTOR: Record<Actor, { label: string; dot: string }> = {
  client: { label: 'Client', dot: 'bg-sky-500' },
  freelancer: { label: 'Freelancer', dot: 'bg-violet-500' },
  agent: { label: 'Escrow service', dot: 'bg-indigo-600' },
  ai: { label: 'QVAC (local AI)', dot: 'bg-fuchsia-500' },
  verifier: { label: 'Checker', dot: 'bg-teal-500' },
  wallet: { label: 'RGB wallet', dot: 'bg-amber-500' },
  system: { label: 'System', dot: 'bg-slate-400' },
};

export function Timeline({ events, limit, large = false }: { events: readonly LogEvent[]; limit?: number; large?: boolean }) {
  const now = useNow(15_000);
  const shown = [...events].reverse().slice(0, limit);
  if (shown.length === 0) return <p className="text-sm text-slate-500">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-4">
      {shown.map((e) => {
        const actor = ACTOR[e.actor];
        return (
          <li key={e.id} className="event-in flex gap-3">
            <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${actor.dot}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={`font-medium text-slate-900 ${large ? 'text-lg' : 'text-sm'}`}>{displayText(e.title)}</p>
                <time dateTime={e.at} title={new Date(e.at).toLocaleString()} className="text-xs text-slate-400">
                  {actor.label} · {relativeTime(e.at, now)}
                </time>
              </div>
              {e.explanation ? (
                <p className={`mt-1 text-slate-600 ${large ? 'text-base' : 'text-sm'}`}>
                  {displayText(e.explanation)}
                  {e.explanationSource === 'ai' && (
                    <span className="ml-2 rounded bg-fuchsia-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-700">
                      QVAC
                    </span>
                  )}
                </p>
              ) : (
                e.explain && <p className="mt-1 text-sm italic text-slate-400">QVAC is explaining…</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
