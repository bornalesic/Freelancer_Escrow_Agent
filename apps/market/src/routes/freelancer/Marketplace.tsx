import { useState } from 'react';
import { toBaseUnits } from '@escrow/shared';
import { JobRow } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { Empty, inputClass } from '../../components/ui';
import { displayTicker, filterListings, sortListings, type ListingSort } from '../../lib/format';
import { useMarket, useNow } from '../../lib/hooks';

const DUE = [
  { label: 'Any deadline', ms: undefined },
  { label: 'Due within 1 hour', ms: 3600_000 },
  { label: 'Due within 1 day', ms: 24 * 3600_000 },
  { label: 'Due within 1 week', ms: 7 * 24 * 3600_000 },
];

export function Marketplace() {
  const { jobs, asset, loaded } = useMarket();
  const now = useNow(30_000);
  const [sort, setSort] = useState<ListingSort>('reward-desc');
  const [minReward, setMinReward] = useState('');
  const [due, setDue] = useState(0);

  let min: string | undefined;
  try {
    min = asset && minReward.trim() ? toBaseUnits(minReward, asset.precision) : undefined;
  } catch {
    min = undefined;
  }
  const open = filterListings(Object.values(jobs).map((v) => v.escrow), { now, minReward: min, dueWithinMs: DUE[due]!.ms });
  const listings = sortListings(open, sort);

  return (
    <Layout role="freelancer">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Marketplace</h1>
          <p className="text-sm text-slate-500">Every job here has its reward ready to lock in escrow the moment you take it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Sort" className={`${inputClass} !w-auto`} value={sort} onChange={(e) => setSort(e.target.value as ListingSort)}>
            <option value="reward-desc">Highest reward</option>
            <option value="reward-asc">Lowest reward</option>
            <option value="deadline-asc">Soonest deadline</option>
          </select>
          <select aria-label="Deadline" className={`${inputClass} !w-auto`} value={due} onChange={(e) => setDue(Number(e.target.value))}>
            {DUE.map((d, i) => <option key={d.label} value={i}>{d.label}</option>)}
          </select>
          <input
            aria-label="Minimum reward"
            className={`${inputClass} !w-36`}
            inputMode="decimal"
            placeholder={`Min reward ${asset ? displayTicker(asset.assetTicker) : ''}`}
            value={minReward}
            onChange={(e) => setMinReward(e.target.value)}
          />
        </div>
      </div>
      {listings.length === 0 ? (
        <Empty>{loaded ? 'No open jobs right now. New listings appear here live.' : 'Loading…'}</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {listings.map((e) => <JobRow key={e.id} escrow={e} to={`/freelancer/jobs/${e.id}`} asset={asset} />)}
        </div>
      )}
    </Layout>
  );
}
