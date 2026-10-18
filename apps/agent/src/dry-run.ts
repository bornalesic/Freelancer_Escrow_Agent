import fs from 'node:fs';
import path from 'node:path';
import { isAutomaticCondition, type DryRunResponse, type EscrowState, type HintResult, type VerificationResult } from '@escrow/shared';
import type { AiClient } from './ai-client';
import type { Config } from './config';
import { log } from './log';
import type { Upload } from './orchestrator';
import type { Store } from './store';
import { conflict, errorMessage, notFound, safeNow } from './util';
import { checkCondition, prepareWorkspace } from './verifier';
import { buildReviewFiles } from './verifier/excerpt';

/** While the freelancer can deliver (the UI only offers the practice check there). */
export const DRY_RUN_STATES: readonly EscrowState[] = ['FUNDED'];

/**
 * `POST /escrows/:id/dry-run`: the verifier on a practice upload, plus QVAC's fix hints for what failed.
 * Advisory: no state change, no LogEvent, nothing stored. The folder it ran in is deleted afterwards.
 */
export class DryRuns {
  private running = new Set<string>();

  constructor(private d: { config: Config; store: Store; ai: AiClient }) {}

  async run(id: string, upload: Upload): Promise<DryRunResponse> {
    const e = this.d.store.get(id);
    if (!e) throw notFound('Escrow');
    if (!DRY_RUN_STATES.includes(e.state)) {
      throw conflict(`A practice check is possible while the escrow is funded and waiting for the work (state is ${e.state})`);
    }
    if (safeNow().getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has passed, so deliveries are closed');
    if (this.running.has(id)) throw conflict('A practice check for this job is already running');

    this.running.add(id);
    const workDir = path.join(this.d.config.dataDir, 'work', id, `dry-${Date.now()}`);
    const started = Date.now();
    try {
      const ws = prepareWorkspace(upload.tmpPath, upload.fileName, workDir);
      // Excerpts for the hints come from the upload as sent, before its test command can change the folder.
      const files = ws.root ? buildReviewFiles(ws.root) : [];
      const results: VerificationResult[] = [];
      for (const c of e.conditions.filter(isAutomaticCondition)) results.push(await checkCondition(c, ws));
      const passed = results.filter((r) => r.passed).length;

      let hints: HintResult | undefined;
      if (passed < results.length) {
        try {
          hints = await this.d.ai.assist('hint', { escrow: e, results, files });
        } catch (err) {
          log.warn(`dry run ${id}: no hints (${errorMessage(err)})`);
        }
      }
      log.info(`dry run ${id}: ${passed}/${results.length} passed${hints ? `, hints from ${hints.source}` : ''} in ${Date.now() - started}ms`);
      return { results, passed, total: results.length, ...(hints ? { hints } : {}) };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      this.running.delete(id);
    }
  }
}
