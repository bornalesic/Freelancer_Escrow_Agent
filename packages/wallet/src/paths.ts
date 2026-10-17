// Paths from env vars, resolved against the repo root.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** packages/wallet/src -> repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Relative paths resolve against the repo root, NOT the process cwd: `npm run -w <workspace>` starts
 * each app inside its own folder, so a cwd-relative path gives every process a different file.
 * apps/agent resolves its own paths against the repo root the same way. Absolute paths pass through.
 */
export function resolveFromRepoRoot(path: string): string {
  return resolve(REPO_ROOT, path)
}
