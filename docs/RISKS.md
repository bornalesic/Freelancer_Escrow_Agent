# Risks, mitigations, and open questions

## Top risks

| # | Risk | Impact | Mitigation | Owner |
| - | ---- | ------ | ---------- | ----- |
| 1 | `@utexo/wdk-wallet-rgb` has no Windows native build; all our laptops are Windows | wallet can't run | All wallet/agent processes in WSL2 Ubuntu (verified at home per `docs/SETUP.md`) | WS1 |
| 1a | WSL2 runs Ubuntu 22.04 (glibc 2.35); 2.0.3's binary needs glibc ≥ 2.38 | native addon fails to load | Ubuntu 24.04 on all laptops, `ldd --version` check in setup; no `rgb-sdk` override (changes derived wallets) | WS1 |
| 1b | WSL2 ports not reachable from other laptops (NAT, firewall) | multi-laptop demo fails | mirrored networking + firewall rule; fallback `netsh portproxy`; last resort one laptop | WS1 |
| 2 | Public test network incompatibilities (organizers' faucet/wallets are `signetcustom`; WDK supports only plain `signet`) | can't use faucet USDT; flaky transfers | Local regtest as primary; own NIA tUSDT everywhere; Mutinynet `signet` only after regtest works | WS1 |
| 3 | Transfer stuck "waiting" | demo hangs | both sides poll `refresh()`; agent auto-mines on regtest; visible "pending" state in UI | WS1/WS3 |
| 4 | Local model slow (tens of seconds) | awkward pauses | stream tokens; pre-warm at start; 2B fallback; templated explanations after timeout | WS2 |
| 5 | Model returns invalid conditions | broken flow | named tool + `tool_choice`, zod validation, one retry, regex fallback parser, human approval step | WS2 |
| 5b | Qwen3.5 thinking + grammar-constrained output → HTTP 500 ("empty grammar stack") | `/parse` fails every time | `reasoning_budget: 0` on every request; don't rely on `/no_think`; plain Qwen3 4B as backup model | WS2 |
| 6 | QVAC on GTX 1060 lacks Vulkan 1.4 | no GPU / no QVAC on Windows | check `vulkaninfo` before the event; update driver; run AI on another laptop | WS2 |
| 7 | Running deliverable tests executes untrusted code | security question from judges | timeout + temp dir + no network (Docker `--network none` as stretch); say so in pitch | WS3 |
| 8 | LAN/Wi-Fi isolation at venue blocks laptop-to-laptop traffic | multi-laptop demo fails | organizers say venue Wi-Fi allows local traffic and Ethernet cables are on site; still bring a travel router or hotspot; fallback: all processes on one laptop, two browser windows | All |
| 9 | Corrupted wallet state during rehearsals | lost balances | `scripts/setup-demo` recreates everything from zero in < 2 min; never share `dataDir` | WS1 |
| 10 | Merge conflicts in `packages/shared` | lost hours | WS3 gatekeeps; contract changes via the slash command | WS3 |
| 11 | Client review: the delivery contains instructions aimed at the AI reviewer (prompt injection) | misleading AI review | review is advice only, `decide()` never reads it; excerpts fenced as untrusted + guards in `/review`; UI says "AI opinion — you make the call"; client sees the files | WS2/WS4 |
| 12 | Client review: anyone on the LAN calls `/approve` as "client" | money released without the client | `clientToken` required (agent stores its sha256, never broadcast); BIP-322 signature as stretch | WS3 |
| 13 | Client review: a delivered web page runs scripts when the client opens it | page calls the agent API | files served with `Content-Security-Policy: sandbox`; `<iframe sandbox>` without `allow-same-origin`; `/approve` still needs the token | WS3/WS4 |
| 14 | Client review: client disputes every delivery until the deadline, gets refunded, keeps the work | unfair to the freelancer | known limit, say it honestly (real platforms use arbitration); "no answer = release" stops silent ghosting | All (pitch) |
| 15 | Client review: review window too long for the stage | demo stalls | `REVIEW_WINDOW_SEC` ≈ 120 in the demo; the client clicks Approve live | WS4 |

## Questions for mentors (ask at H0, write the answers here)

**UTEXO**
1. Which version of `@utexo/wdk-wallet-rgb` should we use this weekend — npm 2.0.3 or `main`?
   Answer: partly. 2.0.3 is still the latest on npm. It needs glibc ≥ 2.38 (Ubuntu 24.04). UTEXO did
   not answer whether overriding `@utexo/rgb-sdk` is recommended; don't.
2. Which network + `indexerUrl` + `transportEndpoint` do you recommend? Is there a hackathon signet
   with a faucet and a test USDT asset id? Answer: Mutinynet via the KaleidoSwap builder kit
   (esplora `https://esplora.signet.kaleidoswap.com`, proxy `rpcs://proxy.kaleidoswap.com/json-rpc`,
   no hard rate limit but no tight polling). The faucet USDT is NIA on `signetcustom`, which the WDK
   adapter can't use (plain `signet` only), so we issue our own asset. Regtest is fine and recommended
   for testing.
3. Is there a recommended regtest docker compose for the wallet? Answer: no shared regtest; teams run
   their own, no constraints. Still ask about a compose file.
4. Default invoice expiry for `receiveAsset`, and how to set it? Answer:
5. Any known issues with three wallets on one regtest chain transferring back and forth? Answer:
6. Does `@utexo/wdk-rgb-lightning` support hold invoices (for a trust-minimized escrow)? Answer:
   another team found HODL invoices (`payment_hash`, `claimhodlinvoice`, `cancelhodlinvoice`) in
   UTEXO's fork `UTEXO-Protocol/rgb-lightning-node` tag `v0.11.0-beta.3`, not in RGB-Tools upstream.
   Organizers: forks are fine if declared in the PR. Still confirm the JS module exposes them.
7. Is registering `WalletManagerRgb` through `@tetherto/wdk` core supported? Answer:

**QVAC / Tether**
8. Recommended model for structured extraction with tool calls on a 6 GB GPU? Answer: Qwen3.5 at
   4-bit (0.8B / 2B / 4B / 9B, or Qwen3-600M). Sub-1B works for narrow tasks; 4B+ for better quality on
   desktop. A Qwen3.5 2B primary + 0.8B fallback plan was called "a good choice". Disable thinking with
   `reasoning_budget: 0` (see `apps/ai/CLAUDE.md`).
9. Does QVAC run on a GTX 1060 via Vulkan, or should we use CPU / another laptop? Answer: partly
   answered. Desktop minimum 16 GB RAM (24–32 GB more comfortable); CPU inference works, a dedicated GPU
   is the safe bet; runs on all platforms (macOS fastest). Windows 11 + Vulkan with SDK 0.21.0 is
   confirmed working by another team. The GTX 1060 itself was not confirmed — still check
   `vulkaninfo --summary` for apiVersion ≥ 1.4.
9b. Does local QVAC inference count as "on device"? Answer: yes — `qvac serve` on the laptop, called
   from a web page on the same machine, counts. Our AI host is called over the LAN from the agent
   laptop; still local, but word it as "local, on our own machines" or confirm with judges.

**Organizers / judges**
10. How are WDK bonus points judged — any specific features they want to see? Answer: WDK is
    optional, 0–5 bonus points, scaled by how much real work WDK does in the project; low or
    pointless use ranks lowest. No points lost for skipping it.
11. Is a pre-made docs/config repo allowed? Answer: not answered directly. Forks and third-party
    tooling are allowed if declared in the PR; submission details are "in the instructions".
12. Does an on-chain RGB payment count for "Payments and checkout", or is RGB over Lightning
    expected? Answer: on-chain with 1 confirmation fully counts; Lightning is a bonus.
