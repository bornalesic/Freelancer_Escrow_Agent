import { useEffect, useState } from 'react';
import { formatAmount, type Condition, type Escrow } from '@escrow/shared';
import { StateChip } from './ui';

export function conditionLabel(c: Condition): string {
  switch (c.kind) {
    case 'tests_pass':
      return `Tests pass — ${c.command}`;
    case 'file_present':
      return `File present — ${c.pathPattern}`;
    case 'file_hash':
      return `File matches hash — ${c.fileName ?? 'whole upload'} · ${c.sha256.slice(0, 8)}…`;
  }
}

export function Countdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Date.parse(deadline) - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1_000);
  return (
    <span className={`tabular-nums ${left === 0 ? 'text-red-600' : ''}`}>
      {left === 0 ? 'Deadline passed' : `${m}:${String(s).padStart(2, '0')} left`}
    </span>
  );
}

export function EscrowSummary({ escrow }: { escrow: Escrow }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{escrow.title}</h1>
        <StateChip state={escrow.state} />
      </div>
      <p className="text-slate-600">
        <span className="font-semibold text-slate-900">
          {formatAmount(escrow.amount, escrow.precision)} {escrow.assetTicker}
        </span>{' '}
        · <Countdown deadline={escrow.deadline} />
      </p>
      {escrow.summary && <p className="text-slate-700">{escrow.summary}</p>}
      {escrow.conditions.length > 0 && (
        <ul className="space-y-1">
          {escrow.conditions.map((c) => (
            <li key={c.id} className="font-mono text-sm text-slate-700">
              {c.id} · {conditionLabel(c)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
