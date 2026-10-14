# Risks, mitigations, and open questions

## Top risks

| # | Risk | Impact | Mitigation | Owner |
| - | ---- | ------ | ---------- | ----- |
| 1 | `@utexo/wdk-wallet-rgb` has no Windows native build; all our laptops are Windows | wallet can't run | All wallet/agent processes in WSL2 Ubuntu (verified at home per `docs/SETUP.md`) | WS1 |
| 1b | WSL2 ports not reachable from other laptops (NAT, firewall) | multi-laptop demo fails | mirrored networking + firewall rule; fallback `netsh portproxy`; last resort one laptop | WS1 |
| 2 | Network/endpoints unclear (released docs: mainnet/testnet/regtest only) | no transfers | Local regtest as primary; signet only if mentors confirm | WS1 |
| 3 | Transfer stuck "waiting" | demo hangs | both sides poll `refresh()`; agent auto-mines on regtest; visible "pending" state in UI | WS1/WS3 |
| 4 | Local model slow (tens of seconds) | awkward pauses | stream tokens; pre-warm at start; 2B fallback; templated explanations after timeout | WS2 |
| 5 | Model returns invalid conditions | broken flow | named tool + `tool_choice`, zod validation, one retry, regex fallback parser, human approval step | WS2 |
| 6 | QVAC on GTX 1060 lacks Vulkan 1.4 | no GPU / no QVAC on Windows | check `vulkaninfo` before the event; update driver; run AI on another laptop | WS2 |
| 7 | Running deliverable tests executes untrusted code | security question from judges | timeout + temp dir + no network (Docker `--network none` as stretch); say so in pitch | WS3 |
| 8 | LAN/Wi-Fi isolation at venue blocks laptop-to-laptop traffic | multi-laptop demo fails | bring a travel router or phone hotspot; fallback: all processes on one laptop, two browser windows | All |
| 9 | Corrupted wallet state during rehearsals | lost balances | `scripts/setup-demo` recreates everything from zero in < 2 min; never share `dataDir` | WS1 |
| 10 | Merge conflicts in `packages/shared` | lost hours | WS3 gatekeeps; contract changes via the slash command | WS3 |

## Questions for mentors (ask at H0, write the answers here)

**UTEXO**
1. Which version of `@utexo/wdk-wallet-rgb` should we use this weekend — npm 2.0.3 or `main`?
   Answer:
2. Which network + `indexerUrl` + `transportEndpoint` do you recommend? Is there a hackathon signet
   with a faucet and a test USDT asset id? Answer:
3. Is there a recommended regtest docker compose for the wallet? Answer:
4. Default invoice expiry for `receiveAsset`, and how to set it? Answer:
5. Any known issues with three wallets on one regtest chain transferring back and forth? Answer:
6. Does `@utexo/wdk-rgb-lightning` support hold invoices (for a trust-minimized escrow)? Answer:
7. Is registering `WalletManagerRgb` through `@tetherto/wdk` core supported? Answer:

**QVAC / Tether**
8. Recommended model for structured extraction with tool calls on a 6 GB GPU? Answer:
9. Does QVAC run on a GTX 1060 via Vulkan, or should we use CPU / another laptop? Answer:

**Organizers / judges**
10. How are WDK bonus points judged — any specific features they want to see? Answer:
11. Is a pre-made docs/config repo allowed? Answer:
