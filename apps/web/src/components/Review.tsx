// Client review (state AWAITING_APPROVAL): the delivered files, QVAC's advisory opinion, and the client's
// Approve / Dispute. The AI opinion is display only; the agent's decide() never reads it.
import { useEffect, useState } from 'react';
import { formatAmount, type AiReview, type Delivery, type DeliveryFile, type Escrow } from '@escrow/shared';
import { config } from '../config';
import { agentApi, deliveryFileUrl } from '../lib/api';
import { getClientToken } from '../lib/clientToken';
import { errorMessage, HttpError } from '../lib/http';
import { useAction } from '../lib/hooks';
import { ReviewConditionCard } from './Terms';
import { isClientReview } from '../lib/terms';
import { ErrorBanner, ReviewCountdown, Spinner } from './ui';

type Party = 'client' | 'freelancer';
type Opinion = AiReview['items'][number]['opinion'];

const OPINION: Record<Opinion, { label: string; cls: string }> = {
  looks_met: { label: 'Looks met', cls: 'bg-emerald-100 text-emerald-800' },
  looks_unmet: { label: 'Looks unmet', cls: 'bg-red-100 text-red-800' },
  unsure: { label: 'Unsure', cls: 'bg-slate-200 text-slate-700' },
};

export function OpinionChip({ opinion, large = false }: { opinion: Opinion; large?: boolean }) {
  const o = OPINION[opinion] ?? OPINION.unsure;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full font-semibold ${o.cls} ${large ? 'px-3 py-1 text-lg' : 'px-2.5 py-0.5 text-sm'}`}>
      {o.label}
    </span>
  );
}

export function SourceBadge({ review }: { review: AiReview }) {
  return review.source === 'template' ? (
    <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-sm font-semibold text-slate-600">template</span>
  ) : (
    <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-sm font-semibold text-white" title={review.model}>
      QVAC · local
    </span>
  );
}

export const latestDelivery = (escrow: Escrow): Delivery | undefined =>
  escrow.deliveries.reduce<Delivery | undefined>((a, d) => (!a || d.n > a.n ? d : a), undefined);

/** QVAC's opinion per client_review condition, clearly labelled as advice. */
export function AiOpinion({ escrow, delivery, role }: { escrow: Escrow; delivery: Delivery; role?: Party }) {
  const review = delivery.review;
  const items = escrow.conditions.filter(isClientReview);
  return (
    <div className="space-y-3 rounded-xl border border-violet-200 bg-violet-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-violet-900">
          AI opinion — {role === 'client' ? 'you make the call' : 'the client makes the call'}
        </h3>
        {review && <SourceBadge review={review} />}
      </div>
      {!review ? (
        <p className="flex items-center gap-2 text-violet-700">
          <Spinner /> QVAC is looking at the delivery…
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => {
            const item = review.items.find((i) => i.conditionId === c.id);
            return (
              <li key={c.id} className="rounded-lg bg-white px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-slate-900">{c.description}</p>
                  <OpinionChip opinion={item?.opinion ?? 'unsure'} />
                </div>
                {item?.note && <p className="mt-1 text-slate-700">{item.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm text-violet-800">
        {review?.source === 'template'
          ? 'QVAC was not available for this delivery, so there is no AI opinion.'
          : 'QVAC read the delivered files on this machine. It can be wrong, and a delivery can try to mislead it.'}
        {role === 'client' ? ' Look at the work yourself before you decide.' : ''}
      </p>
    </div>
  );
}

// ---- delivered files ------------------------------------------------------------------------

const ext = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const FRAME = ['html', 'htm', 'svg', 'pdf'];
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const TEXT = ['md', 'txt', 'css', 'js', 'mjs', 'ts', 'tsx', 'json', 'py', 'csv', 'yml', 'yaml', 'toml', 'sh', 'xml'];
const MAX_TEXT_BYTES = 200_000;

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stopped = false;
    setText(undefined);
    setError(undefined);
    fetch(url, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => !stopped && setText(t))
      .catch((err: unknown) => !stopped && setError(errorMessage(err)));
    return () => {
      stopped = true;
    };
  }, [url]);
  if (error) return <ErrorBanner>Could not load the file: {error}</ErrorBanner>;
  if (text === undefined) return <p className="flex items-center gap-2 p-4 text-slate-500"><Spinner /> Loading…</p>;
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-4 text-sm leading-relaxed text-slate-800">{text}</pre>;
}

function FilePreview({ escrow, n, file }: { escrow: Escrow; n: number; file: DeliveryFile }) {
  const url = deliveryFileUrl(escrow.id, n, file.path);
  const e = ext(file.path);
  if (FRAME.includes(e)) {
    // No allow-same-origin and no allow-scripts: the page can't run code or reach the agent API.
    // The agent also serves it with `Content-Security-Policy: sandbox`.
    return <iframe title={file.path} src={url} sandbox="" referrerPolicy="no-referrer" className="h-full w-full bg-white" />;
  }
  if (IMAGE.includes(e)) return <img src={url} alt={file.path} className="mx-auto max-h-full object-contain p-4" />;
  if (TEXT.includes(e) && file.sizeBytes <= MAX_TEXT_BYTES) return <TextPreview url={url} />;
  return <p className="p-4 text-slate-500">No preview for this file. Use “Open” to download it.</p>;
}

const pickDefault = (files: DeliveryFile[]) =>
  files.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ?? files.find((f) => FRAME.includes(ext(f.path))) ?? files[0];

export function DeliveryFiles({ escrow, delivery }: { escrow: Escrow; delivery: Delivery }) {
  const [files, setFiles] = useState<DeliveryFile[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    if (config.fixture) {
      setError('Delivered files are served by the agent (not available in fixture mode).');
      return;
    }
    let stopped = false;
    setError(undefined);
    agentApi
      .deliveryFiles(escrow.id, delivery.n)
      .then((list) => {
        if (stopped) return;
        const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path));
        setFiles(sorted);
        setSelected((s) => s ?? pickDefault(sorted)?.path);
      })
      .catch((err: unknown) => !stopped && setError(errorMessage(err)));
    return () => {
      stopped = true;
    };
  }, [escrow.id, delivery.n, attempt]);

  const file = files?.find((f) => f.path === selected);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        The delivered work · <span className="font-mono normal-case">{delivery.fileName}</span>
      </h3>
      {error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">
          <span>{error}</span>
          {!config.fixture && (
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="rounded border border-slate-300 px-2 py-0.5 text-sm hover:bg-white">
              Try again
            </button>
          )}
        </div>
      ) : !files ? (
        <p className="flex items-center gap-2 text-slate-500">
          <Spinner /> Loading the files…
        </p>
      ) : files.length === 0 ? (
        <p className="text-slate-500">The delivery has no files.</p>
      ) : (
        <div className="grid overflow-hidden rounded-xl border border-slate-300 md:grid-cols-[200px_1fr]">
          <ul className="max-h-[460px] overflow-y-auto border-b border-slate-200 bg-slate-50 py-1 md:border-b-0 md:border-r">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setSelected(f.path)}
                  className={`block w-full truncate px-3 py-1.5 text-left font-mono text-sm ${f.path === selected ? 'bg-white font-semibold text-slate-900' : 'text-slate-600 hover:bg-white'}`}
                  title={`${f.path} · ${(f.sizeBytes / 1024).toFixed(1)} KB`}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-col">
            {file && (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-1.5 text-sm">
                  <span className="truncate font-mono text-slate-600">{file.path}</span>
                  <a href={deliveryFileUrl(escrow.id, delivery.n, file.path)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-sky-700 hover:underline">
                    Open ↗
                  </a>
                </div>
                <div className="h-[420px] bg-slate-50">
                  <FilePreview escrow={escrow} n={delivery.n} file={file} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- approve / dispute ----------------------------------------------------------------------

function approveError(err: unknown): string {
  if (err instanceof HttpError && err.status === 403) return "The agent didn't accept this browser's approval key for this agreement.";
  if (err instanceof HttpError && err.status === 409) return 'This delivery is no longer waiting for your review.';
  return errorMessage(err);
}

function Answer({ escrow, delivery }: { escrow: Escrow; delivery: Delivery }) {
  const token = config.fixture ? 'fixture' : getClientToken(escrow.id);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const send = useAction(async (decision: 'approve' | 'dispute') => {
    if (!token) return;
    try {
      await agentApi.approve(escrow.id, {
        deliveryN: delivery.n,
        decision,
        clientToken: token,
        ...(decision === 'dispute' ? { reason: reason.trim() } : {}),
      });
    } catch (err) {
      throw new Error(approveError(err));
    }
  });
  const amount = `${formatAmount(escrow.amount, escrow.precision)} ${escrow.assetTicker}`;

  if (!token) {
    return (
      <p className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-amber-900">
        This browser doesn't have the approval key for this agreement, so it can't approve or dispute. Use the browser
        the agreement was created in. If nobody answers in time, the freelancer is paid automatically.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {!disputing ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void send.run('approve')}
            disabled={send.busy}
            className="rounded-lg bg-emerald-600 px-6 py-3 text-lg font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {send.busy ? 'Sending…' : `Approve and pay ${amount}`}
          </button>
          <button
            type="button"
            onClick={() => setDisputing(true)}
            disabled={send.busy}
            className="rounded-lg border-2 border-red-300 bg-white px-6 py-3 text-lg font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Dispute
          </button>
        </div>
      ) : (
        <form
          className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void send.run('dispute');
          }}
        >
          <label className="block space-y-1">
            <span className="font-medium text-red-900">What needs fixing? The freelancer sees this.</span>
            <textarea
              className="min-h-20 w-full rounded-lg border border-red-200 bg-white px-3 py-2 focus:border-red-400 focus:outline-none"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              required
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {escrow.conditions.filter(isClientReview).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setReason(`Not met: ${c.description}`)}
                className="rounded-full border border-red-200 bg-white px-3 py-1 text-sm text-red-800 hover:bg-red-100"
              >
                Not met: {c.description}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={send.busy || !reason.trim()}
              className="rounded-lg bg-red-600 px-5 py-2.5 font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {send.busy ? 'Sending…' : 'Send dispute'}
            </button>
            <button type="button" onClick={() => setDisputing(false)} className="rounded-lg px-4 py-2.5 font-medium text-slate-600 hover:bg-white">
              Back
            </button>
          </div>
        </form>
      )}
      {send.error && <ErrorBanner>{send.error}</ErrorBanner>}
    </div>
  );
}

/** The client's review step: look at the work, read QVAC's opinion, then approve or dispute. */
export function ReviewPanel({ escrow }: { escrow: Escrow }) {
  const delivery = latestDelivery(escrow);
  if (!delivery) return null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sky-50 px-5 py-4">
        <p className="text-lg font-medium text-sky-900">All automatic checks passed. Now it's your call.</p>
        {delivery.reviewDueAt && (
          <span className="rounded-full bg-sky-600 px-3 py-1 font-semibold text-white">
            <ReviewCountdown dueAt={delivery.reviewDueAt} />
          </span>
        )}
      </div>
      <DeliveryFiles escrow={escrow} delivery={delivery} />
      <AiOpinion escrow={escrow} delivery={delivery} role="client" />
      <Answer escrow={escrow} delivery={delivery} />
    </div>
  );
}

/** One client_review condition inside a delivery's results: QVAC's opinion and the client's answer. */
export function ReviewResult({
  escrow,
  delivery: d,
  condition,
  role,
  latest,
}: {
  escrow: Escrow;
  delivery: Delivery;
  condition: Escrow['conditions'][number];
  role?: Party;
  latest: boolean;
}) {
  const item = d.review?.items.find((i) => i.conditionId === condition.id);
  const expired = latest && !d.approval && !!d.reviewDueAt && (escrow.state === 'RELEASING' || escrow.state === 'RELEASED');
  const status = d.approval?.decision === 'approve' || expired ? 'pass' : d.approval?.decision === 'dispute' ? 'fail' : undefined;
  return (
    <ReviewConditionCard condition={condition} role={role} status={status}>
      {item && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span className="font-medium text-violet-800">AI opinion:</span>
          <OpinionChip opinion={item.opinion} />
          <span>{item.note}</span>
        </p>
      )}
      {d.approval?.decision === 'approve' && <p className="text-sm font-semibold text-emerald-700">✓ The client approved</p>}
      {d.approval?.decision === 'dispute' && (
        <p className="text-sm font-semibold text-red-700">✗ The client disputed: “{d.approval.reason}”</p>
      )}
      {expired && <p className="text-sm font-semibold text-emerald-700">✓ No answer in time, approved automatically</p>}
    </ReviewConditionCard>
  );
}
