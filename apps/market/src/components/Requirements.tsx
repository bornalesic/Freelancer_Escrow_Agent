// The job's acceptance requirements, each marked: checked automatically by the system, or judged by the client.
import type { Condition } from '@escrow/shared';
import { conditionInfo } from '../lib/format';
import { Pill } from './ui';

export function Requirements({ conditions, compact = false }: { conditions: readonly Condition[]; compact?: boolean }) {
  if (conditions.length === 0) return <p className="text-sm text-slate-500">No requirements yet.</p>;
  const auto = conditions.filter((c) => conditionInfo(c).automatic).length;
  return (
    <div className="space-y-3">
      {!compact && (
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{auto} of {conditions.length}</span> checked automatically by the system
          {auto < conditions.length && <>, the rest you judge yourself</>}.
        </p>
      )}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {conditions.map((c) => {
          const info = conditionInfo(c);
          return (
            <li key={c.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`mt-0.5 text-lg leading-none ${info.automatic ? 'text-teal-600' : 'text-amber-600'}`} aria-hidden>
                {info.automatic ? '⚙' : '👁'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">{c.description}</p>
                {!compact && info.detail && <p className="mt-0.5 text-xs text-slate-500">{info.detail}</p>}
              </div>
              <Pill tone={info.automatic ? 'green' : 'amber'}>{info.automatic ? 'Automatic check' : 'Client review'}</Pill>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
