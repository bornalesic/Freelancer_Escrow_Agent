// Building blocks shared by the client and freelancer screens: the fee breakdown, a job row, the job header.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { SERVICE_FEE_PERCENT, escrowTotal, serviceFee, type ConfigResponse, type Escrow } from '@escrow/shared';
import { automaticCount, displayText, money, openOffers, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { StateBadge } from './ui';

export function FeeBreakdown({ reward, asset, spendable }: { reward: string; asset: ConfigResponse; spendable?: string | undefined }) {
  const fee = serviceFee(reward);
  const total = escrowTotal({ amount: reward, fee });
  const short = spendable !== undefined && BigInt(spendable) < BigInt(total);
  return (
    <dl className="space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
      <div className="flex justify-between">
        <dt className="text-slate-600">Reward to the freelancer</dt>
        <dd className="tabular-nums">{money(reward, asset)}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-slate-600">Service fee ({SERVICE_FEE_PERCENT}%, kept only if the work is paid)</dt>
        <dd className="tabular-nums">{money(fee, asset)}</dd>
      </div>
      <div className="flex justify-between border-t border-slate-200 pt-1.5 font-semibold">
        <dt>Held in escrow when a freelancer takes it</dt>
        <dd className="tabular-nums">{money(total, asset)}</dd>
      </div>
      {spendable !== undefined && (
        <div className={`flex justify-between pt-1 text-xs ${short ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
          <dt>{short ? 'Not enough in your wallet' : 'Your balance'}</dt>
          <dd className="tabular-nums">{money(spendable, asset)}</dd>
        </div>
      )}
    </dl>
  );
}

export function JobRow({ escrow, to, asset, aside, showFee = false }: { escrow: Escrow; to: string; asset: ConfigResponse | undefined; aside?: ReactNode; showFee?: boolean }) {
  const now = useNow(30_000);
  const auto = automaticCount(escrow);
  const review = escrow.conditions.length - auto;
  const offers = escrow.state === 'OPEN' ? openOffers(escrow, now).length : 0;
  return (
    <Link to={to} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{escrow.title}</p>
          <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{displayText(escrow.summary ?? escrow.rawText)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold tabular-nums text-slate-900">{asset ? money(showFee ? escrowTotal(escrow) : escrow.amount, asset) : '…'}</p>
          <StateBadge state={escrow.state} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>Due {relativeTime(escrow.deadline, now)}</span>
        {escrow.conditions.length > 0 && (
          <span>
            {auto} automatic check{auto === 1 ? '' : 's'}
            {review > 0 && ` · ${review} client review`}
          </span>
        )}
        {offers > 0 && <span>{offers} counteroffer{offers === 1 ? '' : 's'}</span>}
        {aside}
      </div>
    </Link>
  );
}

export function JobHeader({ escrow, asset, children }: { escrow: Escrow; asset: ConfigResponse | undefined; children?: ReactNode }) {
  const now = useNow(30_000);
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{escrow.title}</h1>
          <StateBadge state={escrow.state} large />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Reward <strong className="text-slate-800">{asset ? money(escrow.amount, asset) : '…'}</strong> · due{' '}
          <span title={new Date(escrow.deadline).toLocaleString()}>{relativeTime(escrow.deadline, now)}</span>
        </p>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
