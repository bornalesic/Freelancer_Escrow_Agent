# Integration 2 plan — real RGB across four laptops

Written 2026-10-17 after Integration 1. Timeline slot: H12–H16 in `docs/WORKSTREAMS.md`.

**Goal:** the slugify demo (v1 fails, v2 passes, payout) runs end to end with **real tUSDT on regtest**:
agent, client and freelancer each have their own WDK RGB wallet on separate laptops, and the AI runs on
Borna's laptop. **Done when** one full run settles on all three wallets and the screen recording exists.

## Where we are

**Integration 1 is done** (real AI, `MockWallet`, agent on another laptop over the LAN): happy path,
fail-then-pass, client review (dispute → fix → approve), and the AI-down fallback all work. AI evals on
the live model: `/parse` 17/17, `/explain` 15/16, `/review` 8/8 on each landing fixture.

On `main` and ready: regtest stack (`scripts/regtest/compose.yaml`), `RgbWdkWallet` + factory
(`packages/wallet`), party server (`apps/party`), agent loading the real wallet with per-call timeouts.

**Missing (blocks everything below Phase 1):** `scripts/setup-demo.ts`, `scripts/reset-demo.ts` and
`scripts/setup-role.ts`. `npm run demo:setup` / `demo:reset` are in `package.json` but the files do not
exist, so nobody can fund wallets, create UTXOs or issue tUSDT except by hand.

## Laptop map

| Laptop | Runs | Ports other laptops must reach | Owner |
| ------ | ---- | ------------------------------ | ----- |
| **AI** (Borna, Win10, native Windows) | `apps/ai` | 4300 | WS2 |
| **Agent** (also the projector) | regtest stack (Docker in WSL), `apps/agent`, `apps/web` `/agent` | 4000, 3000, 50001 | WS3 + WS1 |
| **Client** | `apps/party` ROLE=client, `apps/web` `/client` | 4101 | WS1 / WS4 |
| **Freelancer** | `apps/party` ROLE=freelancer, `apps/web` `/freelancer` | 4102 | WS1 / WS4 |

Who talks to whom: every wallet → agent laptop's electrs (50001) and RGB proxy (3000). Client/freelancer
browsers → agent (4000). Agent → AI (4300) and → client party (4101, for refund invoices). Projector →
both parties (4101, 4102, for balances).

## Phases

### Phase 0 — every laptop, now (15 min, in parallel with Phase 1)
- [ ] `git pull` on `main`, `npm install` (in WSL; Borna also on Windows for `apps/ai`).
- [ ] **Ubuntu 24.04** on every laptop that runs a wallet (agent, client, freelancer): `ldd --version`
      must show ≥ 2.38, or the wallet's native binary will not load.
- [ ] **Clock:** in admin PowerShell, `Get-Service W32Time` must be *Running*. If not:
      `Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync /force`.
      A drifting Windows clock made WSL's clock jump ~96 s on one laptop, which can release escrowed
      money early in the client-review window (details in `packages/wallet/CLAUDE.md`).
- [ ] **Network:** all four laptops on the **same** network (venue Wi-Fi or one phone hotspot). Each
      laptop that serves ports from WSL (agent, client, freelancer) must be reachable from the others:
  - Windows 11: `networkingMode=mirrored` in `%UserProfile%\.wslconfig` (see `docs/SETUP.md`).
  - Windows 10 (no mirrored mode): port-forward each port from Windows into WSL, in admin PowerShell.
    Re-run after every WSL restart, because the WSL IP changes:
    ```powershell
    $wsl = (wsl hostname -I).Trim().Split(' ')[0]
    foreach ($p in 4000,3000,50001) {   # client laptop: 4101; freelancer laptop: 4102
      netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null
      netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$wsl
    }
    ```
    With Docker Desktop, 3000 and 50001 are already published on Windows: leave them out of the loop.
    Each laptop opens its own web UI on `localhost:5173`, so 5173 never needs forwarding.
  - Firewall: the `escrow-demo` inbound rule from `docs/SETUP.md`, with **Profile Any** (venue Wi-Fi
    is usually *Public*). **Antivirus firewalls (Avast, etc.) override Windows Firewall**: mark the
    network as trusted there. This is what blocked the AI laptop in Integration 1.
