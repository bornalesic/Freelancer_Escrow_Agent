# AI assist features: plan and per-workstream tasks

Written 2026-10-18 04:00 (WS2). Seven features in which QVAC helps people write and meet the terms. All of
them are **advisory**: none of them moves money or feeds `decide()`. Rule 1 still holds: release/refund
comes only from `decide()`, which reads the automatic results, the client's answer, the state and the clock.

**Go / no-go.** This comes after the H4 "contracts now or never" checkpoint and close to the H20 freeze.
Integration 2 (real RGB) comes first. Build in tier order and stop wherever the clock runs out; anything not
working at the freeze is cut and becomes a roadmap slide. Every feature fails soft: when the AI is down,
the old flow still works.

## The features

| # | Feature | AI (WS2) | Agent (WS3) | UI (WS4) | Tier |
| - | ------- | -------- | ----------- | -------- | ---- |
| 1 | **Example checks**: example inputs with expected outputs become an automatic `examples` condition (QVAC asks for them in the interview and turns them into a check; see below for why it does not invent them) | `/parse` builds them | flip `examples` into `ConditionSchema`, verifier runs the rendered test file | show the examples, "download acceptance test" | **A** |
| 2 | **Pre-submission dry run**: freelancer runs the verifier first; QVAC says why a check failed and where to look | `POST /assist/hint` | `POST /escrows/:id/dry-run` | "Check without submitting" in the upload panel | **A** |
| 3 | **Clarifying interview**: QVAC asks up to 3 questions before parsing | `POST /assist/clarify` | generic proxy `POST /assist/:name` | questions card on the new-agreement form | **A** |
| 4 | **Verifiability score + measurable rewrites** | `POST /assist/rewrite` | (proxy) | "5 of 6 checked automatically" badge; "Make it checkable" under each client-review item | **A** |
| 5 | **Fair price and deadline** warnings | `POST /assist/estimate` | (proxy) | warnings under the amount/deadline fields | B |
| 6 | **Listing Q&A**: AI answers from the terms; otherwise the question goes to the client | `POST /assist/answer` | (proxy); forwarding to the client needs Q&A state (tier C) | "Ask about this job" on the terms | B / C |
| 7 | **Job matching and team splitting** | `POST /assist/match`, `/assist/split` | (proxy) | "My skills" sort on the job list; "Split with my team" | C |

Tier A carries the demo: it turns "the included tests must pass" (tests the freelancer wrote and could
delete) into **checks the client agreed to**. It also makes the fail → fix → pass loop a guided one. Once the
generic proxy exists, features 3–7 cost WS3 nothing.

## Why "examples" and not AI-written test code
The 2B model writes unreliable code, and a client can't review test code, but anyone can read
`slugify("Hello, World!") → "hello-world"`. So a check is **only data** (inputs + expected outputs).
`renderExamplesTest()` in `@escrow/shared` turns that data into a zero-dependency `node:test` file, and
the same file is used by:
- the verifier: `node --test --test-reporter=spec <file>`, run in the delivery root through the existing
  `runCommand` (same timeout, minimal env, process-tree kill, 40-line tail). Failing tests are named
  `slugify("Hello, World!") → "hello-world"`, and the output ends with `actual:` / `expected:`. This means
  `/explain` already quotes them, with no change.
- the freelancer: "Download acceptance test" lets them run exactly what the agent will run.

The examples are conditions, so they are inside `termsHash`. Both parties see and accept the exact cases
before any money moves.

**Measured: the 2B cannot be trusted to write expected outputs** (probe on the demo agreement, 6–8 runs per
prompt version, details in `apps/ai/CLAUDE.md`). The first version guessed `"Hello World 123" → "hello-world123"`,
and the correct `slugify-v2` failed 5 of 6 runs. Making it show each step fixed the outputs, but it then only
tested "Hello World", so the buggy v1 passed. One example per rule still skipped the strip rule. A wrong
expected output withholds an honest freelancer's money, and on stage it would block the payout. So by default
(`AI_EXAMPLES=on`) the examples come from **people**: written in the agreement (`For example, "Hello, World!"
becomes "hello-world".`) or given in the clarifying interview, which asks for one when a function job has none.
QVAC's part is asking for them, turning them into the check (also in the fallback parser) and offering
example-form rewrites. `AI_EXAMPLES=model` keeps the model path for a bigger model (re-run
`scratch/probe-assist.ts` first). Guards: the function name or command must be written in the agreement, and
a client-review item about the same function is dropped once the examples check it. `AI_EXAMPLES=off` is the
kill switch.

**Suggestion for WS4 (demo):** add one sentence to the slugify agreement, `For example, "Hello, World!" becomes
"hello-world".`. With the kind flipped, the terms then show a third, automatic check that the agent itself
runs. v1 fails it on the punctuation case, just like the included tests, and the freelancer cannot get around
it by editing their own tests.

## Contract (in `packages/shared` on `ws/ai`, all additive, typecheck green)
- `src/examples.ts`: `ExamplesConditionSchema` (**standalone, not yet in `ConditionSchema`**),
  `ExampleCase`, `ExamplesTarget` (`js_function {export, file?}` | `command {command}`),
  `renderExamplesTest(c)`, `examplesTestCommand(path)`, `exampleTestName()`. Tested against the slugify
  v1/v2 fixtures (`packages/shared/test/assist.test.ts`).
