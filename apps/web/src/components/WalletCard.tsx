// This party's own wallet: polled from its party server every 3 s.
import { formatAmount } from '@escrow/shared';
import { config } from '../config';
import { findBalance, partyApi } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { useAgentConfig } from '../lib/agentConfig';
import { Card } from './ui';

export function WalletCard() {
  const wallet = usePoll(config.fixture ? null : partyApi.wallet, 3_000);
  const asset = useAgentConfig();
  const bal = findBalance(wallet.data, asset?.assetId);

  return (
    <Card title="Your wallet">
      {config.fixture ? (
        <p className="text-slate-500">No wallet in fixture mode.</p>
      ) : wallet.error && !wallet.data ? (
        <p className="text-red-700">{wallet.error}</p>
      ) : (
        <>
          <p className="text-3xl font-bold tabular-nums">
            {bal && asset ? formatAmount(bal.settled, asset.precision) : '–'}{' '}
            <span className="text-lg font-semibold text-slate-500">{asset?.assetTicker ?? ''}</span>
          </p>
          {bal && asset && bal.future !== bal.settled && (
            <p className="text-sm text-amber-700">{formatAmount(bal.future, asset.precision)} after pending transfers</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Self-custodial · Tether WDK · RGB on Bitcoin{wallet.data ? ` · ${wallet.data.network}` : ''}
          </p>
        </>
      )}
    </Card>
  );
}
