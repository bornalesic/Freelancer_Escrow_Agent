// Client, new agreement: QVAC's clarifying questions before the text is turned into checks. The answers are
// appended to the agreement as "Details" lines (withInterviewAnswers), so both sides agree to them.
import type { ClarifyQuestion } from '@escrow/shared';

export function InterviewCard({
  questions,
  answers,
  onAnswer,
  onUse,
  onSkip,
  busy,
}: {
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
  onAnswer: (id: string, answer: string) => void;
  onUse: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const answered = questions.filter((q) => answers[q.id]?.trim()).length;
  return (
    <div className="space-y-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
      <div>
        <h2 className="text-lg font-semibold text-violet-900">QVAC has {questions.length === 1 ? 'a question' : `${questions.length} questions`} first</h2>
        <p className="text-sm text-violet-800">Clear answers become precise checks. Answer what you can, or skip.</p>
      </div>
      {questions.map((q) => (
        <div key={q.id} className="space-y-2 rounded-lg bg-white p-3">
          <p className="font-medium text-slate-900">{q.question}</p>
          <p className="text-sm text-slate-500">{q.why}</p>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => onAnswer(q.id, answers[q.id] === o ? '' : o)}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    answers[q.id] === o ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600"
            placeholder={q.options.length ? 'Or write your own answer' : 'Your answer'}
            value={answers[q.id] ?? ''}
            onChange={(e) => onAnswer(q.id, e.target.value)}
            maxLength={300}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onUse}
          disabled={busy || answered === 0}
          className="rounded-lg bg-violet-700 px-5 py-2.5 font-semibold text-white hover:bg-violet-600 disabled:opacity-50"
        >
          {busy ? 'Sending…' : `Add ${answered || ''} answer${answered === 1 ? '' : 's'} and turn into checks`}
        </button>
        <button type="button" onClick={onSkip} disabled={busy} className="rounded-lg px-4 py-2.5 font-medium text-slate-600 hover:bg-white disabled:opacity-50">
          Skip, use the text as written
        </button>
      </div>
    </div>
  );
}
