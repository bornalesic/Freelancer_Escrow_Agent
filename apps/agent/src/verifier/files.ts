import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeliveryFile } from '@escrow/shared';
import { unpack, workspaceRoot } from './unpack';

const MAX_LISTED = 500;
const SKIP_DIRS = new Set(['node_modules', '__MACOSX']);

/**
 * A fresh unpack of delivery `n` under `data/files/<escrowId>/<n>/`, used for the client's file browser
 * and the AI review. Separate from `data/work`, where the freelancer's test command runs and could
 * change files or plant symlinks. Unpacked once (into a temp folder, then renamed), then reused.
 */
export function deliveryRoot(dataDir: string, escrowId: string, n: number, fileName: string): string {
  const dir = path.join(dataDir, 'files', escrowId, String(n));
  if (!fs.existsSync(dir)) {
    const upload = path.join(dataDir, 'deliverables', escrowId, String(n), fileName);
    const tmp = `${dir}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      unpack(upload, fileName, tmp);
      fs.renameSync(tmp, dir);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(dir)) throw err; // otherwise a concurrent request unpacked it first
    }
  }
  return workspaceRoot(dir);
}

/** Regular files under `root` (no symlinks, no dotfiles, no node_modules), sorted, "/"-separated. */
export function listFiles(root: string): DeliveryFile[] {
  const out: DeliveryFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LISTED) return;
      if (d.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), relPath);
      } else if (d.isFile()) {
        out.push({ path: relPath, sizeBytes: fs.statSync(path.join(dir, d.name)).size });
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * Absolute path of `relPath` inside `root`, or undefined unless it is a regular file that really lives
 * there (same rules as unpack: no absolute paths, no `..`, no symlinks out).
 */
export function resolveDeliveryFile(root: string, relPath: string): string | undefined {
  const rel = relPath.replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
    return undefined;
  }
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) return undefined;
  try {
    if (!fs.lstatSync(target).isFile()) return undefined;
    const real = fs.realpathSync(target);
    return real.startsWith(fs.realpathSync(root) + path.sep) ? target : undefined;
  } catch {
    return undefined;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
const TEXT = new Set(['.md', '.txt', '.ts', '.tsx', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.csv', '.xml']);

export function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return TYPES[ext] ?? (TEXT.has(ext) || !ext ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}
