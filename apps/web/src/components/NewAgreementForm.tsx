// Client step 1: the job in plain language, the amount and a deadline. Before the agreement is sent, QVAC may
// ask up to 3 clarifying questions (skipped when it has none or the AI is unavailable). A price/deadline check
// runs while typing.
import { useState, type FormEvent } from 'react';
import { toBaseUnits, withInterviewAnswers, type ClarifyQuestion, type Escrow } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { useAgentConfig } from '../lib/agentConfig';
import { assist } from '../lib/assist';
import { saveClientToken } from '../lib/clientToken';
import { DEMO_AGREEMENT, REVIEW_AGREEMENT } from '../lib/demo';
import { useAction } from '../lib/hooks';
import { InterviewCard } from './Interview';
import { PriceCheck } from './PriceCheck';
import { ErrorBanner } from './ui';

const input =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

export function NewAgreementForm({ onCreated }: { onCreated: (escrow: Escrow) => void }) {
  const asset = useAgentConfig();
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('30');
  // The interview runs once per text: editing the title or the text asks again.
  const [interviewed, setInterviewed] = useState(false);
  const [questions, setQuestions] = useState<ClarifyQuestion[]>();
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setInterviewed(false);
    setQuestions(undefined);
  };

  const checkForm = () => {
    if (!asset) throw new Error('Still loading the asset settings from the agent.');
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error('Deadline must be a positive number of minutes.');
    return { amount: toBaseUnits(amount, asset.precision), deadline: new Date(Date.now() + mins * 60_000).toISOString() };
  };

  const createWith = async (text: string) => {
    const { clientToken, ...escrow } = await agentApi.createEscrow({ title: title.trim(), rawText: text.trim(), ...checkForm() });
    if (clientToken) saveClientToken(escrow.id, clientToken); // returned only here, needed to approve
    onCreated(escrow);
  };

  const create = useAction(async () => {
    checkForm();
    if (!interviewed) {
      // Advice only: any failure (agent without the route, AI down, timeout) means "no questions".
      const qs = await assist('clarify', { title: title.trim(), rawText: rawText.trim() }).then((r) => r.questions, () => []);
      setInterviewed(true);
      if (qs.length) {
        setQuestions(qs);
        setAnswers({});
        return;
      }
    }
    await createWith(rawText);
  });

  const sendAnswers = useAction(async () => {
    const merged = withInterviewAnswers(
      rawText.trim(),
      (questions ?? []).map((q) => ({ topic: q.topic, answer: answers[q.id] ?? '' })),
    );
    setRawText(merged); // the client sees exactly what is sent and agreed
    setQuestions(undefined);
    await createWith(merged);
  });

  const skip = useAction(async () => {
    setQuestions(undefined);
    await createWith(rawText);
  });

  const paste = (a: typeof DEMO_AGREEMENT) => {
    setTitle(a.title);
    setRawText(a.rawText);
    setAmount(a.amount);
    setMinutes(String(a.deadlineMinutes));
    setInterviewed(false);
    setQuestions(undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run();
  };

  const busy = create.busy || sendAnswers.busy || skip.busy;
  const error = create.error ?? sendAnswers.error ?? skip.error;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">New agreement</h1>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => paste(DEMO_AGREEMENT)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100">
            Paste demo agreement
          </button>
          <button type="button" onClick={() => paste(REVIEW_AGREEMENT)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100">
            Paste review demo
          </button>
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Job title</span>
        <input className={input} value={title} onChange={(e) => edit(setTitle)(e.target.value)} required maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">What should be delivered? Write it in plain language.</span>
        <textarea className={`${input} min-h-40`} value={rawText} onChange={(e) => edit(setRawText)(e.target.value)} required />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Amount ({asset?.assetTicker ?? 'USDT'})</span>
          <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" pattern="\d+(\.\d+)?" required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Deadline (minutes from now)</span>
          <input className={input} value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" pattern="\d+" required />
        </label>
      </div>
      <PriceCheck title={title} rawText={rawText} amount={amount} minutes={minutes} ticker={asset?.assetTicker ?? 'USDT'} />
      {questions ? (
        <InterviewCard
          questions={questions}
          answers={answers}
          onAnswer={(id, a) => setAnswers((s) => ({ ...s, [id]: a }))}
          onUse={() => void sendAnswers.run()}
          onSkip={() => void skip.run()}
          busy={busy}
        />
      ) : (
        <button
          type="submit"
          disabled={busy || !asset}
          className="rounded-lg bg-slate-900 px-6 py-3 text-lg font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {create.busy ? (interviewed ? 'Sending…' : 'QVAC is reading your agreement…') : 'Turn into checks'}
        </button>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <p className="text-sm text-slate-500">A local AI (QVAC) proposes checks. Nothing moves until both of you accept them.</p>
    </form>
  );
}
