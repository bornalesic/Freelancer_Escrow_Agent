// Files of one delivery. Before the work is paid the agent serves only image previews (to the client and
// the service screen); after release everything can be downloaded. The freelancer always sees its own.
// Files are fetched with the token in a header and shown as blob URLs.
import { useEffect, useState } from 'react';
import type { DeliveryFilesResponse, EscrowState } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { HttpError, errorMessage } from '../lib/http';
import { Button } from './ui';

// No SVG: an SVG can carry scripts, and previews are blob URLs on this app's origin (lib/http.ts).
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_PREVIEWS = 8;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Thumb({ escrowId, n, path, token }: { escrowId: string; n: number; path: string; token: string | undefined }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let blobUrl: string | undefined;
    let stopped = false;
    agentApi.fileUrl(escrowId, n, path, token).then(
      (u) => (stopped ? URL.revokeObjectURL(u) : setUrl((blobUrl = u))),
      () => !stopped && setFailed(true),
    );
    return () => {
      stopped = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [escrowId, n, path, token]);
  return (
    <figure className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      <div className="flex aspect-[4/3] items-center justify-center bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px]">
        {url ? <img src={url} alt={path} className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-slate-400">{failed ? 'Preview unavailable' : 'Loading…'}</span>}
      </div>
      <figcaption className="truncate px-2 py-1 text-xs text-slate-600" title={path}>{path}</figcaption>
    </figure>
  );
}

async function download(escrowId: string, n: number, path: string, token: string | undefined) {
  const url = await agentApi.fileUrl(escrowId, n, path, token);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').at(-1) ?? 'file';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `downloads`: offer full files (the freelancer's own work, or the client's once it is paid). */
export function Previews({ escrowId, n, state, token, downloads }: { escrowId: string; n: number; state: EscrowState; token: string | undefined; downloads: boolean }) {
  const [files, setFiles] = useState<DeliveryFilesResponse>();
  const [error, setError] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const paid = state === 'RELEASED';

  useEffect(() => {
    let stopped = false;
    setError(undefined);
    agentApi.files(escrowId, n, token).then(
      (f) => !stopped && setFiles(f),
      (err) => {
        if (stopped) return;
        setFiles(undefined);
        setError(err instanceof HttpError && err.status === 403 ? 'Only the client and the freelancer can see this work.' : errorMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [escrowId, n, token, paid]);

  if (error) return <p className="text-sm text-slate-500">{error}</p>;
  if (!files) return <p className="text-sm text-slate-500">Loading files…</p>;

  const images = files.filter((f) => f.previewable !== false && IMAGE.test(f.path) && f.sizeBytes <= MAX_PREVIEW_BYTES).slice(0, MAX_PREVIEWS);
  return (
    <div className="space-y-4">
      {images.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((f) => <Thumb key={f.path} escrowId={escrowId} n={n} path={f.path} token={token} />)}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No image previews in this delivery.</p>
      )}

      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          {files.length} file{files.length === 1 ? '' : 's'}
          {!downloads && !paid && ' · previews only until the freelancer is paid'}
        </p>
        <ul className="max-h-60 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 text-sm">
          {files.map((f) => (
            <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate font-mono text-xs text-slate-700" title={f.path}>{f.path}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                {kb(f.sizeBytes)}
                {downloads && f.previewable !== false && (
                  <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => download(escrowId, n, f.path, token).catch((e) => setDownloadError(errorMessage(e)))}>
                    Download
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {downloadError && <p className="mt-1 text-xs text-red-700">{downloadError}</p>}
      </div>
    </div>
  );
}
