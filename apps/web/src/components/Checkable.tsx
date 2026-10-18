// Client, proposed terms: QVAC's measurable rewording of an item the client would otherwise judge.
// apps/ai only offers a rewrite that its own parser turns into an automatic check, so "Use this" (which
// re-parses the edited agreement) really moves the item from "you judge" to "the agent checks".
import { applyRewrite, type Escrow, type RewriteSuggestion } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { useAction, useAssistResult } from '../lib/hooks';
import { ErrorBanner } from './ui';

const BECOMES: Record<RewriteSuggestion['becomes'], string> = {
  tests_pass: 'a command that must pass',
  file_present: 'a file check',
  file_hash: 'an exact file match',
  examples: 'example outputs',
};

/** Rewrite suggestions by client_review condition id; asked once per termsHash, only when `enabled`. */
export function useRewrites(escrow: Escrow, enabled: boolean): Map<string, RewriteSuggestion> {
  const body = { title: escrow.title, rawText: escrow.rawText, conditions: escrow.conditions };
  const r = useAssistResult('rewrite', enabled ? body : null, enabled ? (escrow.termsHash ?? null) : null);
  return new Map((r.data?.suggestions ?? []).map((s) => [s.conditionId, s]));
}

export function MakeCheckable({ escrow, suggestion: s }: { escrow: Escrow; suggestion: RewriteSuggestion }) {
  const use = useAction(() => agentApi.reparse(escrow.id, applyRewrite(escrow.rawText, s.quote, s.rewrite)));
  return (
    <div className="space-y-2 rounded-lg border border-emerald-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-slate-700">
          <span className="font-semibold text-emerald-800">Make it checkable:</span> “{s.rewrite}”
          <span className="mt-0.5 block text-xs text-slate-500">
            QVAC suggestion · becomes {BECOMES[s.becomes]}, checked by the agent instead of by you
            {escrow.acceptances.length > 0 ? ' · both of you accept the new terms again' : ''}
          </span>
        </p>
        <button
          type="button"
          onClick={() => void use.run()}
          disabled={use.busy}
          className="shrink-0 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {use.busy ? 'Updating…' : 'Use this'}
        </button>
      </div>
      {use.error && <ErrorBanner>{use.error}</ErrorBanner>}
    </div>
  );
}
