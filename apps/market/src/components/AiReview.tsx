// QVAC's advisory report on the requirements only the client can judge. Advice for a person: the
// payment decision never reads it.
import type { Condition, Delivery, ReviewOpinion } from '@escrow/shared';
import { Pill, Spinner } from './ui';

const OPINION: Record<ReviewOpinion, { label: string; tone: 'green' | 'orange' | 'grey' }> = {
  looks_met: { label: 'Looks met', tone: 'green' },
  looks_unmet: { label: 'Looks unmet', tone: 'orange' },
  unsure: { label: 'Unsure', tone: 'grey' },
};

export function AiReview({ conditions, delivery }: { conditions: readonly Condition[]; delivery: Delivery }) {
  const reviewed = conditions.filter((c) => c.kind === 'client_review');
  if (reviewed.length === 0) return null;
  const review = delivery.review;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Written by QVAC, the local AI, from the delivered files. It is advice for you: only your answer decides.
        {review?.source === 'template' && ' The AI was unavailable, so every item says "unsure".'}
      </p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-fuchsia-100 bg-fuchsia-50/40">
        {reviewed.map((c) => {
          const item = review?.items.find((i) => i.conditionId === c.id);
          return (
            <li key={c.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">{c.description}</p>
                {item ? <Pill tone={OPINION[item.opinion].tone}>{OPINION[item.opinion].label}</Pill> : <Spinner className="text-fuchsia-500" />}
              </div>
              <p className="mt-1 text-sm text-slate-600">{item ? item.note : 'QVAC is reading the delivery…'}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
