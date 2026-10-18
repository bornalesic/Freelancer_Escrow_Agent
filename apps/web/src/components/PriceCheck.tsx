// Client, new agreement: QVAC sizes the job and code compares the offer and the deadline with typical
// ranges. Advice only, never blocks "Turn into checks".
import { useAssistResult } from '../lib/hooks';

const DEBOUNCE_MS = 1_200;

function duration(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  if (minutes < 21 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  return `${Math.round(minutes / (7 * 24 * 60))} weeks`;
}

export function PriceCheck({ title, rawText, amount, minutes, ticker }: { title: string; rawText: string; amount: string; minutes: string; ticker: string }) {
  const mins = Number(minutes);
  const ready = rawText.trim().length >= 20 && /^\d+(\.\d+)?$/.test(amount) && Number.isFinite(mins) && mins > 0;
  const body = ready ? { title: title.trim(), rawText: rawText.trim(), amountDisplay: amount, assetTicker: ticker, deadlineMinutes: mins } : null;
  const r = useAssistResult('estimate', body, body ? JSON.stringify(body) : null, DEBOUNCE_MS);

  if (!ready || r.unavailable) return null;
  if (!r.data) return <p className="text-sm text-slate-400">QVAC is checking the price and the deadline…</p>;
  const { size, reason, amount: a, minutes: m, warnings } = r.data;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-slate-500" title={reason}>
        QVAC: typical for a <span className="font-medium text-slate-700">{size}</span> job is {a.low}–{a.high} {ticker} and {duration(m.low)}–
        {duration(m.high)}.
      </p>
      {warnings.map((w) => (
        <p key={w} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-900">
          {w}
        </p>
      ))}
    </div>
  );
}
