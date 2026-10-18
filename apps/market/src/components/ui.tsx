import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { EscrowState } from '@escrow/shared';
import { STATE_LABEL, STATE_TONE, isSettling, money, shorten, type AssetDisplay, type Tone } from '../lib/format';

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} />;
}

const TONE: Record<Tone, string> = {
  grey: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  orange: 'bg-orange-50 text-orange-800 ring-orange-200',
};

export function StateBadge({ state, large = false }: { state: EscrowState; large?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ring-1 ring-inset ${TONE[STATE_TONE[state]]} ${large ? 'px-4 py-1.5 text-base' : 'px-2.5 py-0.5 text-xs'}`}>
      {(isSettling(state) || state === 'VERIFYING' || state === 'DELIVERED' || state === 'DRAFT') && <Spinner className="size-2.5" />}
      {STATE_LABEL[state]}
      {isSettling(state) && <span className="font-normal opacity-70">· confirming</span>}
    </span>
  );
}

export function Pill({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]}`}>{children}</span>;
}

export function Money({ units, asset, className = '' }: { units: string | bigint; asset: AssetDisplay | undefined; className?: string }) {
  return <span className={`tabular-nums ${className}`}>{asset ? money(units, asset) : '…'}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

export function Notice({ tone = 'blue', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-xl px-4 py-3 text-sm ring-1 ring-inset ${TONE[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-slate-500">{children}</p>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

/** A long invoice or txid: shortened, full value on hover, one click to copy. */
export function Mono({ value, keep = 10 }: { value: string; keep?: number }) {
  const [copied, setCopied] = useState(false);
  const short = shorten(value, keep);
  return (
    <button
      type="button"
      title={`${value}\n(click to copy)`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        });
      }}
      className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-200"
    >
      {copied ? 'copied' : short}
    </button>
  );
}
