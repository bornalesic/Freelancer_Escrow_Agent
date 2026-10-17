# RGB Escrow Agent — project memory for Claude Code

Hackathon project (QVAC × RGB, Turin). ~26 hours of on-site building, 4 people working in parallel.
Speed matters, but **a working end-to-end demo beats any feature**.

## What we are building
A freelancer escrow agent. Client and freelancer agree on a job in plain language; local AI (QVAC)
turns it into machine-checkable conditions; both approve; the client locks test-USDT (an RGB asset on
Bitcoin) in the agent's Tether WDK wallet; the freelancer uploads the work; a deterministic verifier
runs the checks; for criteria only a person can judge, QVAC writes an advisory review and the client
approves or disputes; the agent pays the freelancer or refunds the client; QVAC explains every step in a
live decision log.

Read before doing anything non-trivial:
- `docs/ARCHITECTURE.md` — processes, ports, trust model, network choice
- `docs/CONTRACTS.md` — types, events, HTTP/WS APIs (spec for `packages/shared`)
- `docs/ESCROW_FLOW.md` — state machine and step-by-step flow
- `docs/RGB_PRIMER.md` — RGB concepts and gotchas
- `docs/WORKSTREAMS.md` — who owns what, timeline, git rules

## Repo layout
```
packages/shared   types + zod schemas + route/event constants (source of truth)   [WS3 gatekeeps]
packages/wallet   EscrowWallet: RgbWdkWallet (@utexo/wdk-wallet-rgb) + MockWallet  [WS1]
apps/party        per-party wallet HTTP server (client :4101, freelancer :4102)    [WS1]
apps/ai           QVAC service :4300 — /parse, /explain, /review (native Windows) [WS2]
apps/agent        escrow server :4000 — state machine, verifier, agent wallet, WS [WS3]
apps/web          React UI — /client, /freelancer, /agent views                   [WS4]
scripts/          regtest stack, demo setup/reset                                  [WS1]
fixtures/         demo deliverables + agreement eval set                           [WS4]
```
Each folder has its own `CLAUDE.md` with the detailed task list. Stay inside your workstream's folders
unless the task explicitly says otherwise.

## Environment (important)
- All laptops are **Windows**. Everything runs in **WSL2 Ubuntu** except `apps/ai`, which runs in
  native Windows PowerShell (QVAC needs the Windows Vulkan GPU driver). Write commands for bash first;
  for `apps/ai` also make them work in PowerShell (use `cross-env`, no bash-only syntax in npm scripts).
- Node ≥ 22.17, npm workspaces, TypeScript (strict), ESM (`"type": "module"`), run TS with `tsx`.
- Config comes only from env vars listed in `.env.example`; per-laptop values go in `.env.local`
  (git-ignored). Never hard-code hosts, ports, network names or asset ids.

## Commands (root)
```
npm install                     # once, in WSL (and separately on Windows for apps/ai only)
npm run dev:agent               # apps/agent on :4000
npm run dev:party:client        # apps/party on :4101, ROLE=client
npm run dev:party:freelancer    # apps/party on :4102, ROLE=freelancer
npm run dev:ai                  # apps/ai on :4300 (Windows PowerShell)
npm run dev:web                 # apps/web on :5173
npm run dev:mock                # agent + both parties with WALLET_MODE=mock and AI_MODE=mock
npm run typecheck               # tsc --noEmit across workspaces
npm test                        # vitest across workspaces
npm run demo:reset              # fresh regtest wallets, funded, ready for the demo
```
If a script does not exist yet, create it in the right `package.json` rather than running ad-hoc commands.

## Non-negotiable rules
1. **The LLM never moves money.** Release/refund comes only from the pure `decide()` function in
   `apps/agent`. AI output is used for (a) proposed conditions that humans approve, (b) explanations and
   (c) advisory reviews of `client_review` conditions, which the client reads before deciding.
   `decide()` never reads the AI review.
2. **Contracts first.** Import types/schemas/route names from `@escrow/shared`. Do not redefine them
   locally. Need a change? Follow `.claude/commands/contract-change.md`.
3. **Mocks behind every boundary.** `WALLET_MODE=mock|real`, `AI_MODE=mock|real`. The mock must keep
   working after the real implementation lands — it is our demo fallback.
4. **Amounts are base-unit integers as decimal strings** in JSON; use `bigint` in code. Never `number`
   for money. Display formatting only in the UI (`precision` from `/config`).
5. **Every state change emits exactly one `LogEvent`** with a deterministic `title` written by code.
6. **Never log or commit mnemonics.** Seeds live in `.env.local`. Never open one wallet `dataDir` from
   two processes, never reuse a mnemonic across laptops/roles.
7. Validate every HTTP body with the zod schema from `@escrow/shared`; return `400 { error, details }`.
8. Timeouts on every network call (wallet, AI, verifier). Nothing in the demo path may hang forever.

## How to work (for Claude Code)
- Prefer the smallest change that makes the next demo step work. No speculative abstractions.
- When an external API is uncertain (QVAC, `@utexo/wdk-wallet-rgb`), **read the installed package's
  types/README in `node_modules` first**, then write a tiny probe script in `scratch/` (git-ignored)
  before wiring it into app code. Record findings in that workstream's CLAUDE.md "Learned the hard way".
- After a meaningful change: `npm run typecheck` and the workstream's tests. Fix before committing.
- Commit small, prefix with workstream (`wallet:`, `ai:`, `agent:`, `web:`, `shared:`), on your `ws/*`
  branch. To catch up with `main`, merge it (`git merge origin/main`). Never rebase pushed commits,
  never `git push --force`, never amend a pushed commit (organizer rule: the judges read the history).
- Write user-facing text (UI, log titles) in short plain English.
- Use `/checkpoint` at stand-ups to summarize status against `docs/WORKSTREAMS.md`.

## Glossary
- **Escrow** — one job between one client and one freelancer.
- **Condition** — an acceptance check. Automatic: `tests_pass`, `file_hash`, `file_present` (the verifier
  checks them). Manual: `client_review` (the client judges it, helped by QVAC's advisory report).
- **Client review** — the `AWAITING_APPROVAL` step: all automatic checks passed, the client approves or
  disputes. No answer within `REVIEW_WINDOW_SEC` → release.
- **clientToken** — secret returned once by `POST /escrows`; required by `/approve`. Never in `Escrow` or logs.
- **termsHash** — sha256 of canonical JSON of `{title, amount, assetId, deadline, conditions}`.
- **Invoice** — RGB receive invoice string (`rgb:...`), single-use.
- **Agent wallet** — the escrow agent's own WDK RGB wallet, which holds funds between FUNDED and RELEASED/REFUNDED.
- **tUSDT** — our self-issued test asset standing in for USDT.
