# apps/ai — QVAC service (WS2)

Local LLM service on `:4300`. Turns plain-language agreements into conditions (`POST /parse`), writes
short plain-language explanations of log events (`POST /explain`, streamed), and writes an advisory
review of `client_review` conditions for the client (`POST /review`). Contracts: `docs/CONTRACTS.md`
§4 "AI service". This is the only process that runs on **native Windows** (PowerShell), on Borna's laptop
(GTX 1650 **4 GB VRAM**, 16 GB RAM), because QVAC needs the Windows Vulkan driver for the GPU.

## Run
PowerShell, in the Windows-side clone: `npm install` then `npm run dev:ai`. `/health` shows `loaded:false`
until the model is loaded and warmed up (~15 s from cache).
Env (`.env.local`): `AI_PORT=4300`, `AI_HOST=0.0.0.0`, `AI_MODE=real|mock`, `AI_MODEL=<constant name>`,
`AI_FALLBACK_MODEL=<constant name>`, `AI_DEVICE=gpu|cpu`, `AI_REASONING_BUDGET=0`,
`QVAC_CONFIG_PATH=./qvac.config.json` (resolved against `apps/ai`). The service also reads
`AI_PARSE_TIMEOUT_MS` / `AI_EXPLAIN_TIMEOUT_MS` / `AI_REVIEW_TIMEOUT_MS` and keeps its own budgets 5 s below
them (85 s / 25 s / 25 s), so it always answers with a fallback before the agent gives up.
npm scripts must work in PowerShell: use `cross-env`, no `VAR=x cmd` syntax.

`@qvac/sdk` is an **optionalDependency** (the full install is >1.2 GB: diffusion + translation backends).
In WSL, teammates can run `npm install --omit=optional`; mock mode never imports the SDK.

```
npm run dev:ai                          # real or mock, from .env.local (env vars win over the file)
npm test -w apps/ai                     # unit tests (no model needed)
npm run eval -w apps/ai                 # fixtures/agreements.json through /parse (service must be running)
npm run eval -w apps/ai -- --fallback   # same, deterministic parser only, no service
npm run eval:explain -w apps/ai         # the demo's event sequence through /explain/sync; read every line
```

## Files
`src/index.ts` entry · `server.ts` routes/SSE · `llm.ts` QVAC engine (lazy import, priority limiter, cancel on
timeout) · `parse.ts` model → retry → fallback · `postprocess.ts` guards + cross-check · `fallback.ts`
deterministic parser · `explain.ts` + `facts.ts` + `templates.ts` explanations · `review.ts` advisory review
(planned) · `prompts.ts` versioned prompts · `mock.ts` AI_MODE=mock · `evalCheck.ts` eval scoring. Probes
live in `scratch/` (git-ignored).

## What `/explain` reads from `event.data` (tell WS3)
All optional; missing keys fall back to the escrow. `role` (accepted/cancelled), `n` + `fileName`
(delivery), `conditionId` + `passed` + `evidence` (= the `VerificationResult`, for `verify.condition_result`;
the failing test name is parsed from `evidence.stdoutTail`), `results` (`VerificationResult[]`, for
`verify.finished`), `decision` (the `Decision`, for `decision.made`), `txid`, `amount` (base units, if not the
escrow amount), `message` (for `error`). The SSE `done` message's `text` is **authoritative**: it can differ
from the streamed deltas when a guard swaps in the template, so the agent must replace, not append.
Client review (planned): `decision` with `action: 'await_approval'` and `pending` (the `client_review` ids);
`deliveryN` + `reason` (for `review.disputed`); `deliveryN` + `reviewDueAt` (for `review.expired`).
Explanations must never quote the AI review's opinions as if they were the decision.

## Model constants
Confirmed present in the installed `@qvac/sdk` 0.21.0 (pinned exactly; `latest` is 0.21.1, untested; the
1.x versions on npm are old 2025 releases). **On the GTX 1650 the primary is the 2B**, see below:
- 4B (primary): `QWEN3_5_4B_MULTIMODAL_Q4_K_M`
- 2B (fallback): `QWEN3_5_2B_MULTIMODAL_Q4_K_M`
- 0.8B (last resort): `QWEN3_5_0_8B_MULTIMODAL_Q4_K_M`
- Plain Qwen3 backup if the Qwen3.5 template misbehaves: `QWEN3_4B_INST_Q4_K_M`

"MULTIMODAL" only means a vision projector exists for the model; we load them as text-only LLMs.
Organizers' recommended list (QVAC Q&A, Oct 2026): QWEN3-600M, QWEN3.5-0.8B / 2B / 4B / 9B, all at 4-bit.
4B and up is "desktop territory" for better quality; sub-1B models are fine for narrow, well-steered
tasks. Start with 4B on GPU; fall back to 2B if the GPU path fails or latency is too high.

