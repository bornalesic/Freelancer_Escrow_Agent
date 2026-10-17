# Regtest stack (WS1)

A private Bitcoin regtest chain + Electrum indexer + RGB proxy, run with Docker inside WSL2 on the
**agent laptop**. All wallets on all laptops point at it over the LAN.

| Service | Port | Used as |
| ------- | ---- | ------- |
| bitcoind (regtest) | 18443 | chain; mining via JSON-RPC (`/dev/mine`) |
| electrs | 50001 | `RGB_INDEXER_URL=tcp://<agent-LAN-IP>:50001` |
| rgb-proxy-server | 3000 | `RGB_TRANSPORT_ENDPOINT=rpc://<agent-LAN-IP>:3000/json-rpc` |

## Before the hackathon (setup, not building)
Done. `compose.yaml` here is trimmed from the compose file RGB-Tools use for their own regtest tests
(`RGB-Tools/rgb-lib`, `tests/compose.yaml`, master @ Oct 2026), keeping only the three services above.
Image versions are pinned; `docker compose -f scripts/regtest/compose.yaml pull` them at home
(~1.1 GB: bitcoind 370 MB, electrs 143 MB, rgb-proxy 583 MB).

Pinned images:
- `registry.gitlab.com/hashbeam/docker/bitcoind:30.2` (Bitcoin Core v30.2.0)
- `registry.gitlab.com/hashbeam/docker/electrs:0.11.0`
- `ghcr.io/rgb-tools/rgb-proxy-server:0.3.0` (proxy protocol 0.2)

## Commands (tested 2026-10-16 on Ubuntu-24.04 / WSL2, Docker 29.1.3)
```bash
docker compose -f scripts/regtest/compose.yaml up -d        # start
docker compose -f scripts/regtest/compose.yaml ps           # check all three are running
docker compose -f scripts/regtest/compose.yaml down -v      # stop and wipe chain
```

Mine N blocks to an address (the wallet only has to be created once per `up -d`):
```bash
docker compose -f scripts/regtest/compose.yaml exec bitcoind \
  bitcoin-cli -regtest -rpcuser=user -rpcpassword=default_password createwallet miner
docker compose -f scripts/regtest/compose.yaml exec bitcoind \
  bitcoin-cli -regtest -rpcuser=user -rpcpassword=default_password generatetoaddress N <address>
```

The agent's `/dev/mine` talks JSON-RPC directly instead — 18443 is published on the host:
```bash
curl -s --data-binary '{"jsonrpc":"1.0","method":"generatetoaddress","params":[1,"<address>"]}' \
  -H 'content-type: text/plain;' http://user:default_password@127.0.0.1:18443/wallet/miner
```

Smoke test after `up -d` (all three answered on a clean start):
```bash
curl -s --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[]}' \
  -H 'content-type: text/plain;' http://user:default_password@127.0.0.1:18443
# -> {"result":101,"error":null}

printf '{"jsonrpc":"2.0","method":"server.version","params":["probe","1.4"],"id":1}\n' | nc 127.0.0.1 50001
# -> {"id":1,"jsonrpc":"2.0","result":["electrs/0.11.0","1.4"]}

curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"1","method":"server.info","params":{}}' \
  http://127.0.0.1:3000/json-rpc
# -> {"jsonrpc":"2.0","id":"1","result":{"protocol_version":"0.2","version":"0.3.0","uptime":30}}
```

RPC credentials are baked into the bitcoind image as an `-rpcauth` hash, so they are fixed:
`BITCOIND_RPC_USER=user`, `BITCOIND_RPC_PASS=default_password` in `.env.local`.

### Gotchas found during setup
- Regtest coinbase outputs need 100 confirmations before they are spendable — mine **101** blocks
  before expecting a balance.
- The upstream compose does **not** publish bitcoind's 18443; ours does, because `/dev/mine` needs it.
- The bitcoind image sets `-rpcallowip` for private ranges only. Ours adds `-rpcallowip=0.0.0.0/0`
  so the other laptops can reach it across the LAN. Regtest only — never do this on a real network.
