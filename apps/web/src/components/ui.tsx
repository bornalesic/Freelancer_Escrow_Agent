import type { ReactNode } from 'react';
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