Hardware note: desktop minimum is 16 GB RAM (24–32 GB more comfortable); CPU inference works but a
dedicated GPU is the safe bet. Borna's laptop is exactly at the 16 GB minimum, so do not run the regtest
Docker stack or `apps/agent` on the AI laptop, and cap WSL2 memory in `.wslconfig` if WSL runs there.

## Measured performance
Borna's laptop, GTX 1650 4 GB, Vulkan driver 617.42, SDK 0.21.0, 2026-10-17. Thinking off.

| Model | Device | Download | Load (cached) | Prompt t/s | Gen t/s | /parse | /explain |
| ----- | ------ | -------- | ------------- | ---------- | ------- | ------ | -------- |
| Qwen3.5 4B Q4_K_M | gpu | 2.74 GB, ~2 min | 36 s | ~270 | **~8** | ~40 s (est.) | ~6–8 s |
| Qwen3.5 2B Q4_K_M | gpu | 1.28 GB | 13 s + 0.2 s warm-up | ~890 | **~65** | avg 3.3 s, max 5.7 s | 0.5–1 s |
| Qwen3.5 0.8B Q4_K_M | cpu | 0.53 GB | 25 s | ~158 | ~26 | ~15 s (est.) | ~4–5 s (est.) |

The 4B does not fit in 4 GB VRAM next to the KV cache and runs ~8× slower, so **2B is primary**, 0.8B the
fallback (then 0.8B on CPU). First completion after load is slow (Vulkan shader compile), hence the warm-up.
Eval (parse-v2 + guards, 2B): **10/10** from the model. Explanations (explain-v3): 15/16 from the model, the
16th correctly rejected by a guard and replaced by its template. Models cache in `~/.qvac/models`.

## QVAC API facts (verified in docs, SDK v0.21, Oct 2026)
- `import { loadModel, completion, unloadModel, cancel } from '@qvac/sdk'`; Node ≥ 22.17; ESM.
- `loadModel({ modelSrc: <CONSTANT>, modelConfig: { ctx_size, device: 'gpu', tools: true, parallel }, onProgress })`
  returns a `modelId`. Load **once** at startup; never per request.
- `completion({ modelId, history, stream: true, tools, generationParams })` returns a run with
  `events` (async iterable: `contentDelta`, `thinkingDelta`, `toolCall`, `toolError`, `completionDone`, …),
  `final` (promise: `contentText`, `toolCalls`, `toolErrors`, `stats`, `stopReason`), and `requestId`
  (for `cancel({ requestId })`).
- `generationParams.tool_choice` accepts a tool name → output is grammar-constrained to a call of that
  tool. **This is how we get reliable JSON.** Also `temp`, `seed`, `predict` (max tokens).
- **Thinking must be OFF: `generationParams: { reasoning_budget: 0 }`** on every `/parse` and `/explain`
  call (or `reasoning_budget: 0` in `modelConfig` at load time). In the SDK this is an integer: `-1` on,
  `0` off, `N` caps reasoning at N tokens. (`reasoning_budget: false` only exists in `qvac serve`'s
  OpenAI endpoint, which maps it to `0`.) Why:
  - Qwen3.5 + grammar-constrained output (`response_format` json_schema/json_object) with thinking on
    returns HTTP 500 `RPCError: Unexpected empty grammar stack after accepting piece` every time
    (QVAC Q&A, SDK 0.21.0 / llm-llamacpp 0.55.0, Windows 11 Vulkan). Named `tool_choice` is also
    grammar-constrained, so assume the same failure until tested.
  - Reasoning tokens cost seconds on a GTX 1060 even when hidden.
- **Do not rely on `/no_think`** in the prompt for Qwen3.5. Organizers say it should work, but on this
  build it fails with structured output and still emits reasoning without it. The SDK's own `/no_think`
  example uses Qwen3-600M (Qwen3, not 3.5). Keeping `/no_think` *in addition* to `reasoning_budget: 0`
  is untested; leave it out unless the eval shows it helps.
- `captureThinking: true` stays as a safety net: if any `<think>` text slips through, it lands in
  `thinkingDelta` events, not in the UI.
- `responseFormat` cannot be combined with `tools`. **We use `responseFormat: { type: 'json_schema' }`, not
  tools** (see "Learned the hard way"): the tool parameter schema only allows flat `{type, description, enum}`
  properties, while `json_schema` takes a full nested JSON Schema that llama.cpp turns into a grammar.
