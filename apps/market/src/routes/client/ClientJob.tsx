import { useState } from 'react';
import { useParams } from 'react-router';
import { applyRewrite, escrowTotal, type AutopayStatus, type ConfigResponse, type Escrow, type LogEvent } from '@escrow/shared';
import { JobHeader } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { ClientOffers } from '../../components/Offers';
import { Requirements } from '../../components/Requirements';
import { RgbPanel } from '../../components/RgbPanel';
import { Timeline } from '../../components/Timeline';
import { Work } from '../../components/Work';
import { Button, Card, Empty, ErrorText, Notice, Spinner, inputClass } from '../../components/ui';
import { agentApi, partyApi } from '../../lib/api';
import { automaticCount, countdown, displayText, money } from '../../lib/format';
import { useAction, useAssistResult, useMarket, useNow, useOwnWallet, usePoll } from '../../lib/hooks';
import { getToken } from '../../lib/session';

const CANCELLABLE = ['DRAFT', 'PROPOSED', 'OPEN', 'AGREED', 'AWAITING_FUNDS'];

function lastDecision(events: readonly LogEvent[]): string | undefined {
  const e = [...events].reverse().find((x) => x.type === 'decision.made');
  return e?.title.replace(/^Decision: /, '');
}

function AutopayLine({ status }: { status: AutopayStatus | undefined }) {
  if (!status) return null;
  const text: Record<AutopayStatus['status'], string> = {
    waiting: 'Payment pre-authorised: your wallet pays as soon as a freelancer takes the job.',
    paying: 'Your wallet is sending the payment…',
    paid: 'Your wallet sent the payment. Waiting for the escrow service to confirm it.',
    failed: 'Your wallet could not pay',
    done: 'Payment complete.',
  };
  return (
    <p className={`mt-2 text-sm ${status.status === 'failed' ? 'text-red-700' : 'text-slate-600'}`}>
      {status.status === 'paying' && <Spinner className="mr-2 text-indigo-500" />}
      {text[status.status]}
      {status.error && `: ${status.error}`}
    </p>
  );
}

/** What is happening now, in one card, and what the client can do about it. */
function Status({ escrow, events, asset, autopay, token }: { escrow: Escrow; events: readonly LogEvent[]; asset: ConfigResponse; autopay: AutopayStatus | undefined; token: string | undefined }) {
  const now = useNow();
  const total = money(escrowTotal(escrow), asset);
  const reward = money(escrow.amount, asset);
  const fee = money(escrow.fee ?? '0', asset);
  const latest = escrow.deliveries.at(-1);
  const turnOn = useAction(async () => {
    if (token) await partyApi('client').autopay(escrow.id, token);
  });

  switch (escrow.state) {
    case 'DRAFT':
      return <Notice title="QVAC is reading your description…">It turns your words into requirements the system can check. This takes a few seconds.</Notice>;
    case 'PROPOSED':
      return <Notice title="Review the requirements">Check what the AI proposed below. When it is right, approve it to publish the listing.</Notice>;
    case 'OPEN':
      return (
        <Notice title="Live on the marketplace">
          Waiting for a freelancer. When one takes the job, {total} ({reward} reward + {fee} fee) goes into escrow automatically.
          <AutopayLine status={autopay} />
          {!autopay && token && (
            <div className="mt-2 flex items-center gap-3">
              <span className="text-orange-800">Automatic payment is not set up on this laptop.</span>
              <Button variant="secondary" busy={turnOn.busy} onClick={() => void turnOn.run()}>Turn it on</Button>
            </div>
          )}
          <ErrorText>{turnOn.error}</ErrorText>
        </Notice>
      );
    case 'AGREED':
    case 'AWAITING_FUNDS':
      return (
        <Notice tone="amber" title="A freelancer took your job">
          Your wallet is paying {total} into escrow.
          {escrow.fundingDueAt && <> If it has not arrived in <strong className="tabular-nums">{countdown(escrow.fundingDueAt, now)}</strong>, the job goes back to the marketplace.</>}
          <AutopayLine status={autopay} />
          {!autopay && token && (
            <div className="mt-2 flex items-center gap-3">
              <span className="text-orange-800">Automatic payment is not set up on this laptop.</span>
              <Button variant="secondary" busy={turnOn.busy} onClick={() => void turnOn.run()}>Pay now</Button>
            </div>
          )}
          <ErrorText>{turnOn.error}</ErrorText>
        </Notice>
      );
    case 'FUNDED':
      return latest ? (
        <Notice tone="violet" title={latest.approval?.decision === 'dispute' ? 'You disputed the work' : `Version ${latest.n} did not pass`}>
          {total} stays in escrow. The freelancer can send a new version until the deadline; if nothing passes by then, you get it all back.
        </Notice>
      ) : (
        <Notice tone="violet" title="In progress">{total} is held in escrow. The freelancer is working on it.</Notice>
      );
    case 'DELIVERED':
    case 'VERIFYING':
      return <Notice tone="violet" title={`Checking version ${latest?.n ?? ''}`}>The system is running the automatic checks on the delivery.</Notice>;
    case 'AWAITING_APPROVAL':
      return (
        <Notice tone="amber" title="Your turn: review the work">
          All automatic checks passed. Look at the previews and QVAC's notes below, then approve or dispute.
          {latest?.reviewDueAt && <> No answer in <strong className="tabular-nums">{countdown(latest.reviewDueAt, now)}</strong> means the freelancer is paid.</>}
        </Notice>
      );
    case 'RELEASING':
      return <Notice tone="green" title="Paying the freelancer">{reward} is on its way. Waiting for the Bitcoin transaction to confirm.</Notice>;
    case 'RELEASED':
      return <Notice tone="green" title="Paid">The freelancer received {reward} and the service kept the {fee} fee. The full work is yours to download.</Notice>;
    case 'REFUNDING':
      return <Notice tone="orange" title="Refunding you">{total} is on its way back to your wallet. {lastDecision(events)}.</Notice>;
    case 'REFUNDED':
      return <Notice tone="orange" title="Refunded">{total} is back in your wallet, fee included. {lastDecision(events)}.</Notice>;
    case 'CANCELLED':
      return <Notice tone="grey" title="Cancelled">Nothing was paid. {lastDecision(events) ?? ''}</Notice>;
  }
}

