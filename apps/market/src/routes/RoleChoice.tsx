import { Link } from 'react-router';
import type { PartyRole } from '@escrow/shared';
import { Layout } from '../components/Layout';
import { lastRole, rememberRole } from '../lib/session';

const ROLES: { role: PartyRole; title: string; text: string; icon: string }[] = [
  {
    role: 'client',
    title: "I'm a client",
    text: 'Post a job with a reward. The AI turns your words into checks, you approve them, and you only pay for work that passes.',
    icon: '📋',
  },
  {
    role: 'freelancer',
    title: "I'm a freelancer",
    text: 'Pick a job from the marketplace. The reward is locked before you start, and you are paid as soon as the checks pass.',
    icon: '🛠',
  },
];

export function RoleChoice() {
  const last = lastRole();
  return (
    <Layout>
      <div className="mx-auto max-w-3xl py-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900">Get work done. Get paid. No trust needed.</h1>
        <p className="mx-auto mt-3 max-w-xl text-slate-600">
          The escrow service holds the money while the work is checked, then pays the freelancer or refunds the client.
          A local AI explains every step. The AI never moves money.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {ROLES.map((r) => (
            <Link
              key={r.role}
              to={`/${r.role}`}
              onClick={() => rememberRole(r.role)}
              className={`rounded-2xl border bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-400 hover:shadow-md ${last === r.role ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-slate-200'}`}
            >
              <span className="text-3xl" aria-hidden>{r.icon}</span>
              <p className="mt-3 text-lg font-semibold text-slate-900">{r.title}</p>
              <p className="mt-1 text-sm text-slate-600">{r.text}</p>
              {last === r.role && <p className="mt-3 text-xs font-medium text-indigo-600">Last used on this laptop</p>}
            </Link>
          ))}
        </div>
        <p className="mt-8 text-sm text-slate-500">
          You can switch at any time. <Link to="/service" className="font-medium text-indigo-600 hover:underline">Service screen</Link> for the projector.
        </p>
      </div>
    </Layout>
  );
}
