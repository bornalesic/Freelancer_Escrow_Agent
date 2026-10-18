// "Under the hood": how this job's money moves on RGB, for people who want to see it (and open on the
// projector). The everyday screens never need any of this.
import type { ConfigResponse, Escrow, LogEvent } from '@escrow/shared';
import { displayTicker, frozen, money, rgbTrail } from '../lib/format';
import { Mono } from './ui';

export function RgbPanel({ escrow, events, asset, open = false }: { escrow: Escrow; events: readonly LogEvent[]; asset: ConfigResponse | undefined; open?: boolean }) {
  const steps = rgbTrail(escrow, events);
  const done = steps.filter((s) => s.done).length;
  return (
    <details open={open} className="group rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50/70 to-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="font-semibold text-slate-900">
            <span className="mr-2" aria-hidden>₿</span>Under the hood: RGB on Bitcoin
          </p>
          <p className="text-xs text-slate-500">
            {done} of {steps.length} steps · {asset ? `${displayTicker(asset.assetTicker)} on Bitcoin ${asset.network}` : 'loading…'}
          </p>
        </div>
        <span className="text-sm text-amber-700 group-open:rotate-180" aria-hidden>▾</span>
      </summary>

      <div className="space-y-4 border-t border-amber-100 px-5 pb-5 pt-4">
        <p className="text-sm text-slate-600">
          tUSDT is an <strong>RGB asset</strong>: a token whose rules and balances live in the wallets that hold it,
          with every transfer anchored in a Bitcoin transaction. Nobody else sees who holds how much. The escrow service
          holds this job's money in its own <strong>Tether WDK</strong> RGB wallet and pays it out by code, never by the AI.
        </p>

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Asset id (the RGB contract)</dt>
            <dd><Mono value={escrow.assetId} keep={12} /></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{frozen(escrow) !== '0' ? 'Held in escrow for this job' : 'This job (not held right now)'}</dt>
            <dd className="text-slate-900">
              {asset ? money(escrow.amount, asset) : '…'} reward + {asset ? money(escrow.fee ?? '0', asset) : '…'} fee
            </dd>
          </div>
        </dl>

        <ol className="relative space-y-4 border-l-2 border-amber-200 pl-5">
          {steps.map((s) => (
            <li key={s.title} className="relative">
              <span
                className={`absolute -left-[27px] top-0.5 flex size-4 items-center justify-center rounded-full text-[10px] ${s.done ? 'bg-amber-500 text-white' : 'border-2 border-amber-200 bg-white'}`}
                aria-hidden
              >
                {s.done && '✓'}
              </span>
              <p className={`text-sm font-medium ${s.done ? 'text-slate-900' : 'text-slate-400'}`}>{s.title}</p>
              <p className={`text-xs ${s.done ? 'text-slate-600' : 'text-slate-400'}`}>{s.detail}</p>
              {(s.value || s.status) && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {s.value && <Mono value={s.value} />}
                  {s.status && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">rgb-lib: {s.status}</span>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
