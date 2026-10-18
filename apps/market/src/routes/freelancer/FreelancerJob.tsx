import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AnswerResult, ConfigResponse, DryRunResponse, Escrow, LogEvent } from '@escrow/shared';
import { Checks } from '../../components/Checks';
import { JobHeader } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { MakeOffer } from '../../components/Offers';
import { Requirements } from '../../components/Requirements';
import { RgbPanel } from '../../components/RgbPanel';
import { Timeline } from '../../components/Timeline';
import { Work } from '../../components/Work';
import { Button, Card, Empty, ErrorText, Notice, inputClass } from '../../components/ui';
import { agentApi, partyApi } from '../../lib/api';
import { assist, dryRun, isUnavailable } from '../../lib/assist';
import { countdown, displayText, money } from '../../lib/format';
import { useAction, useMarket, useNow } from '../../lib/hooks';
import { freelancerToken, getToken, myOffers, saveTake } from '../../lib/session';

/** A payout invoice must outlive the checks and the client's review window. */
const PAYOUT_INVOICE_TTL_SEC = 7 * 24 * 3600;

function lastDecision(events: readonly LogEvent[]): string | undefined {
  const e = [...events].reverse().find((x) => x.type === 'decision.made');
  return e?.title.replace(/^Decision: /, '');
}

