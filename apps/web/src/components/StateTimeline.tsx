// The escrow's path through the state machine (docs/ESCROW_FLOW.md), as a list of plain-English steps.
import type { EscrowState } from '@escrow/shared';

interface Step {
  label: string;
  /** States in which this step is the current one. */
  states: EscrowState[];
}

const STEPS: Step[] = [
  { label: 'Agreement written', states: ['DRAFT'] },
  { label: 'Terms proposed', states: ['PROPOSED'] },
  { label: 'Both agreed', states: ['AGREED'] },
  { label: 'Money locked', states: ['AWAITING_FUNDS', 'FUNDED'] },
  { label: 'Work checked', states: ['DELIVERED', 'VERIFYING'] },
  { label: 'Freelancer paid', states: ['RELEASING', 'RELEASED'] },
];

// Only for terms with a client_review condition: the client approves after the automatic checks.
const REVIEW_STEP: Step = { label: 'Client approved', states: ['AWAITING_APPROVAL'] };

const REFUND_STEP: Step = { label: 'Client refunded', states: ['REFUNDING', 'REFUNDED'] };
const CANCEL_STEP: Step = { label: 'Cancelled', states: ['CANCELLED'] };

const DONE: EscrowState[] = ['RELEASED', 'REFUNDED', 'CANCELLED'];

export function StateTimeline({ state, review = false, large = false }: { state: EscrowState; review?: boolean; large?: boolean }) {
  const happy = review ? [...STEPS.slice(0, 5), REVIEW_STEP, STEPS[5]] : STEPS;
  const steps =
    state === 'REFUNDING' || state === 'REFUNDED'
      ? [...STEPS.slice(0, 4), REFUND_STEP]
      : state === 'CANCELLED'
        ? [...STEPS.slice(0, 2), CANCEL_STEP]
        : happy;
  const current = steps.findIndex((s) => s.states.includes(state));
  const finished = DONE.includes(state);
  // Waiting for money (AWAITING_FUNDS) is the "Money locked" step in progress; FUNDED completes it.
  const currentDone = finished || state === 'FUNDED';

  return (
    <ol className={`space-y-1 ${large ? 'text-xl' : 'text-sm'}`}>
      {steps.map((s, i) => {
        const done = i < current || (i === current && currentDone);
        const active = i === current && !currentDone;
        const failed = i === current && state === 'CANCELLED';
        return (
          <li key={s.label} className="flex items-center gap-3 py-1">
            <span
              className={`flex shrink-0 items-center justify-center rounded-full font-bold ${large ? 'h-8 w-8 text-base' : 'h-6 w-6 text-xs'} ${
                failed
                  ? 'bg-slate-400 text-white'
                  : done
                    ? 'bg-emerald-500 text-white'
                    : active
                      ? 'animate-pulse bg-sky-500 text-white'
                      : 'bg-slate-200 text-slate-500'
              }`}
            >
              {failed ? '×' : done ? '✓' : i + 1}
            </span>
            <span className={done || active ? 'font-semibold text-slate-900' : 'text-slate-400'}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
