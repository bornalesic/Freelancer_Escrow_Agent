import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { PartyRole } from '@escrow/shared';
import { frozen, money } from '../lib/format';
import { useMarket, useOwnWallet } from '../lib/hooks';
import { isMyJob, rememberRole } from '../lib/session';

const NAV: Record<PartyRole, { to: string; label: string }[]> = {
  client: [
    { to: '/client', label: 'My listings' },
    { to: '/client/new', label: 'New listing' },
  ],
  freelancer: [
    { to: '/freelancer', label: 'Marketplace' },
    { to: '/freelancer/mine', label: 'My jobs' },
  ],
};

/** Only this laptop's own wallet, from its own party server. The service never sees it. */
function OwnBalance({ role }: { role: PartyRole }) {
  const { asset, jobs } = useMarket();
  const wallet = useOwnWallet(role);
  const bal = asset ? wallet.data?.assets.find((a) => a.assetId === asset.assetId) : undefined;
  const held = role === 'client'
    ? Object.values(jobs).filter((v) => isMyJob('client', v.escrow)).reduce((sum, v) => sum + BigInt(frozen(v.escrow)), 0n)
    : 0n;
  const incoming = bal ? BigInt(bal.future) - BigInt(bal.settled) : 0n;

  if (!wallet.data && wallet.error) {
    return (
      <div className="text-right text-xs text-red-700" title={wallet.error}>
        Wallet offline
        <span className="block text-[10px] text-slate-400">start npm run dev:party:{role}</span>
      </div>
    );
  }
  return (
    <div className="text-right leading-tight">
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">My balance</p>
      <p className="text-base font-semibold tabular-nums text-slate-900">{asset && wallet.data ? money(bal?.spendable ?? '0', asset) : '…'}</p>
      {asset && (incoming > 0n || held > 0n) && (
        <p className="text-[11px] text-slate-500">
          {incoming > 0n && <>+{money(incoming, asset)} incoming</>}
          {incoming > 0n && held > 0n && ' · '}
          {held > 0n && <>{money(held, asset)} in escrow</>}
        </p>
      )}
    </div>
  );
}

function RoleSwitch({ role }: { role: PartyRole }) {
  const navigate = useNavigate();
  const go = (r: PartyRole) => {
    rememberRole(r);
    void navigate(`/${r}`);
  };
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold" role="group" aria-label="Role">
      {(['client', 'freelancer'] as const).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => go(r)}
          className={`rounded-md px-3 py-1.5 ${r === role ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          {r === 'client' ? 'Client' : 'Freelancer'}
        </button>
      ))}
    </div>
  );
}

function LiveDot() {
  const { status } = useMarket();
  const live = status === 'live';
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-500" title={live ? 'Connected to the escrow service' : 'Reconnecting to the escrow service…'}>
      <span className={`size-2 rounded-full ${live ? 'bg-emerald-500' : 'animate-pulse bg-amber-400'}`} />
      {live ? 'Live' : 'Connecting'}
    </span>
  );
}

export function Layout({ role, wide = false, children }: { role?: PartyRole; wide?: boolean; children: ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className={`mx-auto flex items-center gap-6 px-4 py-3 ${wide ? 'max-w-[1600px]' : 'max-w-6xl'}`}>
          <Link to={role ? `/${role}` : '/'} className="flex items-center gap-2 font-bold text-slate-900">
            <span className="flex size-7 items-center justify-center rounded-lg bg-indigo-600 text-sm text-white">◆</span>
            Escrow Market
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {role &&
              NAV[role].map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end
                  className={({ isActive }) => `rounded-md px-3 py-1.5 font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {l.label}
                </NavLink>
              ))}
            <NavLink
              to="/how"
              className={({ isActive }) => `rounded-md px-3 py-1.5 font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              How payments work
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <LiveDot />
            {role && <RoleSwitch role={role} />}
            {role && <OwnBalance role={role} />}
          </div>
        </div>
      </header>
      <main className={`mx-auto px-4 py-6 ${wide ? 'max-w-[1600px]' : 'max-w-6xl'}`}>{children}</main>
    </div>
  );
}
