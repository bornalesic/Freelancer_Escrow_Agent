# apps/ai — QVAC service (WS2)

Local LLM service on `:4300`. Turns plain-language agreements into conditions (`POST /parse`) and writes
short plain-language explanations of log events (`POST /explain`, streamed). Contracts: `docs/CONTRACTS.md`
§4 "AI service". This is the only process that runs on **native Windows** (PowerShell), on Borna's laptop
(GTX 1060, 16 GB RAM), because QVAC needs the Windows Vulkan driver for the GPU.

## Run
PowerShell, in the Windows-side clone: `npm install` then `npm run dev:ai`.
Env (`.env.local`): `AI_PORT=4300`, `AI_HOST=0.0.0.0`, `AI_MODE=real|mock`, `AI_MODEL=<constant name>`,
`AI_FALLBACK_MODEL=<constant name>`, `AI_DEVICE=gpu|cpu`, `AI_REASONING_BUDGET=0`,
`QVAC_CONFIG_PATH=./qvac.config.json`.
npm scripts must work in PowerShell: use `cross-env`, no `VAR=x cmd` syntax.

## Model constants
Found in the `@qvac/sdk` 0.21.0 package (confirm on your install with the grep in `docs/SETUP.md`):
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
(fill in: model, device, load time, tokens/s, /parse latency, /explain latency)

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
- `responseFormat` cannot be combined with `tools` — we use only `tools` + `tool_choice`.
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
   - System prompt rules: only machine-checkable conditions; subjective requirements ("looks nice",
     "good quality") go to `clarifications`; default test command is `npm test`, `timeoutSec: 60`;
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

## Learned the hard way
- Qwen3.5 structured output needs `reasoning_budget: 0`; `/no_think` is not enough (see API facts).
(add more)
