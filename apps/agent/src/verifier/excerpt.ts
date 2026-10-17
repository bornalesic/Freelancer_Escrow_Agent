import fs from 'node:fs';
import path from 'node:path';
import type { ReviewRequest } from '@escrow/shared';
import { listFiles } from './files';

const PER_FILE_BYTES = 3 * 1024;
const TOTAL_BYTES = 12 * 1024; // fits the 2B model's context next to the prompt
const MAX_FILES = 200;

/** Files the reviewer most likely needs get their excerpt first. */
const priority = (p: string) => {
  const name = path.basename(p).toLowerCase();
  if (/^readme/.test(name) || /^index\.html?$/.test(name)) return 0;
  if (/\.(html?|css|md)$/.test(name)) return 1;
  return 2;
};

/** First `max` bytes of a text file, or undefined for binaries (NUL byte or not valid UTF-8). */
export function readTextHead(file: string, max: number): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const len = fs.readSync(fd, buf, 0, max, 0);
    const head = buf.subarray(0, len);
    if (head.includes(0)) return undefined;
    const text = head.toString('utf8').replace(/�$/, ''); // a multi-byte char cut at the end
    return text.includes('�') ? undefined : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** File tree + the first few KB of each text file, capped at ~12 KB in total, for `POST /review`. */
export function buildReviewFiles(root: string): ReviewRequest['files'] {
  const files: ReviewRequest['files'] = listFiles(root).slice(0, MAX_FILES);
  let budget = TOTAL_BYTES;
  const order = [...files].sort((a, b) => priority(a.path) - priority(b.path));
  for (const f of order) {
    if (budget <= 0) break;
    if (f.sizeBytes === 0) continue;
    const excerpt = readTextHead(path.join(root, f.path), Math.min(PER_FILE_BYTES, budget));
    if (excerpt === undefined) continue;
    f.excerpt = excerpt;
    budget -= Buffer.byteLength(excerpt);
  }
  return files;
}
