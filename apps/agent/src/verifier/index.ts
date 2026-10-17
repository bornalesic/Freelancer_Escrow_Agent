import fs from 'node:fs';
import path from 'node:path';
import type { Condition, VerificationResult } from '@escrow/shared';
import { errorMessage } from '../util';
import { hashFile } from './hash';
import { findMatches } from './present';
import { runCommand } from './tests';
import { unpack } from './unpack';

export interface Workspace {
  /** The stored upload, exactly as received. */
  uploadPath: string;
  /** Folder conditions run in, or the reason the upload could not be unpacked. */
  root?: string;
  unpackError?: string;
}

export function prepareWorkspace(uploadPath: string, fileName: string, workDir: string): Workspace {
  try {
    return { uploadPath, root: unpack(uploadPath, fileName, workDir) };
  } catch (err) {
    return { uploadPath, unpackError: `Could not unpack the delivery: ${errorMessage(err)}` };
  }
}

/** Evaluate one automatic condition. Never throws: infrastructure problems become a failed result with `error`. */
export async function checkCondition(c: Condition, ws: Workspace): Promise<VerificationResult> {
  const start = Date.now();
  const fail = (error: string, extra: Partial<VerificationResult['evidence']> = {}): VerificationResult => ({
    conditionId: c.id,
    passed: false,
    evidence: { ...extra, durationMs: Date.now() - start, error },
  });

  try {
    if (c.kind === 'file_hash' && !c.fileName) {
      const actual = await hashFile(ws.uploadPath);
      return { conditionId: c.id, passed: actual === c.sha256, evidence: { actualSha256: actual, durationMs: Date.now() - start } };
    }
    if (!ws.root) return fail(ws.unpackError ?? 'Delivery was not unpacked');
    const root = ws.root;

    switch (c.kind) {
      case 'tests_pass': {
        const r = await runCommand(c.command, root, c.timeoutSec);
        return {
          conditionId: c.id,
          passed: !r.timedOut && r.exitCode === 0 && !r.error,
          evidence: {
            ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
            stdoutTail: r.output,
            durationMs: r.durationMs,
            ...(r.error ? { error: r.error } : {}),
          },
        };
      }
      case 'file_hash': {
        const target = path.resolve(root, c.fileName!);
        if (!target.startsWith(root + path.sep)) return fail(`File name must stay inside the delivery: ${c.fileName}`);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(`File not found: ${c.fileName}`);
        const actual = await hashFile(target);
        return { conditionId: c.id, passed: actual === c.sha256, evidence: { actualSha256: actual, durationMs: Date.now() - start } };
      }
      case 'file_present': {
        const matched = await findMatches(root, c.pathPattern);
        return { conditionId: c.id, passed: matched.length > 0, evidence: { matched, durationMs: Date.now() - start } };
      }
      case 'client_review':
        // Never called by the orchestrator (it only checks automatic conditions); here for exhaustiveness.
        return fail('This condition is judged by the client, not the verifier');
    }
  } catch (err) {
    return fail(errorMessage(err));
  }
}
