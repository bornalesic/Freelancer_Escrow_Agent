// Freelancer team: QVAC suggests who takes which condition of this job, from each member's skills.
import { useState } from 'react';
import type { Escrow, SplitResult } from '@escrow/shared';
import { assist, isUnavailable } from '../lib/assist';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

interface Member {
  name: string;
  skills: string;
}

const MAX_MEMBERS = 6;

const field = 'min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-900 focus:outline-none';

export function TeamSplit({ escrow }: { escrow: Escrow }) {
  const [members, setMembers] = useState<Member[]>([{ name: '', skills: '' }, { name: '', skills: '' }]);
  const [result, setResult] = useState<SplitResult>();
  const [off, setOff] = useState<string>();

  const filled = members.map((m) => ({ name: m.name.trim(), skills: m.skills.trim() })).filter((m) => m.name && m.skills);
  const names = new Set(filled.map((m) => m.name));

  const split = useAction(async () => {
    try {
      setResult(await assist('split', { title: escrow.title, rawText: escrow.rawText, conditions: escrow.conditions, members: filled }));
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      setOff(err.message);
    }
  });

  const set = (i: number, patch: Partial<Member>) => {
    setMembers((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setResult(undefined);
  };

  if (escrow.conditions.length === 0) return null;
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer font-semibold text-slate-800">Split this job with my team</summary>
      <div className="mt-3 space-y-3">
        {members.map((m, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-2">
            <input className={field} placeholder="Name" value={m.name} maxLength={60} onChange={(e) => set(i, { name: e.target.value })} />
            <input className={field} placeholder="Skills, e.g. JavaScript, testing" value={m.skills} maxLength={500} onChange={(e) => set(i, { skills: e.target.value })} />
            <button
              type="button"
              onClick={() => setMembers((list) => list.filter((_, j) => j !== i))}
              disabled={members.length <= 2}
              className="rounded-lg px-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
              aria-label={`Remove ${m.name || 'member'}`}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {members.length < MAX_MEMBERS && (
            <button type="button" onClick={() => setMembers((list) => [...list, { name: '', skills: '' }])} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              + Add member
            </button>
          )}
          <button
            type="button"
            onClick={() => void split.run()}
            disabled={split.busy || filled.length < 2 || names.size < filled.length || !!off}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {split.busy ? 'Asking QVAC…' : 'Suggest who does what'}
          </button>
          {names.size < filled.length && <span className="text-sm text-amber-700">Give every member a different name.</span>}
        </div>
        {off && <p className="text-sm text-slate-500">{off}</p>}
        {split.error && <ErrorBanner>{split.error}</ErrorBanner>}
        {result && (
          <ul className="space-y-2">
            {result.assignments.map((a) => (
              <li key={a.member} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="font-semibold text-slate-900">{a.member}</p>
                {a.conditionIds.length > 0 && (
                  <ul className="ml-4 list-disc text-sm text-slate-700">
                    {a.conditionIds.map((id) => (
                      <li key={id}>{escrow.conditions.find((c) => c.id === id)?.description ?? id}</li>
                    ))}
                  </ul>
                )}
                <p className="text-sm text-slate-500">{a.note}</p>
              </li>
            ))}
            <li className="text-xs text-slate-400">{result.source === 'ai' ? 'QVAC suggestion' : 'Suggestion by keyword match (QVAC unavailable)'} · your team decides.</li>
          </ul>
        )}
      </div>
    </details>
  );
}
