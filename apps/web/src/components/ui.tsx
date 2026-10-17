import { useEffect, useState, type ReactNode } from 'react';
import type { EscrowState } from '@escrow/shared';

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800">
      {children}
    </div>
  );
}

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>}
      {children}
    </section>
  );
}

const STATE_STYLE: Record<EscrowState, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PROPOSED: 'bg-sky-100 text-sky-800',
  AGREED: 'bg-indigo-100 text-indigo-800',
  AWAITING_FUNDS: 'bg-amber-100 text-amber-800',
  FUNDED: 'bg-teal-100 text-teal-800',
  DELIVERED: 'bg-violet-100 text-violet-800',
  VERIFYING: 'bg-violet-100 text-violet-800',
  AWAITING_APPROVAL: 'bg-sky-600 text-white',
  RELEASING: 'bg-emerald-100 text-emerald-800',
  RELEASED: 'bg-emerald-600 text-white',
  REFUNDING: 'bg-orange-100 text-orange-800',
  REFUNDED: 'bg-orange-600 text-white',
  CANCELLED: 'bg-slate-300 text-slate-700',
};

const STATE_LABEL: Record<EscrowState, string> = {
  DRAFT: 'Reading agreement',
  PROPOSED: 'Terms proposed',
  AGREED: 'Agreed',
  AWAITING_FUNDS: 'Waiting for funds',
  FUNDED: 'Funded',
  DELIVERED: 'Delivered',
  VERIFYING: 'Checking work',
  AWAITING_APPROVAL: 'Awaiting approval',
  RELEASING: 'Paying freelancer',
  RELEASED: 'Paid',
  REFUNDING: 'Refunding client',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

export function StateChip({ state, large = false }: { state: EscrowState; large?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ${STATE_STYLE[state]} ${large ? 'px-4 py-1.5 text-lg' : 'px-2.5 py-0.5 text-xs'}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-slate-500">{children}</p>;
}

export function Countdown({
  deadline,
  format = (t) => `${t} left`,
  expired = 'Deadline passed',
}: {
  deadline: string;
  format?: (time: string) => string;
  expired?: string;
}) {
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
      {left === 0 ? expired : format(`${m}:${String(s).padStart(2, '0')}`)}
    </span>
  );
}

/** Time left for the client to answer a review; no answer releases the payment. */
export function ReviewCountdown({ dueAt }: { dueAt: string }) {
  return <Countdown deadline={dueAt} format={(t) => `Approves automatically in ${t}`} expired="Review time is up, approving…" />;
}

/** A number that briefly flashes and pops when it changes (balances moving on the projector). */
export function AnimatedAmount({ value }: { value: string }) {
  const [flash, setFlash] = useState(false);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setFlash(true);
  }
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1_200);
    return () => clearTimeout(t);
  }, [flash]);
  return (
    <span className={`inline-block rounded px-1 transition-all duration-700 ${flash ? 'scale-110 bg-amber-300/60' : 'scale-100 bg-transparent'}`}>
      {value}
    </span>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />;
}