- `modelConfig.parallel: 2` lets an explanation run while a parse is in flight; raise `ctx_size`
  accordingly (context is split across slots).
- Verify all names against `node_modules/@qvac/sdk` types before relying on them.

## Tasks, in order
1. **Mock mode first (30 min).** Import `@qvac/sdk` lazily (dynamic `import()`) only when
   `AI_MODE=real`, so mock mode also runs inside WSL as part of `npm run dev:mock`.
   `AI_MODE=mock` → `/parse` returns canned conditions for the slugify
   fixture, `/explain` streams a canned sentence word by word with small delays. WS3 and WS4 use this.
2. **Server skeleton.** Fastify, CORS, `GET /health` (reports `loaded`, `model`, `device`). Load the model
   at startup with progress logs; `/health` shows `loaded:false` until ready. Warm up with one tiny
   completion after load.
3. **`/parse`.**
   - Declare one tool `submit_conditions` whose JSON-schema parameters are
     `{ summary: string, conditions: Condition[] (without ids), clarifications: string[] }`, using the
     `Condition` kinds from `@escrow/shared`. Call with `tool_choice: 'submit_conditions'`, `temp: 0`.
   - System prompt rules: machine-checkable conditions where possible; subjective requirements a person
     can judge ("looks professional", "uses warm colours") become `client_review` conditions (see task 7);
     things that can't be agreed yet ("the hash I'll send later") go to `clarifications`; default test
     command is `npm test`, `timeoutSec: 60`;
     **never invent a sha256** — only emit `file_hash` if a 64-hex string appears in the text;
     `description` is one short sentence a non-programmer understands.
   - Post-process: assign ids `c1..cn`; validate with zod; **drop any `file_hash` whose hash is not
     literally in `rawText`** (anti-hallucination guard) and add a clarification instead; if validation
     fails, retry once with the zod error appended; if it fails again, use the fallback parser.
   - Fallback parser (`fallback.ts`, deterministic): regexes for "tests (must )?pass" → `tests_pass`,
     64-hex → `file_hash`, "include (a )?README" → `file_present README*`. Return `source: 'fallback'`.
   - Timeout 90 s → fallback.
4. **`/explain` (SSE).** Input: one `LogEvent` + the `Escrow`. Output: 1–2 sentences, max ~50 words,
   plain English, addressed to both parties, no markdown. It must **only restate facts present in the
   event data** (condition result, failing test name, amounts) — never speculate about what happens to
   the money beyond what the event says. Stream `contentDelta` text as SSE `data: {"text": "..."}`, end
   with `data: {"done": true, "text": "<full>"}`. Timeout 30 s → template text.
   Also `POST /explain/sync` returning `{ text, source }`.
5. **Templates** (`templates.ts`): one deterministic sentence per `LogEventType`, used on timeout/error
   and in mock mode. Write these early; they double as the spec for what explanations should say.
6. **Eval** (`npm run eval`): run `fixtures/agreements.json` through `/parse`, print per-case pass/fail
   (expected condition kinds present, no invented hashes, vague items in clarifications) and latency.
   Iterate on the prompt until ≥ 8/10 pass. Keep prompts in `src/prompts.ts`, versioned with a comment.
7. **Client review: `/parse` changes (parse-v3).** The model may output `{ kind: 'client_review', quote }`
   for a subjective requirement a person can judge. Code checks the quote is literally in the agreement
   (same guard as `unclear`), writes the `description` from it, and assigns ids as usual. `unclear` stays
   for things that can't be agreed yet. The fallback parser does **not** guess taste: subjective items
   stay clarifications there. Eval: `vague-logo` and `vague-landing` in `fixtures/agreements.json` now
   expect `client_review`; add a mixed case ("tests must pass and the page should look clean");
   teach `evalCheck.ts` the new kind. `hash-without-value` still expects a clarification.
