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
ports are not reachable from other laptops until you add portproxy rules. Run
`scratch/wsl-lan-setup.ps1` in an **admin** PowerShell (firewall rule + `netsh interface portproxy`
for 3000/4000/4101/4102/5173/18443/50001). The WSL IP changes on every restart — re-run it after
`wsl --shutdown` or a reboot.

## Multi-laptop sequence for the demo
1. Agent laptop: `up -d`, then `npm run demo:reset` (treasury, agent wallet, tUSDT issuance).
2. Client and freelancer laptops: point `RGB_INDEXER_URL` / `RGB_TRANSPORT_ENDPOINT` at the agent
   laptop's LAN IP, run `npm run setup:role -- --role client` (or `freelancer`): prints the BTC address.
3. Agent laptop: fund those addresses from the treasury, mine, then each party laptop re-runs
   `setup:role` to create UTXOs. Treasury sends 100 tUSDT to the client.
Write the final, tested version of this sequence here.

## Fallback
If laptops cannot reach each other at the venue: run everything (stack, agent, both parties) on the agent
laptop and open the three views in three browser windows. The UI does not change.