- `restart: unless-stopped` is set on all three, so the stack comes back after a WSL/Docker restart.

## Windows 10 laptops: LAN reachability
`networkingMode=mirrored` requires Windows 11 22H2+. On Windows 10, WSL sits behind a NAT and these
ports are not reachable from other laptops until you add portproxy rules: use the `netsh interface
portproxy` loop and the firewall rule in `docs/INTEGRATION_PLAN.md`, Phase 0, in an **admin**
PowerShell. The WSL IP changes on every restart — re-run it after `wsl --shutdown` or a reboot.

## Multi-laptop sequence for the demo
Every command runs in WSL Ubuntu 24.04 from the repo root. `.env.local` on each laptop as in
`docs/INTEGRATION_PLAN.md`, Phase 3 — above all `RGB_INDEXER_URL` and `RGB_TRANSPORT_ENDPOINT` with the
**agent laptop's LAN IP on every laptop**, the agent laptop included: the transport endpoint is written
into every invoice (`...&endpoints=rpc://<it>/json-rpc`), and the payer posts its payment there.

1. **Agent laptop:** `docker compose -f scripts/regtest/compose.yaml up -d`, then `... ps` shows three
   services.
2. **Client and freelancer laptops:** `npm run setup:role -- --role client` (or `freelancer`). It saves
   the role's new mnemonic in `.env.local` (never printed) and prints a BTC address. Send that to the
   agent laptop. It prints a fresh address on every run; all of them belong to the same wallet.
3. **Client laptop:** start the party server in real mode (`WALLET_MODE=real`, then
   `npm run dev:party:client`). Its `/health` reports "not enough BTC" until it is funded; it retries
   every 15 s and creates its own UTXOs once the BTC is there. The freelancer laptop may start now too.
4. **Agent laptop:** `npm run demo:setup -- --client-address <address> --freelancer-address <address>`
   (about a minute). It funds all four wallets with BTC, creates the treasury's and agent's UTXOs,
   issues a fresh TUSDT, asks the client's party server (`CLIENT_PARTY_URL`) for a 100 TUSDT invoice,
   pays it, mines until it settles, and writes `ESCROW_ASSET_ID` into `.env.local`.
5. **Client and freelancer laptops:** copy the `ESCROW_ASSET_ID=` line into `.env.local`. Check: the
   client party server's `GET /wallet` shows 100 TUSDT. With the party server stopped,
   `npm run setup:role -- --role <role>` prints the balances and free UTXOs.
6. **Between runs (agent laptop):** stop the agent, keep the client party server running, then
   `npm run demo:reset -- --client-address <address> --freelancer-address <address>`. The treasury and
   agent get new wallets and there is a new asset; the party laptops keep their wallets and just receive
   it. Copy the new `ESCROW_ASSET_ID` again.

**One laptop** (rehearsal, stage fallback): `npm run demo:setup` with no addresses creates all four
wallets on this laptop; then start the agent and both party servers here.

Tested on one machine on 2026-10-17, with the client's laptop simulated by a second env file and its own
real-mode party server: steps 2–5 and `demo:reset` work. Not yet run across real laptops.

Gotchas the scripts handle, so you do not have to:
- BTC comes from bitcoind's `miner` wallet with `sendtoaddress`, never by mining to a wallet: rgb-lib
  picks immature coinbase outputs and the broadcast fails.
- After the WSL distro was idle, Docker restarts the containers and bitcoind's `miner` wallet is
  unloaded; `demo:setup` waits for bitcoind and loads it.
- `setup:role` and `demo:reset` refuse while a party server or the agent runs on that laptop: two
  processes on one wallet `dataDir` lose its RGB state.

## Fallback
If laptops cannot reach each other at the venue: run everything (stack, agent, both parties) on the agent
laptop and open the three views in three browser windows. The UI does not change.
