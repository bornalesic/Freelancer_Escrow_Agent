// QVAC assists through the agent (`POST /assist/:name`, `POST /escrows/:id/dry-run`). All advice: a
// failure never blocks the flow, callers treat AssistUnavailable as "hide this" and carry on.
import {
  AGENT_ROUTES,
  type AnswerRequest,
  type AnswerResult,
  type DryRunResponse,
  type EstimateRequest,
  type EstimateResult,
  type RewriteRequest,
  type RewriteResult,
} from '@escrow/shared';
import { config } from './config';
import { HttpError, requestJson } from './http';

/** The assists this UI uses (a subset of PROXIED_ASSISTS). */
export interface AssistTypes {
  rewrite: [RewriteRequest, RewriteResult];
  estimate: [EstimateRequest, EstimateResult];
  answer: [AnswerRequest, AnswerResult];
}
export type AssistName = keyof AssistTypes;

// The agent waits 20 s for apps/ai, which answers with a fallback before that.
const ASSIST_TIMEOUT_MS = 25_000;
const DRY_RUN_TIMEOUT_MS = 120_000;

export class AssistUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistUnavailable';
  }
}

export const isUnavailable = (err: unknown): err is AssistUnavailable => err instanceof AssistUnavailable;

export async function assist<N extends AssistName>(name: N, body: AssistTypes[N][0]): Promise<AssistTypes[N][1]> {
  try {
    return await requestJson<AssistTypes[N][1]>(config.agentUrl, AGENT_ROUTES.assist(name), { body, timeoutMs: ASSIST_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof HttpError && [0, 404, 503].includes(err.status)) throw new AssistUnavailable('The AI assistant is not available right now.');
    throw err;
  }
}

/** The verifier on a practice upload, plus QVAC's fix hints. Nothing is submitted, nothing changes. */
export function dryRun(escrowId: string, file: File): Promise<DryRunResponse> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<DryRunResponse>(config.agentUrl, AGENT_ROUTES.dryRun(encodeURIComponent(escrowId)), {
    body: form,
    timeoutMs: DRY_RUN_TIMEOUT_MS,
  });
}
