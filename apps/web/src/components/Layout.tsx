import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { ConnectionDots, HealthBanner, HealthProvider } from './Connection';

const ROLE_LABEL = { client: 'Client', freelancer: 'Freelancer', agent: 'Escrow agent' } as const;

export function Layout({
  role,
  live,
  children,
  footer,
}: {
  role: keyof typeof ROLE_LABEL;
  /** WebSocket to the agent is open. */
  live: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <HealthProvider withParty={role !== 'agent'}>
      <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold tracking-tight">Escrow Agent</span>
            <span className="rounded-full bg-slate-900 px-3 py-0.5 text-sm font-medium text-white">{ROLE_LABEL[role]}</span>
          </div>
          <ConnectionDots live={live} />
          <nav className="flex gap-3 text-sm text-slate-500">
            {(['client', 'freelancer', 'agent'] as const).map((r) => (
              <NavLink key={r} to={`/${r}`} className={({ isActive }) => (isActive ? 'font-semibold text-slate-900' : 'hover:text-slate-900')}>
                {ROLE_LABEL[r]}
              </NavLink>
            ))}
          </nav>
        </header>
        <HealthBanner />
        <main className="flex-1 p-6">{children}</main>
        {footer && <footer className="border-t border-slate-200 bg-white px-6 py-3">{footer}</footer>}
      </div>
    </HealthProvider>
  );
}
