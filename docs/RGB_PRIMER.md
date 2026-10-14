# RGB in 5 minutes (what you need for this project)

Read this before touching wallet code. Source of truth for concepts: https://docs.rgb.info/

## The mental model

- RGB assets live **off-chain**, but every asset allocation is bound to a Bitcoin UTXO
  (a "single-use seal"). Spending that UTXO is what makes a transfer final; Bitcoin prevents
  double-spends.
- There is no global ledger of RGB balances. Each wallet keeps its own **local RGB state**
  (in `dataDir`) and validates the history it receives (**client-side validation**).
- Because of that: losing `dataDir` loses your RGB balance even if you still have the seed,
  and opening the same wallet in two processes can corrupt or lose state.

## A transfer, step by step

1. **Receiver prepares.** The wallet needs spare "colorable" UTXOs. `createUtxos()` makes them
   (costs a little BTC for fees). Do it once at setup, and again if you run out.
2. **Receiver creates an invoice** (`receiveAsset` → string starting with `rgb:`), which names the
   asset, amount and where to receive.
   - *Blind receive*: the receiver supplies a blinded UTXO of its own. Default for us.
   - *Witness receive*: the sender creates a new output to the receiver's address (sender pays sats).
3. **Sender pays the invoice** (`transfer`). This builds a Bitcoin transaction committing to the
   RGB state change and posts the **consignment** (the proof data) to the **transport endpoint**
   (an RGB proxy server).
4. **Receiver refreshes.** It downloads the consignment from the proxy, validates it, and
   acknowledges. **Both sides must call `refresh()`** for the transfer to move forward.
5. **Confirmation.** After the Bitcoin transaction confirms (`minConfirmations`), both wallets mark
   the transfer settled. On regtest we mine a block to make this instant.

Statuses you will see from rgb-lib are roughly: waiting for counterparty → waiting for confirmations →
settled (or failed). Our `TransferSummary` maps them to `pending | settled | failed` and keeps the raw
value in `rawStatus`.

## Infrastructure every wallet needs

| Piece | What it does | Our regtest default |
| ----- | ------------ | ------------------- |
| bitcoind | the chain | `localhost:18443` |
| Electrum/Esplora indexer | wallets read chain data through it (`indexerUrl`) | `tcp://<host>:50001` |
| RGB proxy | relays consignments between wallets (`transportEndpoint`) | `rpc://<host>:3000/json-rpc` |

## Gotchas we already know about

- Use **asset ids**, never tickers, in invoices and sends.
- Invoices are **single-use**; create a fresh one per payment.
- A failed send often means "no free colorable UTXOs" — call `createUtxos()`.
- `@utexo/wdk-wallet-rgb` 2.0.3 has native binaries for Linux and Apple Silicon only → on Windows,
  run wallet processes in **WSL2**.
- The released 2.0.3 docs list networks `mainnet | testnet | regtest`. Other names (`utexo`, `signet`)
  appear in newer READMEs; confirm with UTEXO mentors before relying on them.
- Never commit mnemonics. Each laptop and each role has its own seed in `.env.local`.

## WDK in one sentence

WDK is Tether's wallet toolkit: a common interface for wallet managers/accounts across chains.
`@utexo/wdk-wallet-rgb` is the community WDK module for on-chain RGB; using it (and, if it works, the
WDK core `@tetherto/wdk` registration on top) is what earns the WDK bonus. Make the WDK usage
**visible** in the demo: the UI should say "Self-custodial wallet · Tether WDK".