function AskAboutJob({ escrow }: { escrow: Escrow }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AnswerResult>();
  const [off, setOff] = useState(false);
  const ask = useAction(async () => {
    try {
      setAnswer(await assist('answer', {
        title: escrow.title,
        rawText: escrow.rawText,
        conditions: escrow.conditions,
        ...(escrow.clarifications ? { clarifications: escrow.clarifications } : {}),
        question: question.trim(),
      }));
    } catch (err) {
      if (isUnavailable(err)) setOff(true);
      else throw err;
    }
  });
  return (
    <Card title="Ask about this job">
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Which Node version? Can I use a library?" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && question.trim().length >= 3 && void ask.run()} />
        <Button variant="secondary" busy={ask.busy} disabled={question.trim().length < 3} onClick={() => void ask.run()}>Ask</Button>
      </div>
      {answer && (
        <div className="mt-3 text-sm">
          <p className="text-slate-800">{answer.answer}</p>
          {answer.quote && <p className="mt-1 border-l-2 border-slate-300 pl-2 text-xs italic text-slate-500">“{answer.quote}”</p>}
          {!answer.answered && <p className="mt-1 text-xs text-amber-700">The terms don't say. Only what is written here counts.</p>}
          <p className="mt-1 text-[11px] text-slate-400">Answered by QVAC from the job's terms.</p>
        </div>
      )}
      {off && <p className="mt-2 text-sm text-slate-500">The AI assistant is not available right now.</p>}
      <ErrorText>{ask.error}</ErrorText>
    </Card>
  );
}

function Listing({ escrow, asset, stale }: { escrow: Escrow; asset: ConfigResponse; stale: boolean }) {
  const [, setTaken] = useState(0);
  const take = useAction(async () => {
    if (!escrow.termsHash) return;
    const res = await agentApi.take(escrow.id, escrow.termsHash);
    const at = res.acceptances.find((a) => a.role === 'freelancer')?.at;
    if (at) saveTake(escrow.id, res.freelancerToken, at);
    setTaken((n) => n + 1);
  });
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        {stale && <Notice tone="amber" title="Back on the marketplace">The client's payment did not arrive in time, so the job was released. You can take it again{escrow.offers?.some((o) => o.status === 'accepted') ? ' (at the price that was agreed)' : ''}.</Notice>}
        <Card title="The job">
          {escrow.summary && <p className="mb-3 font-medium text-slate-800">{displayText(escrow.summary)}</p>}
          <p className="whitespace-pre-wrap text-sm text-slate-700">{escrow.rawText}</p>
        </Card>
        <Card title="How your work is accepted">
          <Requirements conditions={escrow.conditions} />
        </Card>
        <AskAboutJob escrow={escrow} />
      </div>
      <div className="space-y-4">
        <Card>
          <p className="text-sm text-slate-500">You get</p>
          <p className="text-3xl font-bold tabular-nums text-slate-900">{money(escrow.amount, asset)}</p>
          <ul className="mt-4 space-y-2 text-sm text-slate-600">
            <li>✓ The client's wallet locks the reward in escrow as soon as you take the job.</li>
            <li>✓ Start once it shows <strong>In progress</strong>: the money is then held for you.</li>
            <li>✓ When the checks pass{escrow.conditions.some((c) => c.kind === 'client_review') ? ' and the client approves (or does not answer in time)' : ''}, you are paid automatically.</li>
          </ul>
          <Button className="mt-5 w-full" busy={take.busy} disabled={!escrow.termsHash} onClick={() => void take.run()}>
            Take this job
          </Button>
          <ErrorText>{take.error}</ErrorText>
          <p className="mt-2 text-center text-xs text-slate-500">First freelancer to take it gets it.</p>
        </Card>
        <MakeOffer escrow={escrow} asset={asset} />
      </div>
    </div>
  );
}

function Deliver({ escrow, asset, token }: { escrow: Escrow; asset: ConfigResponse; token: string }) {
  const [file, setFile] = useState<File>();
  const [practice, setPractice] = useState<DryRunResponse>();
  const check = useAction(async () => {
    if (file) setPractice(await dryRun(escrow.id, file));
  });
  const send = useAction(async () => {
    if (!file) return;
    // The payout invoice comes from this laptop's own wallet: the agent pays it without asking anyone.
    const { invoice } = await partyApi('freelancer').invoice(escrow.assetId, escrow.amount, PAYOUT_INVOICE_TTL_SEC);
    await agentApi.deliver(escrow.id, file, invoice, token);
    setFile(undefined);
    setPractice(undefined);
  });
  return (
    <Card title="Send your work">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Upload one file, or a .zip of a folder. The system runs the automatic checks right away. Your wallet attaches a
          payout invoice for {money(escrow.amount, asset)} automatically.
        </p>
        <input
          type="file"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
          onChange={(e) => {
            setFile(e.target.files?.[0]);
            setPractice(undefined);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" busy={check.busy} disabled={!file || send.busy} onClick={() => void check.run()}>Practice check</Button>
          <Button busy={send.busy} disabled={!file || check.busy} onClick={() => void send.run()}>Send work</Button>
        </div>
        <ErrorText>{check.error ?? send.error}</ErrorText>
        {practice && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-900">
              Practice check: {practice.passed} of {practice.total} passed{' '}
              <span className="font-normal text-slate-500">(nothing was sent)</span>
            </p>
            <Checks conditions={escrow.conditions} results={practice.results} running={false} hints={practice.hints?.items} />
          </div>
        )}
      </div>
    </Card>
  );
}

function Status({ escrow, events, asset }: { escrow: Escrow; events: readonly LogEvent[]; asset: ConfigResponse }) {
  const now = useNow();
  const reward = money(escrow.amount, asset);
  const latest = escrow.deliveries.at(-1);
  switch (escrow.state) {
    case 'AGREED':
    case 'AWAITING_FUNDS':
      return (
        <Notice tone="amber" title="The job is yours. Waiting for the client's payment">
          Don't start yet: the reward is not locked.
          {escrow.fundingDueAt && <> If it has not arrived in <strong className="tabular-nums">{countdown(escrow.fundingDueAt, now)}</strong>, the job goes back to the marketplace.</>}
        </Notice>
      );
    case 'FUNDED':
      return latest ? (
        <Notice tone="orange" title={latest.approval?.decision === 'dispute' ? 'The client disputed your work' : `Version ${latest.n} did not pass`}>
          {latest.approval?.reason && <>“{latest.approval.reason}” </>}
          Fix it and send a new version before the deadline. The reward is still held for you.
        </Notice>
      ) : (
        <Notice tone="green" title="Start working: the reward is locked">{reward} is held in escrow for you. Send your work before the deadline.</Notice>
      );
    case 'DELIVERED':
    case 'VERIFYING':
      return <Notice tone="violet" title={`Checking version ${latest?.n ?? ''}`}>The system is running the automatic checks.</Notice>;
    case 'AWAITING_APPROVAL':
      return (
        <Notice tone="amber" title="All checks passed. The client is reviewing">
          {latest?.reviewDueAt && <>If the client does not answer in <strong className="tabular-nums">{countdown(latest.reviewDueAt, now)}</strong>, you are paid automatically.</>}
        </Notice>
      );
    case 'RELEASING':
      return <Notice tone="green" title="You are being paid">{reward} is on its way to your wallet. Waiting for the Bitcoin transaction to confirm.</Notice>;
    case 'RELEASED':
      return <Notice tone="green" title="Paid">{reward} is in your wallet.</Notice>;
    case 'REFUNDING':
    case 'REFUNDED':
      return <Notice tone="orange" title="The client was refunded">{lastDecision(events)}.</Notice>;
    case 'CANCELLED':
      return <Notice tone="grey" title="Cancelled">Nothing was paid. {lastDecision(events) ?? ''}</Notice>;
    default:
      return null;
  }
}

export function FreelancerJob() {
  const { id = '' } = useParams();
  const { jobs, asset, loaded } = useMarket();
  const view = jobs[id];

  if (!view || !asset) {
    return (
      <Layout role="freelancer">
        <Empty>{loaded && !view ? 'This job does not exist on the escrow service (it may have been reset).' : 'Loading…'}</Empty>
      </Layout>
    );
  }
  const { escrow, events } = view;
  const token = freelancerToken(escrow);
  const mine = token !== undefined;
  const offerStatus = (offerId: string) => escrow.offers?.find((o) => o.id === offerId)?.status;
  // Held it once (took it, or the client accepted this browser's offer), but the job went back on the marketplace.
  const hadIt = !mine && (getToken('freelancer', id) !== undefined || myOffers(id).some((m) => offerStatus(m.offerId) === 'accepted'));
  const outbid = !mine && myOffers(id).some((m) => offerStatus(m.offerId) === 'declined');

  return (
    <Layout role="freelancer">
      <div className="space-y-6">
        <JobHeader escrow={escrow} asset={asset} />
        {!mine && escrow.state === 'OPEN' && <Listing escrow={escrow} asset={asset} stale={hadIt} />}
        {!mine && escrow.state !== 'OPEN' && (
          <Notice tone="grey" title="No longer available">
            {hadIt
              ? 'The job went back to the marketplace and another freelancer took it.'
              : outbid
                ? 'The job went to another freelancer, so your offer was declined.'
                : 'Another freelancer took this job, or it was closed.'}{' '}
            <Link to="/freelancer" className="font-medium text-indigo-700 hover:underline">Find another job</Link>
          </Notice>
        )}
        {mine && token && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-6">
              <Status escrow={escrow} events={events} asset={asset} />
              {escrow.state === 'FUNDED' && <Deliver escrow={escrow} asset={asset} token={token} />}
              {escrow.deliveries.length > 0 && (
                <Card title="Your deliveries">
                  <Work escrow={escrow} token={token} viewer="freelancer" />
                </Card>
              )}
              <Card title="How your work is accepted">
                <Requirements conditions={escrow.conditions} />
              </Card>
              <Card title="The job">
                <p className="whitespace-pre-wrap text-sm text-slate-700">{escrow.rawText}</p>
              </Card>
            </div>
            <div className="space-y-6">
              <Card title="What happened">
                <Timeline events={events} />
              </Card>
              <RgbPanel escrow={escrow} events={events} asset={asset} />
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
