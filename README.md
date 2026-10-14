# RGB Escrow Agent

A freelancer escrow agent that pays in USDT on Bitcoin. Client and freelancer write their agreement in
plain language; a local AI (QVAC) turns it into machine-checkable conditions; the client locks USDT
(RGB) in the agent's self-custodial Tether WDK wallet; the agent verifies the delivery (tests pass,
file hash matches) and pays the freelancer, or refunds the client. Every decision is explained live, and
nothing leaves your machines.

**Status:** plan + contracts + Claude Code instructions. Product code is written on site.

## Stack
- **RGB on Bitcoin** — asset layer (test USDT on a local regtest chain)
- **Tether WDK** + `@utexo/wdk-wallet-rgb` — self-custodial wallets for client, freelancer and agent
- **QVAC** — on-device LLM for agreement parsing and explanations
- TypeScript, Node 22, Fastify, React + Vite, npm workspaces

## Start here
1. `docs/SETUP.md` — do this before the event (WSL2, models, regtest images).
2. `CLAUDE.md` — project rules for humans and Claude Code.
3. `docs/ARCHITECTURE.md` → `docs/ESCROW_FLOW.md` → `docs/CONTRACTS.md`.
4. `docs/WORKSTREAMS.md` — pick your workstream, open its folder's `CLAUDE.md`.

| Doc | What it's for |
| --- | ------------- |
| `docs/ARCHITECTURE.md` | processes, ports, trust model, network choice |
| `docs/ESCROW_FLOW.md` | state machine and step-by-step flow |
| `docs/CONTRACTS.md` | types, events, HTTP/WS APIs (spec for `packages/shared`) |
| `docs/RGB_PRIMER.md` | RGB concepts and gotchas |
| `docs/WORKSTREAMS.md` | owners, timeline, git rules |
| `docs/SETUP.md` | pre-event checklist (Windows + WSL2) |
| `docs/RISKS.md` | risks and questions for mentors |
| `docs/DEMO_SCRIPT.md` | 4-minute demo and judge Q&A |
| `docs/REFERENCES.md` | links |