- `src/assist.ts`: request/result schemas for `clarify`, `rewrite`, `estimate`, `answer`, `hint`, `match`,
  `split`; the `ASSIST_SCHEMAS` registry; `PROXIED_ASSISTS` (all except `hint`); `DryRunResponseSchema`;
  pure helpers `withInterviewAnswers()`, `applyRewrite()`, `verifiability()`.
- Routes: `AI_ROUTES.assist(name)` = `/assist/<name>`, `AGENT_ROUTES.assist(':name')`,
  `AGENT_ROUTES.dryRun(':id')`.
- Env (`.env.example`): `AI_ASSIST_TIMEOUT_MS=20000` (agent → AI for every assist, the AI keeps 5 s
  below it), `AI_EXAMPLES=on` (AI kill switch for feature 1).
- Every assist result has `source: 'ai' | 'fallback'`. A deterministic fallback always answers, so a
  `503` from the agent only means the AI service is unreachable.

**The one step that is not additive** (WS3, feature 1): add `ExamplesConditionSchema` to the
`ConditionSchema` union and `CONDITION_KINDS`. That breaks every exhaustive switch over `Condition['kind']`
(agent verifier, web `KIND_TITLE` / `conditionDetail`; `apps/ai` already handles the kind), so it lands
in one WS3 commit together with the verifier case. `apps/ai` only emits `examples` once `ConditionSchema`
accepts them (checked at runtime), so nothing changes before that commit. **Both the agent
laptop and the AI laptop must run the same `main`**, or the agent rejects the parse and uses its fallback.

## WS2 — AI (Borna) — done on `ws/ai` (2026-10-18)
- [x] `/parse`: examples written in the agreement/interview become one `examples` check (fallback too), once
      the kind is in `ConditionSchema`. Model-proposed cases built and measured, off by default (above).
- [x] `/assist/hint`, `/assist/clarify`, `/assist/rewrite`, `/assist/estimate`, `/assist/answer`,
      `/assist/match`, `/assist/split`: prompt + JSON schema + guards + deterministic fallback each, run
      against the real 2B (all 0.7–5 s).
- [x] Mock mode returns the deterministic fallback for every assist (so WS3/WS4 can build on `dev:mock`).
- [x] `/explain` for a failed test quotes expected vs actual (the INTEGRATION_PLAN item): "...did not pass (it
      expected "hello-world" but got "hello,-world!")", 4/4 from the model. Parse eval still 17/17.
- [x] Templates/facts handle the `examples` kind (summary sentence, failing example names).

## WS3 — Agent — tasks (details in `apps/agent/CLAUDE.md` → "AI assist features")
1. **A · Generic proxy** `POST /assist/:name` (~30 min). Covers features 3–7.
2. **A · `examples` kind**: flip the union, verifier case (~40 lines with the shared renderer), tests on
   slugify v1/v2.
3. **A · Dry run** `POST /escrows/:id/dry-run` → `DryRunResponse`, calling `/assist/hint` itself.
4. C · Q&A forwarding to the client (state + routes + `qa.*` events): only if everything above is done.

## WS4 — UI — tasks (details in `apps/web/CLAUDE.md` → "AI assist features")
1. **A** Verifiability badge (no AI, just `verifiability(conditions)`) + "Make it checkable" rewrites.
2. **A** Clarifying interview card on the new-agreement form.
3. **A** Dry run + hints in the upload panel.
4. **A** `examples` cards in the terms + "Download acceptance test" (once WS3 flips the kind).
5. B Price/deadline warnings; Q&A box. C Skills match + team split.
6. Demo script: suggested beat for 1:50 is "freelancer checks v1 first → QVAC: `slugify.js` never strips
   punctuation, `"Hello, World!"` became `"hello,-world!"` → fix → v2 passes → submit → paid". Keep one real
   failed submission somewhere (in the script or in Q&A) so the judges still see `decide()` refusing payment.

## WS1 — Wallet
No wallet changes. If you have slack, take the dry-run route off WS3 (it reuses the delivery upload and
`prepareWorkspace` / `checkCondition`).

## Team chat message
```
CONTRACT CHANGE (additive): AI assist features (docs/AI_ASSIST_PLAN.md). New in @escrow/shared: assist.ts
(/assist/* schemas, PROXIED_ASSISTS, DryRunResponse, withInterviewAnswers/applyRewrite/verifiability),
examples.ts (ExamplesConditionSchema standalone + renderExamplesTest), AGENT_ROUTES.assist/dryRun,
AI_ROUTES.assist, env AI_ASSIST_TIMEOUT_MS + AI_EXAMPLES. Nothing breaks.
Affects: WS3, WS4. Action needed (after Integration 2):
WS3 → generic POST /assist/:name proxy, then flip `examples` into ConditionSchema + verifier, then POST /escrows/:id/dry-run.
WS4 → verifiability badge + rewrites, interview card, dry-run panel, examples cards.
Tasks: "AI assist features" in apps/agent/CLAUDE.md and apps/web/CLAUDE.md. AI side lands on ws/ai with mocks.
```
