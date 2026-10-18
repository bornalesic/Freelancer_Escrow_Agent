// "2 of 3 checked automatically": how much of the agreement the verifier checks without anyone's judgement.
import { verifiability } from '@escrow/shared';

export function VerifiabilityBadge({ conditions, compact = false }: { conditions: { kind: string }[]; compact?: boolean }) {
  const { automatic, total } = verifiability(conditions);
  if (!total) return null;
  const all = automatic === total;
  const tone = all ? 'bg-emerald-100 text-emerald-800' : automatic === 0 ? 'bg-slate-100 text-slate-600' : 'bg-sky-100 text-sky-800';
  const title = `${automatic} checked automatically by the agent, ${total - automatic} judged by the client.`;
  if (compact) {
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${tone}`} title={title}>
        {automatic}/{total} automatic
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${tone}`} title={title}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-2 w-2 rounded-full ${i < automatic ? 'bg-current' : 'bg-current opacity-25'}`} />
        ))}
      </span>
      {automatic} of {total} checked automatically
    </span>
  );
}
