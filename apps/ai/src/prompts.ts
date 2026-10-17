import type { ParseRequest } from '@escrow/shared';
import type { EventFacts } from './facts.ts';

// Prompt versions — bump the version and note the eval score when you change a prompt.
//   parse-v1   2026-10-17  first version (one worked example, JSON schema output). 2B: invented
//                          clarifications copied from the example, padded the summary.
//   parse-v2   2026-10-17  model only outputs `deliverable` + `unclear[{quote, reason}]`; code writes the
//                          summary's payment part and the clarification sentences, and drops any quote
//                          that is not literally in the agreement.
//   explain-v1 2026-10-17  first version. 2B invented "the client will receive 50 tUSDT" after a failed check.
//   explain-v2 2026-10-17  amount/deadline only in facts for money/decision steps, plus a code-written
//                          "money" phrase; money words are rejected unless the facts contain them.
export const PARSE_PROMPT_VERSION = 'parse-v2';
//   explain-v3 2026-10-17  v2 still let 2B invent who-did-what ("the client sent", "the client confirms").
//                          Now the model rewrites the correct template sentence instead of writing freely.
export const EXPLAIN_PROMPT_VERSION = 'explain-v3';

/**
 * Grammar for /parse output (passed as responseFormat json_schema; llama.cpp turns it into GBNF).
 * We do not use a tool + tool_choice: @qvac/sdk 0.21 strips nested tool parameter schemas
 * (no `items`), so `conditions` would be an unconstrained array. See apps/ai/CLAUDE.md.
 */
export const PARSE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    deliverable: { type: 'string' },
    conditions: {
      type: 'array',
      maxItems: 8,
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              kind: { const: 'tests_pass' },
              description: { type: 'string' },
              command: { type: 'string' },
              timeoutSec: { type: 'integer' },
            },
            required: ['kind', 'description', 'command', 'timeoutSec'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'file_present' },
              description: { type: 'string' },
              pathPattern: { type: 'string' },
            },
            required: ['kind', 'description', 'pathPattern'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'file_hash' },
              description: { type: 'string' },
              fileName: { type: 'string' },
              sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
            },
            required: ['kind', 'description', 'sha256'],
            additionalProperties: false,
          },
        ],
      },
    },
    unclear: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          reason: { enum: ['subjective', 'not_checkable'] },
        },
        required: ['quote', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['deliverable', 'conditions', 'unclear'],
  additionalProperties: false,
} as const;

export const PARSE_SYSTEM = `You read a freelance job agreement and extract acceptance checks for an escrow.
A program runs the checks on the files the freelancer uploads. The money is released only if every check passes, so every check must be objective.

Output fields:
- deliverable: one plain sentence saying what the freelancer delivers. Mention only what the agreement says.
- conditions: the objective checks. Allowed kinds:
  - tests_pass: only when the agreement says tests (or a named test command) must pass. command is "npm test" unless the agreement names another command. timeoutSec is 60 unless the agreement gives a time limit for the tests.
  - file_present: only for a file the agreement names. pathPattern is that file name; use "README*" for a README and "LICENSE*" for a license.
  - file_hash: only when a 64-character hex string appears in the agreement. Copy it exactly and set fileName to the file it belongs to.
  Each description is one short sentence a non-programmer understands. Features the agreed tests cover need no extra check.
- unclear: parts of the agreement a program cannot check. quote copies the exact words from the agreement. reason is "subjective" for wishes such as nice, modern, professional, clean, fast, smooth, good quality or well documented, and "not_checkable" for anything else with no test or file. Use an empty list when everything is checkable.

Never turn the payment or the deadline into a check or an unclear item. Never invent files, commands, hashes or quotes. Output JSON only.

Example agreement: "Write a CSV parser in Python. pytest must pass. Include a LICENSE file and make the docs nice. data.zip must have SHA-256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08. Pay 40 USDT."
Example output: {"deliverable":"A CSV parser written in Python.","conditions":[{"kind":"tests_pass","description":"The pytest test suite must pass.","command":"pytest","timeoutSec":60},{"kind":"file_present","description":"A LICENSE file must be included.","pathPattern":"LICENSE*"},{"kind":"file_hash","description":"data.zip must exactly match the agreed fingerprint.","fileName":"data.zip","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}],"unclear":[{"quote":"make the docs nice","reason":"subjective"}]}`;

export function parseUserPrompt(req: ParseRequest): string {
  return `Title: ${req.title}
Payment: ${req.amountDisplay} ${req.assetTicker}
Deadline: ${req.deadline}
Agreement:
<<<
${req.rawText.trim()}
>>>`;
}

export function parseRetryPrompt(error: string): string {
  return `That output was rejected: ${error}
Return the corrected JSON only.`;
}

export const EXPLAIN_SYSTEM = `You rewrite one step of an automated escrow log for the client and the freelancer.
You get the facts and a reference sentence that is correct. Rewrite it in clear, friendly plain English: one or two short sentences, at most 40 words.
Keep the meaning exactly. Who did what must stay the same. Do not add facts, guesses, advice or later steps.
If the facts name a failing test, quote the test name exactly.
No markdown, no lists, no emojis, no greetings.`;

export function explainUserPrompt(facts: EventFacts, reference: string): string {
  return `Facts (JSON): ${JSON.stringify(facts)}
Reference sentence: ${reference}
Rewrite:`;
}