/** PROPOSED: the client approves the AI's requirements (= publishes) or edits the description. */
function RequirementsReview({ escrow, asset, token }: { escrow: Escrow; asset: ConfigResponse; token: string }) {
  const wallet = useOwnWallet('client');
  const auto = automaticCount(escrow);
  const reviewOnly = escrow.conditions.length - auto;
  const spendable = asset ? wallet.data?.assets.find((a) => a.assetId === asset.assetId)?.spendable ?? (wallet.data ? '0' : undefined) : undefined;
  const total = escrowTotal(escrow);
  const tooPoor = spendable !== undefined && BigInt(spendable) < BigInt(total);

  const rewrites = useAssistResult(
    'rewrite',
    reviewOnly > 0 ? { title: escrow.title, rawText: escrow.rawText, conditions: escrow.conditions } : null,
    reviewOnly > 0 && escrow.termsHash ? escrow.termsHash : null,
  );

  const reparse = useAction((rawText: string) => agentApi.reparse(escrow.id, rawText, token));
  const publish = useAction(async () => {
    if (!escrow.termsHash) return;
    await agentApi.publish(escrow.id, escrow.termsHash, token);
    await partyApi('client').autopay(escrow.id, token); // pre-authorise: pay when a freelancer takes it
  });

  return (
    <Card title="Requirements proposed by QVAC">
      <div className="space-y-4">
        {escrow.summary && <p className="text-sm text-slate-700">{displayText(escrow.summary)}</p>}
        <Requirements conditions={escrow.conditions} />
        {escrow.clarifications && escrow.clarifications.length > 0 && (
          <Notice tone="amber" title="QVAC could not turn these into checks">
            <ul className="list-disc pl-5">{escrow.clarifications.map((c) => <li key={c}>{c}</li>)}</ul>
          </Notice>
        )}

        {rewrites.data && rewrites.data.suggestions.length > 0 && (
          <div className="rounded-xl border border-fuchsia-100 bg-fuchsia-50/40 p-4">
            <p className="text-sm font-semibold text-slate-900">Make more of it checkable automatically</p>
            <ul className="mt-2 space-y-2">
              {rewrites.data.suggestions.map((s) => (
                <li key={s.conditionId + s.quote} className="flex items-start justify-between gap-3 text-sm">
                  <span>
                    <span className="text-slate-500 line-through">{s.quote}</span> → <span className="text-slate-900">{s.rewrite}</span>
                  </span>
                  <Button variant="secondary" className="shrink-0" busy={reparse.busy} onClick={() => void reparse.run(applyRewrite(escrow.rawText, s.quote, s.rewrite))}>
                    Use this
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ErrorText>{reparse.error}</ErrorText>

        {auto === 0 ? (
          <Notice tone="orange" title="This can't be published yet">
            Nothing here can be checked automatically, so the system could never decide on its own whether to pay. Add something
            checkable: tests that must pass, a file that must be included, or examples of input and output.
          </Notice>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="max-w-lg text-xs text-slate-500">
              Approving publishes the listing and pre-authorises your wallet to pay {money(total, asset)} into escrow when a freelancer
              takes it. You can still edit or withdraw it until then.
            </p>
            <Button busy={publish.busy} disabled={tooPoor || !escrow.termsHash} onClick={() => void publish.run()}>
              Approve and publish
            </Button>
          </div>
        )}
        {tooPoor && <ErrorText>Your wallet has {money(spendable ?? '0', asset)}, but this job needs {money(total, asset)}.</ErrorText>}
        <ErrorText>{publish.error}</ErrorText>
      </div>
    </Card>
  );
}

/** The client's own words. Editable until a freelancer takes the job; any edit means new terms to approve. */
function Description({ escrow, token }: { escrow: Escrow; token: string | undefined }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(escrow.rawText);
  const editable = token !== undefined && (escrow.state === 'PROPOSED' || escrow.state === 'OPEN');
  const save = useAction(async () => {
    if (!token) return;
    await agentApi.reparse(escrow.id, text.trim(), token);
    setEditing(false);
  });
  return (
    <Card
      title="Your description"
      aside={editable && !editing && (
        <Button variant="ghost" onClick={() => { setText(escrow.rawText); setEditing(true); }}>Edit</Button>
      )}
    >
      {editing ? (
        <div className="space-y-2">
          <textarea className={`${inputClass} min-h-36`} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-slate-500">
            QVAC reads it again and you approve the new requirements.
            {escrow.state === 'OPEN' && ' The listing leaves the marketplace until you do.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            <Button busy={save.busy} disabled={!text.trim() || text.trim() === escrow.rawText} onClick={() => void save.run()}>Save and read again</Button>
          </div>
          <ErrorText>{save.error}</ErrorText>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-slate-700">{escrow.rawText}</p>
      )}
    </Card>
  );
}

function ReviewDecision({ escrow, token }: { escrow: Escrow; token: string }) {
  const latest = escrow.deliveries.at(-1)!;
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const answer = useAction(async (decision: 'approve' | 'dispute') => {
    await agentApi.approve(escrow.id, { deliveryN: latest.n, decision, clientToken: token, ...(decision === 'dispute' ? { reason: reason.trim() } : {}) });
  });
  return (
    <div className="space-y-3 rounded-xl border-2 border-indigo-200 bg-indigo-50/40 p-4">
      <p className="font-semibold text-slate-900">Does version {latest.n} do what you asked?</p>
      {disputing ? (
        <>
          <textarea className={`${inputClass} min-h-24`} placeholder="What is missing or wrong? The freelancer sees this." value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDisputing(false)}>Back</Button>
            <Button variant="danger" busy={answer.busy} disabled={!reason.trim()} onClick={() => void answer.run('dispute')}>Send dispute</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button busy={answer.busy} onClick={() => void answer.run('approve')}>Approve and pay</Button>
          <Button variant="danger" onClick={() => setDisputing(true)}>Dispute</Button>
        </div>
      )}
      <ErrorText>{answer.error}</ErrorText>
    </div>
  );
}

export function ClientJob() {
  const { id = '' } = useParams();
  const { jobs, asset, loaded } = useMarket();
  const view = jobs[id];
  const token = getToken('client', id);
  const autopay = usePoll(token ? () => partyApi('client').autopayList() : null, 3_000);
  const cancel = useAction(async () => {
    if (window.confirm('Withdraw this job? Nothing has been paid yet.')) await agentApi.cancel(id, 'client', token);
  });

  if (!view || !asset) {
    return (
      <Layout role="client">
        <Empty>{loaded && !view ? 'This job does not exist on the escrow service (it may have been reset).' : 'Loading…'}</Empty>
      </Layout>
    );
  }
  const { escrow, events } = view;
  const myAutopay = autopay.data?.find((a) => a.escrowId === id);
  const paying = myAutopay?.status === 'paying' || myAutopay?.status === 'paid';
  const showWork = escrow.deliveries.length > 0;

  return (
    <Layout role="client">
      <div className="space-y-6">
        <JobHeader escrow={escrow} asset={asset}>
          {token && CANCELLABLE.includes(escrow.state) && (
            <Button variant="danger" busy={cancel.busy} disabled={paying} onClick={() => void cancel.run()} title={paying ? 'Your payment is already on its way' : undefined}>
              {escrow.state === 'OPEN' ? 'Withdraw listing' : 'Cancel job'}
            </Button>
          )}
        </JobHeader>
        <ErrorText>{cancel.error}</ErrorText>
        {!token && <Notice tone="orange" title="Created in another browser">You can follow this job here, but only the browser that created it can manage it.</Notice>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <Status escrow={escrow} events={events} asset={asset} autopay={myAutopay} token={token} />
            {escrow.state === 'AWAITING_APPROVAL' && token && <ReviewDecision escrow={escrow} token={token} />}
            {escrow.state === 'OPEN' && token && <ClientOffers escrow={escrow} asset={asset} token={token} autopayOn={myAutopay !== undefined} />}
            {showWork && (
              <Card title="Delivered work">
                <Work escrow={escrow} token={token} viewer="client" />
              </Card>
            )}
            {escrow.state === 'PROPOSED' && token ? (
              <RequirementsReview key={escrow.termsHash} escrow={escrow} asset={asset} token={token} />
            ) : (
              escrow.state !== 'DRAFT' && (
                <Card title="Requirements">
                  <Requirements conditions={escrow.conditions} />
                </Card>
              )
            )}
            <Description escrow={escrow} token={token} />
          </div>
          <div className="space-y-6">
            <Card title="What happened">
              <Timeline events={events} />
            </Card>
            <RgbPanel escrow={escrow} events={events} asset={asset} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