- [ ] **Prove reachability before Phase 3**, from every other laptop's PowerShell:
      `Test-NetConnection <ip> -Port <port>` → `TcpTestSucceeded : True`. Use the **Wi-Fi** adapter's
      IPv4 from `ipconfig`, not vEthernet/VMware/VirtualBox (`192.168.56.x`) adapters.

### Phase 1 — WS1 writes the setup scripts (the blocker)
Spec is in `packages/wallet/CLAUDE.md` → "Deliver in this order", step 4. In short:
- [ ] `scripts/setup-demo.ts` (agent laptop): treasury + agent wallets → mine 101 blocks to treasury →
      send BTC to agent, client and freelancer addresses → mine → `createUtxos` → treasury issues NIA
      `TUSDT` (precision 6, supply 1,000,000) → send 100 TUSDT to the client → mine → refresh all → print
      the asset id and write `ESCROW_ASSET_ID` into `.env.local`.
- [ ] `scripts/setup-role.ts --role client|freelancer` (party laptops): open the wallet, print its BTC
      address for the treasury to fund, then `createUtxos` once funded and print the balance.
- [ ] `scripts/reset-demo.ts`: wipe data dirs + mock ledger, then setup again.
- [ ] Document the exact cross-laptop sequence in `scripts/regtest/README.md`.

Until the scripts exist, the cross-laptop wiring (Phase 0) and the mock path can still be checked.

### Phase 2 — stack and wallets (WS1 drives, each laptop owner helps)
1. Agent laptop: `docker compose -f scripts/regtest/compose.yaml up -d`, then `... ps` shows 3 services.
2. Client and freelancer laptops: `setup-role` prints an address → send it to WS1.
3. Agent laptop: `npm run demo:setup` funds everyone, issues TUSDT, sends 100 to the client.
4. Copy **the same `ESCROW_ASSET_ID`** into the agent, client and freelancer `.env.local`.
5. Check: client wallet 100 TUSDT, freelancer 0, agent 0, every wallet with ≥ 5 free UTXOs.

### Phase 3 — services up (each owner)
`.env.local` per laptop (only the lines that differ from `.env.example`; mnemonics stay local):

| Variable | Agent laptop | Client laptop | Freelancer laptop |
| -------- | ------------ | ------------- | ----------------- |
| `WALLET_MODE` | `real` | `real` | `real` |
| `<ROLE>_MNEMONIC` | `AGENT_` (+ `TREASURY_` for setup) | `CLIENT_` | `FREELANCER_` |
| `RGB_INDEXER_URL` | `tcp://localhost:50001` | `tcp://<agent-ip>:50001` | `tcp://<agent-ip>:50001` |
| `RGB_TRANSPORT_ENDPOINT` | `rpc://<agent-ip>:3000/json-rpc` ⚠ | `rpc://<agent-ip>:3000/json-rpc` | `rpc://<agent-ip>:3000/json-rpc` |
| `ESCROW_ASSET_ID` | from `demo:setup` | same | same |
| `AI_URL` | `http://<ai-ip>:4300` | — | — |
| `CLIENT_PARTY_URL` / `FREELANCER_PARTY_URL` | `http://<client-ip>:4101` / `http://<freelancer-ip>:4102` | — | — |
| `BITCOIND_RPC_URL` / `_USER` / `_PASS` | `http://localhost:18443` + values from `scripts/regtest/README.md` | — | — |
| `AUTO_MINE` | `true` | — | — |
| `VITE_AGENT_URL` / `VITE_PARTY_URL` | `http://localhost:4000` / — | `http://<agent-ip>:4000` / `http://localhost:4101` | `http://<agent-ip>:4000` / `http://localhost:4102` |

⚠ **Use the agent laptop's LAN IP for the transport endpoint even on the agent laptop.** The endpoint is
written into every RGB invoice, and the payer posts the consignment to it; `localhost` in an invoice
points the client's wallet at the client's own laptop. (WS1: confirm against the invoice string.)

Start order: AI → regtest stack → agent → parties → web.
- AI laptop (PowerShell): `npm run dev:ai`, wait for `loaded:true` on `/health`.
- Agent laptop: `npm run dev:agent` and `npm run dev:web`. `curl localhost:4000/health` → `ok:true`,
  `walletMode:"real"`, `aiUp:true`, `aiModel` set.
