# Regtest stack (WS1)

A private Bitcoin regtest chain + Electrum indexer + RGB proxy, run with Docker inside WSL2 on the
**agent laptop**. All wallets on all laptops point at it over the LAN.

| Service | Port | Used as |
| ------- | ---- | ------- |
| bitcoind (regtest) | 18443 | chain; mining via JSON-RPC (`/dev/mine`) |
| electrs | 50001 | `RGB_INDEXER_URL=tcp://<agent-LAN-IP>:50001` |
| rgb-proxy-server | 3000 | `RGB_TRANSPORT_ENDPOINT=rpc://<agent-LAN-IP>:3000/json-rpc` |

## Before the hackathon (setup, not building)
Reuse the compose file that RGB-Tools use for their own regtest tests (look in the `rgb-lib` repository's
`tests/` folder, or `regtest.sh` in `rgb-lightning-node`). Copy it here as `compose.yaml`, pin image
versions, `docker compose pull` at home, then fill in the commands below and test them.

## Commands (fill in exact versions)
```
docker compose -f scripts/regtest/compose.yaml up -d        # start
docker compose -f scripts/regtest/compose.yaml down -v      # stop and wipe chain
# mine N blocks to an address:
docker compose -f scripts/regtest/compose.yaml exec bitcoind \
  bitcoin-cli -regtest -rpcuser=<user> -rpcpassword=<pass> generatetoaddress N <address>
```
RPC credentials → `BITCOIND_RPC_USER` / `BITCOIND_RPC_PASS` in `.env.local`.

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
