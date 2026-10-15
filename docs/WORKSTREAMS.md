# Workstreams and timeline

Four people, four workstreams, one shared contract. Everyone builds against mocks first and swaps in
the real thing at the integration checkpoints. Assign names here at the start:

| WS  | Name | Owns | Branch | Delivers to |
| --- | ---- | ---- | ------ | ----------- |
| WS1 Wallet (WDK + RGB) | ______ | `packages/wallet`, `apps/party`, `scripts/regtest`, `scripts/setup-*` | `ws/wallet` | WS3 (agent wallet), WS4 (party API) |
| WS2 AI (QVAC)          | ______ | `apps/ai`, prompts, eval fixtures                       | `ws/ai`     | WS3 (`/parse`, `/explain`) |
| WS3 Escrow core        | ______ | `apps/agent`, `packages/shared` (gatekeeper), verifier  | `ws/agent`  | WS4 (agent API + WS) |
| WS4 UI + demo          | ______ | `apps/web`, `fixtures/demo-deliverable`, demo script, pitch | `ws/web` | everyone |

Each folder has a `CLAUDE.md` with that workstream's detailed task list. Start Claude Code **inside
your folder** (`cd apps/ai && claude`) so it picks up both the root and the local `CLAUDE.md`.

## Timeline (assumes ~26 hours; adjust the clock times on site)

### H0 – H1 · Kickoff (everyone together)
- [ ] Everyone: `npm install`, run your workstream's smoke test from `docs/SETUP.md`.
- [ ] Together (WS3 drives): turn `docs/CONTRACTS.md` into `packages/shared` code. Commit to `main`.
- [ ] WS1: start the regtest stack on the stack laptop; share its LAN IP in the team chat.
- [ ] Agree who is on the projector laptop (agent) and who sits at client/freelancer laptops.
- [ ] Ask mentors the questions in `docs/RISKS.md` → "Questions for mentors". Write answers in that file.

### H1 – H9 · Build in parallel (mocks everywhere)
- WS1: `MockWallet` first (by H2!), then `RgbWdkWallet` against regtest, then `apps/party`.
- WS2: `/parse` with a real model + fallback parser, then `/explain` streaming, then eval loop.
- WS3: state machine + JSON store + routes with `MockWallet` and a stub AI, then verifier, then WS.
- WS4: the three views against the mock agent (`npm run dev:mock`), then the decision log.

**Checkpoint H4 (15 min stand-up):** each WS demos its smallest working slice. Contract changes now
or never.

### H9 – H12 · Integration 1 — "everything real except money"
- [ ] Agent + real AI + `MockWallet` + real UI on one laptop, full happy path and fail-then-pass path.
- [ ] Fix contract mismatches. WS3 owns merges into `main`.

### H12 – H16 · Integration 2 — real RGB
- [ ] Three real wallets (agent, client, freelancer) on regtest, funded and with UTXOs
      (`scripts/setup-demo.ts`, WS1).
- [ ] Full flow across **three laptops** on the LAN.
- [ ] Record a screen capture of a full successful run **as soon as it works once** (insurance).

### H16 – H20 · Polish
- WS2: tighten prompts, shorten explanations, pre-warm model, measure latency.
- WS4: visual polish, big readable decision log for the projector, balances that animate on change.
- WS1/WS3: reliability — retries, idempotent refresh loops, `/dev/reset` + one-command demo setup.

### H20 – H24 · Freeze, rehearse
- [ ] Feature freeze at H20. Only bug fixes after this.
- [ ] Rehearse `docs/DEMO_SCRIPT.md` at least three times end to end, with a fresh `setup-demo` each time.
- [ ] Prepare the 1-minute "how it works" slide and the trust-model answer.

### Remaining hours
Buffer, sleep in shifts (never all four asleep), stretch goals only if the demo is rock solid:
1. BIP-322 signatures on acceptance (WDK `sign()`), shown as "signed by" badges.
2. Docker sandbox for the test runner (`--network none`).
3. Lightning hold-invoice escrow via `@utexo/wdk-rgb-lightning` (only with mentor confirmation).

## Git rules
- `main` must always run. Work on your `ws/*` branch and merge `main` into it at least every 2 hours
  (`git merge origin/main`). Never rebase pushed commits and never force-push (organizer rule).
- Small commits, message prefix by workstream: `wallet:`, `ai:`, `agent:`, `web:`, `shared:`.
- Only WS3 merges changes to `packages/shared` (see `.claude/commands/contract-change.md`).
- Never commit `.env.local`, mnemonics, `data/` folders or model files.
