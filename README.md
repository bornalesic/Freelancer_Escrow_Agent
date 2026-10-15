# Freelancer Escrow Agent

> Hackathon "Agentic Dollars on Bitcoin" · Turin, BLOX · October 17–18, 2026

A freelancer escrow agent that pays in USDT on Bitcoin. The client and freelancer write their agreement
in plain language. A local AI (QVAC) turns it into machine-checkable conditions. The client locks USDT
(an RGB asset) in the agent's self-custodial Tether WDK wallet. The agent verifies the delivery (tests
pass, file hash matches) and pays the freelancer, or refunds the client. Every decision is explained
in plain language, and nothing leaves the participants' machines.

---

## Team

**Team name:** Inglorious Engineers

| Name | GitHub |
| ---- | ------ |
| Borna Lešić | [@bornalesic](https://github.com/bornalesic) |
| Marko Zovko | [@ZovkoM555](https://github.com/ZovkoM555) |
| Marko Cindrić | [@Marko-Cindric](https://github.com/Marko-Cindric) |
| Roko Domović | [@RoKo30](https://github.com/RoKo30) |

---

## The idea

Freelancers get paid late or not at all; clients pay for work that doesn't work. Escrow services are
slow, custodial and take a cut. Our agent:

1. **Understands the deal.** The client and freelancer describe the job in plain language. QVAC,
   running on-device, turns it into checks a machine can verify: "the test suite passes", "the
   delivered file matches this hash", "a README is included". Both parties approve the exact checks
   before any money moves.
2. **Holds the money on Bitcoin.** The client locks USDT, an RGB asset, in the escrow agent's own
   self-custodial Tether WDK wallet.
3. **Checks the work.** The freelancer uploads the delivery and a deterministic verifier runs every check.
4. **Pays or refunds automatically.** All checks pass → the freelancer is paid over RGB. Deadline
   missed → the client is refunded.
5. **Explains every step.** A live decision log shows what happened and why, with a plain-language
   explanation from the local model.

### Why RGB
USDT natively on Bitcoin, with client-side validation that keeps transfers private, and self-custodial
wallets for every party. No smart-contract platform or third-party payment processor in the middle.

### Why local AI (QVAC)
Agreements and deliverables are often confidential client work: source code, designs, contracts. With
QVAC, the agreement, the code and the AI's reasoning never leave the participants' machines.

### The AI never moves money
The model only (a) proposes conditions that both humans must approve and (b) explains decisions after
they are made. Release and refund come from a deterministic verifier and a pure decision function.

---

## Stack

| Layer | Technology | What we use it for |
| ----- | ---------- | ------------------ |
| Asset layer | **RGB** on Bitcoin | test USDT: issuance, invoices, transfers into and out of escrow |
| Local AI | **QVAC** (`@qvac/sdk`, Qwen models, on-device) | plain-language agreement → verifiable conditions; streamed explanations |
| Wallets (bonus) | **Tether WDK** + `@utexo/wdk-wallet-rgb` | self-custodial RGB wallets for client, freelancer and escrow agent |
| Chain | Local Bitcoin regtest (bitcoind + electrs + RGB proxy, Docker) | private test network, instant blocks ‹UPDATE if we switch to signet› |
| App | TypeScript, Node.js 22, Fastify, React + Vite | escrow server, wallet servers, web UI |
| Dev environment | Windows 11 + WSL2 Ubuntu; QVAC on native Windows (GPU via Vulkan) | — |

---

## Status before the hackathon (prior work declaration)

As of our first commit (October 14, 2026), this repository contains **planning material only. There
is no product code.**

| What | Where | Notes |
| ---- | ----- | ----- |
| Architecture, escrow state machine, data/API contracts | `docs/` | design documents, no implementation |
| Demo plan, risk list, setup checklist | `docs/` | |
| Instructions for our AI coding assistant | `CLAUDE.md` files, `.claude/commands/` | we use Claude Code during the hackathon |
| Config templates | `package.json`, `.env.example`, `.gitignore`, `.nvmrc` | workspace layout and variable names only |

The planning documents were drafted with the help of an AI assistant (Claude).

**All application code** (`packages/*/src`, `apps/*/src`, scripts, UI, demo fixtures) **is written
during the hackathon.** The git history shows exactly what was added on site.

Other prior work (code, prototypes, designs, apps): ‹FILL IN — "none", or list it here›

### Installed and working before the event

‹FILL IN — tick only what you actually tested, delete the rest›

- [ ] WSL2 Ubuntu + Node.js 22 on all four laptops
- [ ] QVAC SDK installed; model `‹FILL IN›` downloaded and running on ‹FILL IN: GPU / CPU›,
      ‹FILL IN› tokens/s
- [ ] `@utexo/wdk-wallet-rgb` installs and loads in WSL2
- [ ] Regtest stack (bitcoind + electrs + RGB proxy) starts via Docker
- [ ] Ran the official quickstarts/tutorials (QVAC, WDK, RGB wallet) to learn the APIs.
      These throwaway experiments are not part of this repository.
- [ ] ‹FILL IN›

---

## Final submission (completed by Sunday, October 18, 13:00)

### How to install and run
‹to be written during the hackathon›

### What we built during the hackathon
‹to be written during the hackathon›

### What is mocked, simulated or hard-coded
‹to be written during the hackathon›

### RGB operations used
‹to be written during the hackathon›

### QVAC features used
‹to be written during the hackathon›

### WDK features used
‹to be written during the hackathon›

---

## Documentation

| Doc | What it's for |
| --- | ------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | processes, ports, trust model, network choice |
| [`docs/ESCROW_FLOW.md`](docs/ESCROW_FLOW.md) | escrow state machine, step by step |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | types, events, HTTP/WebSocket APIs |
| [`docs/RGB_PRIMER.md`](docs/RGB_PRIMER.md) | RGB concepts and gotchas |
| [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md) | who owns what, timeline, git rules |
| [`docs/SETUP.md`](docs/SETUP.md) | environment setup (Windows + WSL2) |
| [`docs/RISKS.md`](docs/RISKS.md) | risks and questions for mentors |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | demo and pitch plan |
