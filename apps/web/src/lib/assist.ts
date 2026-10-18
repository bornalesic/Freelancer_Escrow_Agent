// QVAC assist calls (docs/AI_ASSIST_PLAN.md), all through the agent: `POST /assist/:name` and the dry run.
// Everything here is advice: a failure must never block the normal flow, so callers treat
// AssistUnavailable as "hide this feature" and carry on.
import {
  AGENT_ROUTES,
  type AnswerRequest, type AnswerResult, type ClarifyRequest, type ClarifyResult, type DryRunResponse,
  type EstimateRequest, type EstimateResult, type MatchRequest, type MatchResult, type RewriteRequest,
  type RewriteResult, type SplitRequest, type SplitResult,
} from '@escrow/shared';
import { config } from '../config';
import { fixtureAssist, fixtureDryRun } from '../fixtures/assist';
import { HttpError, requestJson } from './http';

/** Request and result of each assist the agent proxies (PROXIED_ASSISTS in @escrow/shared). */
export interface AssistTypes {
  clarify: [ClarifyRequest, ClarifyResult];
  rewrite: [RewriteRequest, RewriteResult];
  estimate: [EstimateRequest, EstimateResult];
  answer: [AnswerRequest, AnswerResult];
  match: [MatchRequest, MatchResult];
  split: [SplitRequest, SplitResult];
}
export type AssistName = keyof AssistTypes;

// The agent waits AI_ASSIST_TIMEOUT_MS (20 s) and apps/ai answers with a fallback 5 s before that.
const ASSIST_TIMEOUT_MS = 25_000;
const DRY_RUN_TIMEOUT_MS = 120_000; // runs the freelancer's tests, then asks QVAC for hints

/** The feature cannot be used right now: the agent has no such route yet (404) or QVAC is unreachable. */
export class AssistUnavailable extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = 'AssistUnavailable';
  }
}

/** Routes this agent does not have (an agent without WS3's assist routes): stop asking. */
const missing = new Set<string>();

function unavailable(err: unknown, route: string): never {
  if (err instanceof HttpError && err.status === 404) {
    missing.add(route);
    throw new AssistUnavailable('This agent does not offer this yet.', true);
  }
  if (err instanceof HttpError && (err.status === 503 || err.status === 0)) {
    throw new AssistUnavailable('QVAC is not available right now.', false);
  }
  throw err;
}

export async function assist<N extends AssistName>(name: N, body: AssistTypes[N][0]): Promise<AssistTypes[N][1]> {
  if (config.fixture) return fixtureAssist(name, body);
  const route = AGENT_ROUTES.assist(name);
  if (missing.has(route)) throw new AssistUnavailable('This agent does not offer this yet.', true);
  try {
    return await requestJson<AssistTypes[N][1]>(config.agentUrl, route, { body, timeoutMs: ASSIST_TIMEOUT_MS });
  } catch (err) {
    return unavailable(err, route);
  }
}

/** The verifier on a practice upload, plus QVAC's fix hints. Nothing is submitted and the state does not change. */
export async function dryRun(escrowId: string, file: File): Promise<DryRunResponse> {
  if (config.fixture) return fixtureDryRun(escrowId, file.name);
  const route = AGENT_ROUTES.dryRun(encodeURIComponent(escrowId));
  if (missing.has(AGENT_ROUTES.dryRun(':id'))) throw new AssistUnavailable('This agent does not offer practice checks yet.', true);
  const form = new FormData();
  form.append('file', file);
  try {
    return await requestJson<DryRunResponse>(config.agentUrl, route, { body: form, timeoutMs: DRY_RUN_TIMEOUT_MS });
  } catch (err) {
    // Fastify's own 404 ("Not Found") = no such route; the agent's is "Escrow not found".
    if (err instanceof HttpError && err.status === 404 && !/escrow not found/i.test(err.message)) {
      missing.add(AGENT_ROUTES.dryRun(':id'));
      throw new AssistUnavailable('This agent does not offer practice checks yet.', true);
    }
    throw err; // timeouts, 409 (another dry run, wrong state) and 400 carry a useful message
  }
}

export const isUnavailable = (err: unknown): err is AssistUnavailable => err instanceof AssistUnavailable;
