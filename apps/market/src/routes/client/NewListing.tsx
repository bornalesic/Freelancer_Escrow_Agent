import { useState } from 'react';
import { useNavigate } from 'react-router';
import { escrowTotal, serviceFee, toBaseUnits } from '@escrow/shared';
import { FeeBreakdown } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { Button, Card, ErrorText, Field, Notice, inputClass } from '../../components/ui';
import { agentApi } from '../../lib/api';
import { displayTicker } from '../../lib/format';
import { useAction, useAssistResult, useMarket, useOwnWallet } from '../../lib/hooks';
import { saveToken } from '../../lib/session';

const DEADLINES = [
  { label: '30 minutes', minutes: 30 },
  { label: '2 hours', minutes: 120 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '1 week', minutes: 7 * 24 * 60 },
];

// The rehearsed demo job (fixtures/README.md): keep it identical, fixtures/demo-deliverable/slugify-v* match it.
const EXAMPLE = {
  title: 'Slugify function',
  rawText:
    "Build a JavaScript function `slugify` that lowercases text, replaces spaces with dashes and strips anything that isn't " +
    'a letter, number or dash. The included tests must pass. Also include a README.',
  reward: '50',
  minutes: 30,
};

function parseReward(display: string, precision: number): string | undefined {
  try {
    const units = toBaseUnits(display, precision);
    return BigInt(units) > 0n ? units : undefined;
  } catch {
    return undefined;
  }
}

export function NewListing() {
  const navigate = useNavigate();
  const { asset } = useMarket();
  const wallet = useOwnWallet('client');
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [reward, setReward] = useState('');
  const [minutes, setMinutes] = useState(120);
  const [priceKey, setPriceKey] = useState<string | null>(null);

  const units = asset ? parseReward(reward, asset.precision) : undefined;
  const balance = asset ? wallet.data?.assets.find((a) => a.assetId === asset.assetId) : undefined;
  const spendable = wallet.data ? (balance?.spendable ?? '0') : undefined;
  const total = units ? escrowTotal({ amount: units, fee: serviceFee(units) }) : undefined;
  const tooPoor = total !== undefined && spendable !== undefined && BigInt(spendable) < BigInt(total);
  const ready = Boolean(asset && title.trim() && rawText.trim() && units && !tooPoor);

  const price = useAssistResult(
    'estimate',
    asset && units ? { title: title.trim() || 'Job', rawText: rawText.trim(), amountDisplay: reward.trim(), assetTicker: displayTicker(asset.assetTicker), deadlineMinutes: minutes } : null,
    priceKey,
  );

  const create = useAction(async () => {
    if (!asset || !units) return;
    const deadline = new Date(Date.now() + minutes * 60_000).toISOString();
    const res = await agentApi.create({ title: title.trim(), rawText: rawText.trim(), amount: units, deadline });
    saveToken('client', res.id, res.clientToken);
    await navigate(`/client/jobs/${res.id}`);
  });

  return (
    <Layout role="client">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">New listing</h1>
            <p className="text-sm text-slate-500">Describe the job in your own words. The AI turns it into checks you approve before it goes live.</p>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setTitle(EXAMPLE.title);
              setRawText(EXAMPLE.rawText);
              setReward(EXAMPLE.reward);
              setMinutes(EXAMPLE.minutes);
            }}
          >
            Fill an example
          </Button>
        </div>

        <Card>
          <div className="space-y-4">
            <Field label="Title">
              <input className={inputClass} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Logo for my bakery" />
            </Field>
            <Field label="What should be delivered?" hint="Mention what can be checked: tests that must pass, files that must be there, examples of input and output.">
              <textarea className={`${inputClass} min-h-40`} value={rawText} maxLength={10_000} onChange={(e) => setRawText(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Reward (${asset ? displayTicker(asset.assetTicker) : '…'})`}>
                <input className={inputClass} inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="50" />
              </Field>
              <Field label="Deadline">
                <select className={inputClass} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {DEADLINES.map((d) => <option key={d.minutes} value={d.minutes}>in {d.label}</option>)}
                </select>
              </Field>
            </div>
            {reward && !units && <p className="text-xs text-red-700">Enter a positive amount{asset ? ` with at most ${asset.precision} decimals` : ''}.</p>}
          </div>
        </Card>

        {asset && units && <FeeBreakdown reward={units} asset={asset} spendable={spendable} />}
        {wallet.error && !wallet.data && <Notice tone="orange" title="Your wallet is offline">Start the client wallet on this laptop (npm run dev:party:client) to check your balance.</Notice>}

        {units && rawText.trim() && (
          <div className="flex items-start gap-3">
            <Button variant="secondary" busy={price.loading} onClick={() => setPriceKey(`${title}|${rawText}|${reward}|${minutes}`)}>
              Is this a fair price?
            </Button>
            {price.data && (
              <div className="text-sm text-slate-600">
                <p>
                  Looks like a <strong>{price.data.size}</strong> job: usually {price.data.amount.low}–{price.data.amount.high}{' '}
                  {asset && displayTicker(asset.assetTicker)}, {price.data.minutes.low}–{price.data.minutes.high} minutes. {price.data.reason}
                </p>
                {price.data.warnings.map((w) => <p key={w} className="text-amber-700">{w}</p>)}
              </div>
            )}
            {price.unavailable && <p className="text-sm text-slate-500">The AI price check is not available right now.</p>}
          </div>
        )}

        <ErrorText>{create.error}</ErrorText>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => void navigate('/client')}>Cancel</Button>
          <Button disabled={!ready} busy={create.busy} onClick={() => void create.run()}>
            Continue: review requirements
          </Button>
        </div>
        <p className="text-right text-xs text-slate-500">Nothing is paid yet. Nobody sees the listing until you approve its requirements.</p>
      </div>
    </Layout>
  );
}
