import type { ReactNode } from 'react';
import { SERVICE_FEE_PERCENT } from '@escrow/shared';
import { Layout } from '../components/Layout';
import { Card } from '../components/ui';
import { displayTicker } from '../lib/format';
import { useMarket } from '../lib/hooks';
import { lastRole } from '../lib/session';

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">{n}</span>
      <div>
        <p className="font-semibold text-slate-900">{title}</p>
        <div className="mt-0.5 text-sm text-slate-600">{children}</div>
      </div>
    </li>
  );
}

export function HowItWorks() {
  const { asset } = useMarket();
  const ticker = asset ? displayTicker(asset.assetTicker) : 'tUSDT';
  return (
    <Layout {...(lastRole() ? { role: lastRole()! } : {})}>
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-3xl font-bold text-slate-900">How payments work</h1>

        <Card title="The short version">
          <ol className="space-y-5">
            <Step n={1} title="The client posts a job">
              QVAC, an AI that runs on the laptop, turns the description into requirements. Most are checked automatically (tests,
              files, examples); the rest the client judges. The client approves them, and the listing goes live.
            </Step>
            <Step n={2} title="A freelancer takes it">
              The first one wins. The client's wallet then pays the reward plus a {SERVICE_FEE_PERCENT}% fee into escrow on its own,
              within a few minutes, or the job goes back to the marketplace. A freelancer can also offer a lower price; if the
              client accepts it, the job is agreed at that price (with the fee worked out again) and the other offers are
              declined. Unanswered offers expire.
            </Step>
            <Step n={3} title="The work is checked">
              The freelancer uploads the work. The system runs every automatic check and shows the evidence. If something only a
              person can judge is left, the client reviews it, with QVAC's notes as advice.
            </Step>
            <Step n={4} title="The money moves">
              Passed (and approved, or no answer in time): the freelancer gets the reward and the service keeps the fee. Not passed by
              the deadline: the client gets everything back, fee included.
            </Step>
          </ol>
        </Card>

        <Card title="Rules that always hold">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            <li><strong>The AI never moves money.</strong> A small, tested piece of code decides from the check results and the clock. The AI writes proposals, explanations and advice.</li>
            <li><strong>Nothing waits forever.</strong> Every waiting step has a deadline with a fixed outcome: unfunded jobs reopen, unclaimed listings close, unanswered reviews pay out, missed deadlines refund.</li>
            <li><strong>Payout never needs anyone's help later.</strong> The client attaches a refund invoice when paying, and the freelancer a payout invoice when delivering.</li>
            <li><strong>Any change means new terms.</strong> The terms have a fingerprint; edit anything and both sides agree again.</li>
            <li><strong>Your balance is private.</strong> Only your own wallet on your own laptop shows it. The service only knows what it holds itself.</li>
            <li><strong>Everything is logged</strong>, with a plain-language explanation of each step.</li>
          </ul>
        </Card>

        <Card title={`What ${ticker} is: RGB on Bitcoin`}>
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              {ticker} is a test stand-in for USDT, issued as an <strong>RGB asset</strong>. RGB is a way to put tokens on
              Bitcoin without putting them in a public ledger:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li><strong>Balances live in wallets.</strong> Each wallet keeps the history of the tokens it owns. There is no public list of who holds what.</li>
              <li><strong>Payments use single-use invoices.</strong> The receiver creates an invoice (rgb:…) naming the asset, the amount and a hidden Bitcoin output to receive on. It can be paid once.</li>
              <li><strong>The receiver checks the payment itself.</strong> The sender hands over the transfer's data (a "consignment") through an RGB proxy. The receiving wallet validates its whole history before accepting it. This is called client-side validation.</li>
              <li><strong>Bitcoin makes it final.</strong> Every transfer is committed inside an ordinary Bitcoin transaction. Once that transaction confirms, the transfer cannot be undone or spent twice.</li>
            </ul>
            <p>
              The escrow service has its own RGB wallet, built with <strong>Tether's WDK</strong>. Each job page has an
              "Under the hood" panel that shows the real invoices and Bitcoin transactions as the job goes through these steps.
              {asset && <> This demo runs on Bitcoin <strong>{asset.network}</strong>.</>}
            </p>
          </div>
        </Card>
      </div>
    </Layout>
  );
}
