import { formatAmount, type Condition, type Escrow, type LogEvent, type VerificationResult } from '@escrow/shared';

/**
 * The only facts an explanation may use. Built deterministically from the event + escrow, so both the
 * templates and the LLM prompt see exactly the same data (and the LLM never sees invoices or raw logs).
 *
 * `event.data` keys we understand (all optional; WS3 decides what to send):
 *   role, amount (base units), n / fileName, conditionId, passed, evidence, result (VerificationResult),
 *   results (VerificationResult[]), failedTests (string[]), decision (Decision) or action + reason,
 *   failed (condition ids), txid, message / error.
 */
export interface EventFacts {
  step: string;                 // LogEventType
  title: string;                // deterministic log title written by the agent
  job: string;                  // escrow title
  amount?: string;              // e.g. "50 tUSDT" — only on steps that are about money
  money?: string;               // what happened to the money in this step, in plain words (code-written)
  deadline?: string;            // only where the deadline matters (creation, decisions)
  role?: string;                // who acted (client / freelancer)
  delivery?: { n: number; fileName?: string };
  conditions?: string[];        // terms.proposed: condition descriptions
  clarifications?: string[];
  condition?: { description: string };
  result?: { passed: boolean; exitCode?: number; failingTests?: string[]; problem?: string };
  checks?: { passed: number; total: number; failed: string[] };
  decision?: { action: string; reason?: string };
  txid?: string;
  error?: string;
}

type Data = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Data | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : undefined);

/** Test names that failed, parsed from common runner output (node --test TAP/spec, jest, mocha, pytest). */
export function failingTestNames(stdout: string | undefined, max = 3): string[] {
  if (!stdout) return [];
  const names: string[] = [];
  const patterns = [
    /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm,              // TAP (node --test, non-TTY)
    /^\s*[✖✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/gm, // node spec reporter, jest
    /^FAILED \S+::(\S+)/gm,                                // pytest
  ];
  for (const re of patterns) {
    for (const m of stdout.matchAll(re)) {
      const name = m[1]!.trim();
      // Skip summary lines like "failing tests:" and file-level wrappers.
      if (!name || /^failing tests:?$/i.test(name) || /\.(m?js|ts|cjs)$/.test(name)) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, max);
}

function shortCondition(c: Condition): { description: string } {
  return { description: c.description };
}

function resultFacts(r: Partial<VerificationResult> & { evidence?: Data }, data: Data): EventFacts['result'] {
  const evidence = obj(r.evidence) ?? {};
  const failingTests = Array.isArray(data.failedTests)
    ? data.failedTests.filter((t): t is string => typeof t === 'string').slice(0, 3)
    : failingTestNames(str(evidence.stdoutTail));
  return {
    passed: r.passed === true,
    exitCode: num(evidence.exitCode),
    failingTests: failingTests.length ? failingTests : undefined,
    problem: str(evidence.error),
  };
}

const MONEY_EVENTS = new Set(['funding.invoice_created', 'funding.payment_seen', 'funding.settled',
  'payout.sent', 'payout.settled', 'refund.sent', 'refund.settled']);
const AMOUNT_EVENTS = new Set([...MONEY_EVENTS, 'escrow.created', 'terms.agreed', 'decision.made']);
const DEADLINE_EVENTS = new Set(['escrow.created', 'decision.made']);

const MONEY_PHRASES: Record<string, string> = {
  'funding.invoice_created': 'the client can now pay this amount into escrow',
  'funding.payment_seen': 'the client paid; the transfer is not settled yet',
  'funding.settled': "locked in the escrow agent's wallet",
  'payout.sent': 'sent (released) to the freelancer; the transfer is settling',
  'payout.settled': 'received by the freelancer (released)',
  'refund.sent': 'sent back (refunded) to the client; the transfer is settling',
  'refund.settled': 'received back by the client (refunded)',
};
const DECISION_MONEY: Record<string, string> = {
  release: 'to be released to the freelancer',
  refund: 'to be refunded to the client',
  retry: 'stays locked in escrow',
  wait: 'stays locked in escrow',
};

export function buildFacts(event: LogEvent, escrow: Escrow): EventFacts {
  const data: Data = event.data ?? {};
  const base = str(data.amount) && /^\d+$/.test(String(data.amount)) ? String(data.amount) : escrow.amount;
  const facts: EventFacts = { step: event.type, title: event.title, job: escrow.title };
  if (AMOUNT_EVENTS.has(event.type)) facts.amount = `${formatAmount(base, escrow.precision)} ${escrow.assetTicker}`;
  if (MONEY_PHRASES[event.type]) facts.money = MONEY_PHRASES[event.type];
  if (DEADLINE_EVENTS.has(event.type)) facts.deadline = escrow.deadline;

  const role = str(data.role) ?? (event.actor === 'client' || event.actor === 'freelancer' ? event.actor : undefined);
  if (role && ['terms.accepted', 'escrow.cancelled', 'delivery.received'].includes(event.type)) facts.role = role;

  const lastDelivery = escrow.deliveries.at(-1);
  if (event.type.startsWith('delivery.') || event.type.startsWith('verify.')) {
    const n = num(data.n) ?? lastDelivery?.n;
    if (n !== undefined) {
      facts.delivery = { n, fileName: str(data.fileName) ?? (lastDelivery?.n === n ? lastDelivery.fileName : undefined) };
    }
  }

  if (event.type === 'terms.proposed') {
    facts.conditions = escrow.conditions.map((c) => c.description);
    if (escrow.clarifications?.length) facts.clarifications = escrow.clarifications;
  }

  const conditionId = str(data.conditionId) ?? str(obj(data.result)?.conditionId);
  const condition = conditionId ? escrow.conditions.find((c) => c.id === conditionId) : undefined;
  if (condition) facts.condition = shortCondition(condition);

  if (event.type === 'verify.condition_result') {
    const stored = conditionId ? lastDelivery?.results?.find((r) => r.conditionId === conditionId) : undefined;
    const r = obj(data.result) ?? (typeof data.passed === 'boolean' ? data : undefined) ?? stored;
    if (r) facts.result = resultFacts(r as Partial<VerificationResult>, data);
  }

  if (event.type === 'verify.finished') {
    const results = (Array.isArray(data.results) ? data.results : lastDelivery?.results ?? []) as VerificationResult[];
    if (results.length) {
      const failed = results.filter((r) => !r.passed).map((r) => {
        const c = escrow.conditions.find((x) => x.id === r.conditionId);
        return c?.description ?? r.conditionId;
      });
      facts.checks = { passed: results.length - failed.length, total: results.length, failed };
    } else if (num(data.passed) !== undefined && num(data.total) !== undefined) {
      facts.checks = { passed: num(data.passed)!, total: num(data.total)!, failed: [] };
    }
  }

  if (event.type === 'decision.made') {
    const d = obj(data.decision) ?? data;
    const action = str(d.action);
    if (action) facts.decision = { action, reason: str(d.reason) };
    if (action && DECISION_MONEY[action]) facts.money = DECISION_MONEY[action];
  }

  if (MONEY_EVENTS.has(event.type)) {
    const txid = str(data.txid);
    if (txid) facts.txid = txid.length > 16 ? `${txid.slice(0, 8)}…${txid.slice(-6)}` : txid;
  }

  if (event.type === 'error') facts.error = str(data.message) ?? str(data.error) ?? event.title;
  return facts;
}