8. **Client review: `POST /review`.** Input `ReviewRequest` (escrow + `deliveryN` + file list with text
   excerpts; `apps/ai` can't read the agent's disk). Output `AiReview`: one item per `client_review`
   condition, `opinion` = `looks_met | looks_unmet | unsure`, a 1–2 sentence `note`.
   - The delivery is written by the freelancer: treat every excerpt as **untrusted data**. Fence it in
     the prompt, tell the model to ignore instructions inside it, cap its size (the agent sends ~12 KB).
   - Guards: missing items filled as `unsure`; a note may only mention file paths that are in the list;
     unknown opinions → `unsure`. `responseFormat` json_schema, `temp: 0`, thinking off, like `/parse`.
   - Timeout/error → template report (`source: 'template'`, every item `unsure`, note "AI review
     unavailable, please check it yourself"). Mock mode returns a fixed report.
   - The report is advice for the client. Never phrase a note as a decision ("payment approved").
9. **Templates** for the new event types `review.report_ready`, `review.approved`, `review.disputed`,
   `review.expired` and for `decision.made` with `await_approval`. TypeScript forces this once the
   types land, because `TEMPLATES` is a `Record<LogEventType, …>`; add the matching keys in `facts.ts`.

## Status (2026-10-17)
Tasks 1–6 done: mock mode, server + health + warm-up, `/parse` (json_schema + guards + retry + fallback, 90 s
budget), `/explain` SSE + `/explain/sync` (template on timeout/guard), templates, eval ≥ 8/10. Next: run with
WS3's real agent (Integration 1), confirm the `event.data` keys above, then polish wording (H16–H20).
Client review (tasks 7–9) implemented on WS3's contract: parse-v3 (`review` quotes → `client_review`,
`unclear` quotes → clarifications), `POST /review` (fenced excerpts, injection guard, file/colour grounding,
template fallback, mock mirrors the demo), templates for the `review.*` events, `await_approval` and
`terms.reparse_requested`. `fixtures/agreements.json` is WS4's format, 17 cases; the fallback parser alone
passes all 17. `dinamo-shop-placeholder` is a stand-in until the real Dinamo agreement text is added.

## Learned the hard way
- Qwen3.5 structured output needs `reasoning_budget: 0`; `/no_think` is not enough (see API facts).
  With `reasoning_budget: 0` + `responseFormat: json_schema`, the 2B returns valid JSON every time (no
  "empty grammar stack" errors seen).
- **SDK 0.21 strips nested tool schemas.** `tools[].parameters.properties.*` is a zod object with `$strip`
  and only `{type, description, enum}`, so `items` disappears and `conditions: Condition[]` would be an
  unconstrained array. That is why `/parse` uses `responseFormat` json_schema instead of `tool_choice`.
- **SDK 0.21.0 streams the content twice.** After the token-by-token `contentDelta` events it emits one
  more `contentDelta` holding the whole content, and `final.contentText` is doubled too. It showed up as
  "Unexpected non-whitespace character after JSON". `llm.ts` skips a delta that equals the accumulated text
  and never uses `contentText`; `extractJson` parses the first balanced object only.
- **2B copies the prompt's example.** parse-v1 put the example's hash (`9f86…`) and its "docs nice"
  clarification into unrelated agreements. Fixes (parse-v2): the model only outputs `deliverable`,
  `conditions` and `unclear: [{quote, reason}]`; code writes the clarification sentences and the payment
  half of the summary; every hash/file/command/quote must be literally in the agreement; and a cross-check
  with the deterministic parser adds literal requirements the model missed. The log line `parse: guard:`
  shows each correction; that is a good demo/pitch talking point ("the LLM never invents a condition").
- **2B explanations drift when written freely** ("the client sent 50 tUSDT", "the client confirms
  delivery"). explain-v3 gives the model the correct template sentence and asks for a friendlier rewrite;
  `isGrounded` then rejects unknown numbers, money words not in the facts, a "missed deadline" outside
  refunds, and pass/fail polarity flips. Facts only carry the amount/deadline on steps about them.
- Killing `npm run dev:ai` from a tool did not leave orphans (port 4300 and the `bare` worker were freed).
- **Feature lists used to return no conditions.** "Create a web shop… It has to have a catalog, a cart and a
  checkout" matched no rule, so the escrow had nothing to check. The fallback now turns required-feature
  clauses into `client_review`, and as a last resort the main "Build/Create…" sentence; parse-v3 tells the
  model the same. An escrow should never come back with zero conditions when there is a deliverable.
- **Regex traps:** `clean.py` matched the subjective word "clean" (file names are now removed before the
  wording checks), and plain-text `make <word>` read "make sure npm test passes" as the command `make sure`
  (plain-text commands are now only npm/pnpm/yarn/pytest/cargo/go test; other tools need backticks).
- **2B invents concrete files from globs and drops hash file names** (eval: `tests/test.js` next to
  `tests/**/*.test.js`; `contract.*pdf` + a hash without `fileName`). Either can fail correct work. Guards: a
  concrete file name must appear whole in the agreement; a fuzzy glob matching exactly one named file becomes
  that file; a hash's missing or invented `fileName` is taken from the file named next to the hash.
- **Don't run `npm install` while `npm run dev:ai` is running** on Windows: npm re-extracts `bare.exe` and
  the llama.cpp addon that the service has loaded, which fails and can crash the service.