- Client / freelancer laptops: `npm run dev:party:client` (or `:freelancer`) and `npm run dev:web`.
- Run **exactly one** agent: the AI log prints `health: first poll from <ip>` once per caller, so two
  lines from the same IP mean a stray second agent.

### Phase 4 — the runs (WS4 drives, everyone watches their own process)
Screens and the pre-run checklist are in `docs/DEMO_SCRIPT.md` → "Rehearsal checklist": all header dots
green, projector footer shows the model, client 100 / freelancer 0 / held 0.
- [ ] **Run A, slugify:** v1 fails (explanation names the punctuation test), v2 passes, payout settles.
      Projector: held 0 → 50 → 0; client 100 → 50; freelancer 0 → 50.
- [ ] **Start the screen recording on the first attempt** and keep it if the run is clean
      (`demo-backup.mp4` on every laptop's desktop, per the backup plan).
- [ ] **Run B, client review (landing):** v1 → AI says "looks unmet" → Dispute; v2 → "looks met" →
      Approve → payout. Create the agreement in the client browser used on stage.
- [ ] **Run C, refund:** short deadline, no passing delivery → refund settles back to the client.
- [ ] `npm run demo:reset` between runs; the asset id changes, so update `ESCROW_ASSET_ID` everywhere.

### Phase 5 — fallbacks, before calling it done
- [ ] Stop `dev:ai` mid-run: the agent continues with the fallback parser, template explanations and an
      "AI review unavailable" report, without hanging; restart it and the agent picks it up within ~10 s.
      (Verified in Integration 1 with the mock wallet; repeat once with real wallets.)
- [ ] Switching every laptop to `WALLET_MODE=mock` still gives a working demo (the stage fallback).

## Checklist per workstream

**WS1 — Wallet**
- [ ] Phase 1 scripts (blocker): `setup-demo.ts`, `setup-role.ts`, `reset-demo.ts`, README sequence.
- [ ] Confirm the transport endpoint in invoices (⚠ above) and that the regtest ports are reachable from
      the party laptops (Phase 0).
- [ ] Drive Phase 2; run the client and freelancer party servers in real mode.

**WS2 — AI** (nothing changes for the AI in real-wallet mode)
- [x] Integration 1: `/parse`, `/explain`, `/review` verified on the live model; review-v2 merged.
- [ ] Keep `dev:ai` running on `main`. Post the Wi-Fi IP in the team chat on every network change and
      trust that network in Avast.
- [ ] In parallel: make the failed-test explanation quote the actual vs expected output (the demo's key
      line), then re-run `npm run eval:explain -w apps/ai`.

**WS3 — Escrow core**
- [ ] Agent laptop: `.env.local` per the table, one agent process, `/health` all green in real mode.
- [ ] Check `AUTO_MINE` + `/dev/mine` against the regtest bitcoind, and the refund path (Run C).
- [ ] Confirm `REVIEW_WINDOW_SEC` is timed monotonically (WS1's clock-jump note), not by `Date.now()`.

**WS4 — UI + demo**
- [ ] Web on all three wallet laptops with the right agent/party URLs; projector on the agent laptop.
- [ ] Drive Phase 4, own the recording, and update `docs/DEMO_SCRIPT.md` with anything learned.

## Known traps (all hit at least once)
- **Avast / third-party firewall** silently blocks inbound connections even with the Windows rule in place.
- **Wrong IP**: `192.168.56.1` (VirtualBox) and vEthernet/VMware addresses are not reachable from the LAN.
- **iPhone hotspot + WSL**: if Windows reaches a laptop but WSL does not, WSL's NAT subnet overlaps the
  hotspot's `172.20.x`. Run `wsl --shutdown` and reopen, or use an Android hotspot.
- **VPN** (NordVPN etc.) blocks LAN traffic: turn it off on every laptop.
- **Two agent processes** pointing at the same AI: check with `ss -tnp | grep ':4300'` in WSL.
- **Never** reuse a mnemonic across laptops, paste one into chat, or open one wallet `dataDir` from two
  processes.
- **Don't run `npm install`** on the AI laptop while `dev:ai` is running; it can crash the service.
