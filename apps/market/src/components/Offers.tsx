// Counteroffers: a freelancer offers to do an open listing at its own price (above or below the listed
// reward); the client sees every offer and can
// accept one, which agrees the job at that reward (new terms, fee recalculated) with that freelancer.
import { useState } from 'react';
import { escrowTotal, toBaseUnits, type ConfigResponse, type Escrow } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { OFFER_STATUS_LABEL, countdown, displayTicker, money, openOffers } from '../lib/format';
import { useAction, useNow } from '../lib/hooks';
import { myOffers, saveOffer } from '../lib/session';
import { Button, Card, ErrorText, Field, Pill, inputClass } from './ui';

/** Client, OPEN listing: every offer still open, cheapest first, each with what accepting it would cost. */
export function ClientOffers({ escrow, asset, token, autopayOn }: { escrow: Escrow; asset: ConfigResponse; token: string; autopayOn: boolean }) {
  const now = useNow();
  const offers = openOffers(escrow, now).sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const accept = useAction(async (offerId: string) => {
    const o = offers.find((x) => x.id === offerId);
    if (!o) return;
    const total = money(escrowTotal(o), asset);
    if (!window.confirm(`Accept ${money(o.amount, asset)}? The job goes to this freelancer at that reward and your wallet pays ${total} into escrow. Other offers are declined.`)) return;
    await agentApi.acceptOffer(escrow.id, o.id, o.termsHash, token);
    // Approve auto-pay for the new total: a higher price than the listing needs a new limit, a lower one fits the old.
    if (!autopayOn || BigInt(o.amount) > BigInt(escrow.amount)) await partyApi('client').autopay(escrow.id, token);
  });
  const closed = (escrow.offers ?? []).filter((o) => !offers.includes(o));

  return (
    <Card title="Counteroffers" aside={offers.length > 0 && <Pill tone="blue">{offers.length} open</Pill>}>
      {offers.length === 0 ? (
        <p className="text-sm text-slate-500">
          No offers yet. Freelancers can offer their own price instead of {money(escrow.amount, asset)}; you choose whether to accept.
        </p>
      ) : (
        <ul className="space-y-3">
          {offers.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 p-4">
              <div className="min-w-0">
                <p className="text-lg font-bold tabular-nums text-slate-900">
                  {money(o.amount, asset)} <span className="text-sm font-normal text-slate-500">instead of {money(escrow.amount, asset)}</span>
                </p>
                <p className="text-xs text-slate-500">
                  You would escrow {money(escrowTotal(o), asset)} (fee {money(o.fee, asset)}) · expires in{' '}
                  <span className="tabular-nums">{countdown(o.expiresAt, now)}</span>
                </p>
                {o.note && <p className="mt-2 text-sm italic text-slate-700">“{o.note}”</p>}
              </div>
              <Button busy={accept.busy} onClick={() => void accept.run(o.id)}>Accept offer</Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText>{accept.error}</ErrorText>
      {closed.length > 0 && (
        <p className="mt-3 text-xs text-slate-400">
          Earlier: {closed.map((o) => `${money(o.amount, asset)} ${OFFER_STATUS_LABEL[o.status].toLowerCase()}`).join(' · ')}
        </p>
      )}
    </Card>
  );
}

/** Freelancer, OPEN listing it doesn't hold: its own offers on it, or a form to make one. */
export function MakeOffer({ escrow, asset }: { escrow: Escrow; asset: ConfigResponse }) {
  const now = useNow();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [, setSaved] = useState(0);
  const mine = myOffers(escrow.id)
    .map((m) => ({ ...m, offer: escrow.offers?.find((o) => o.id === m.offerId) }))
    .filter((m) => m.offer !== undefined);
  const pending = mine.find((m) => m.offer!.status === 'pending' && Date.parse(m.offer!.expiresAt) > now);

  let units: string | undefined;
  try {
    units = amount.trim() ? toBaseUnits(amount, asset.precision) : undefined;
  } catch {
    units = undefined;
  }
  const valid = units !== undefined && BigInt(units) > 0n;

  const send = useAction(async () => {
    if (!units || !escrow.termsHash) return;
    const res = await agentApi.makeOffer(escrow.id, escrow.termsHash, units, note.trim() || undefined);
    const made = res.escrow.offers?.find((o) => o.id === res.offerId);
    if (made) saveOffer(escrow.id, { offerId: res.offerId, token: res.offerToken, at: made.at });
    setAmount('');
    setNote('');
    setSaved((n) => n + 1);
  });
  const withdraw = useAction(async (offerId: string, token: string) => {
    await agentApi.withdrawOffer(escrow.id, offerId, token);
  });

  return (
    <Card title="Or offer your own price">
      {pending ? (
        <div className="space-y-2 text-sm">
          <p>
            Your offer: <strong className="tabular-nums">{money(pending.offer!.amount, asset)}</strong>
          </p>
          <p className="text-slate-500">
            Waiting for the client · expires in <span className="tabular-nums">{countdown(pending.offer!.expiresAt, now)}</span>. If the client
            accepts, the job is yours at that reward and the client's wallet pays it into escrow.
          </p>
          <Button variant="secondary" busy={withdraw.busy} onClick={() => void withdraw.run(pending.offerId, pending.token)}>Withdraw offer</Button>
          <ErrorText>{withdraw.error}</ErrorText>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label={`Your price (${displayTicker(asset.assetTicker)})`} hint={`Listed at ${money(escrow.amount, asset)}. Ask for less or more; the client sees it with your note.`}>
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Note (optional)">
            <textarea className={`${inputClass} min-h-16`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you, or when you can deliver" />
          </Field>
          {amount && !valid && <p className="text-xs text-red-700">Enter an amount above zero.</p>}
          <Button variant="secondary" className="w-full" busy={send.busy} disabled={!valid} onClick={() => void send.run()}>Send offer</Button>
          <ErrorText>{send.error}</ErrorText>
        </div>
      )}
      {mine.some((m) => m !== pending) && (
        <p className="mt-3 text-xs text-slate-400">
          Your earlier offers: {mine.filter((m) => m !== pending).map((m) => `${money(m.offer!.amount, asset)} ${OFFER_STATUS_LABEL[m.offer!.status].toLowerCase()}`).join(' · ')}
        </p>
      )}
    </Card>
  );
}
