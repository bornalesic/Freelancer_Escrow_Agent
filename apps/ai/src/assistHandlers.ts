import type { ASSIST_SCHEMAS, AssistName } from '@escrow/shared';
import type { z } from 'zod';
import { answerQuestion } from './answer.ts';
import type { AssistDeps } from './assist.ts';
import { clarifyAgreement } from './clarify.ts';
import { estimateJob } from './estimate.ts';
import { hintDelivery } from './hint.ts';
import { rewriteTerms } from './rewrite.ts';
import { matchJobs, splitWork } from './team.ts';

type Schemas = typeof ASSIST_SCHEMAS;
export type AssistHandlers = {
  [K in AssistName]: (req: z.infer<Schemas[K]['request']>) => Promise<z.infer<Schemas[K]['result']>>;
};

/** Every /assist/* handler. With `engine: null` (mock mode, model down) each one answers with its fallback. */
export function assistHandlers(deps: AssistDeps & { examples?: boolean }): AssistHandlers {
  return {
    clarify: (req) => clarifyAgreement(req, deps),
    rewrite: (req) => rewriteTerms(req, deps),
    estimate: (req) => estimateJob(req, deps),
    answer: (req) => answerQuestion(req, deps),
    hint: (req) => hintDelivery(req, deps),
    match: (req) => matchJobs(req, deps),
    split: (req) => splitWork(req, deps),
  };
}
