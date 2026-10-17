# packages/wallet — `@escrow/wallet` (WS1)

Implements `EscrowWallet` from `@escrow/shared` twice: `RgbWdkWallet` (real) and `MockWallet`.
Used by `apps/agent` (agent wallet) and `apps/party` (client/freelancer wallets). Runs in **WSL2 Ubuntu**
only — the native RGB binaries have no Windows build.

## Deliver in this order
1. **`MockWallet` by H2** (others are blocked on it). In-memory balances persisted to a shared JSON
   file (`MOCK_LEDGER_PATH`, default `../../.mock-ledger.json`) with a file lock, so the agent and both
   party servers on one machine see each other's payments. Invoices: `mock:<recipientId>:<assetId>:<amount>`.
   Transfers go `pending` → `settled` after `MOCK_SETTLE_MS` (default 3000) to mimic real behaviour.
   Seed the ledger: client 100 tUSDT, others 0.
2. **`RgbWdkWallet`** wrapping `@utexo/wdk-wallet-rgb` (`WalletManagerRgb` → `getAccount()`):
   - `init()`: open manager with `{ network, dataDir, indexerUrl, transportEndpoint }` from env;
     `registerWallet()`; if fewer than `MIN_FREE_UTXOS` (default 5) free UTXOs, `createUtxos`.
   - `createInvoice()`: `receiveAsset({ witness: false, assetId, amount })`; return invoice + recipient id.
   - `pay()`: `quoteTransfer` (abort if fee > `MAX_FEE_SAT`), then `transfer({ token, recipient, amount,
     feeRate, minConfirmations })`.
   - `refresh()`: `refreshWallet()`; `transfers()`: map `listTransfers`/`getTransfers` output to
     `TransferSummary` (`pending|settled|failed`, keep `rawStatus`).
   - `waitForTransfer()`: loop `refresh()` + `transfers()` every `WALLET_POLL_MS` (env; 2000 on
     regtest, ≥ 10000 on signet: KaleidoSwap asked teams not to poll their esplora in tight loops)
     until settled/failed/timeout.
   - `sign()`: account `sign(message)` + `getAddress()`.
   - Serialize all calls through one in-process queue (rgb-lib does not like concurrent calls).
3. **Factory** `createWallet({ role, mode })` reading env: `WALLET_MODE`, `RGB_NETWORK`, `RGB_DATA_DIR`,
   `RGB_INDEXER_URL`, `RGB_TRANSPORT_ENDPOINT`, `<ROLE>_MNEMONIC`.
4. **Scripts** (in `scripts/`, run with `tsx`):
   - `setup-demo.ts`: create/open treasury, agent, client, freelancer wallets (separate dataDirs) → mine
     101 blocks to treasury → send BTC to each wallet → mine → `createUtxos` on each → treasury issues NIA
     `tUSDT` (precision 6, supply 1,000,000) → send 100 to client → mine → refresh all → print asset id
     and write `ESCROW_ASSET_ID` into `.env.local`.
   - `reset-demo.ts`: stop-safe wipe of dataDirs + mock ledger, then `setup-demo`.
   - Wallets on different laptops: run `setup-demo` on the stack laptop for the treasury, and a
     `setup-role.ts --role client` on each party laptop that prints its BTC address + creates UTXOs
     once funded. Keep it simple; document the exact sequence in `scripts/regtest/README.md`.

## Facts already verified (from docs, Oct 2026)
- Package: `@utexo/wdk-wallet-rgb`, default export `WalletManagerRgb(seed, config)`; one account (index 0)
  via `getAccount()`. Beta. ESM. Wraps `@utexo/rgb-lib-bare` + `@utexo/rgb-sdk`.
- Released 2.0.3 (still the latest on npm): native artifacts for Linux x64/arm64 and macOS arm64 only.
  It pins `@utexo/rgb-sdk` **1.0.3** → rgb-lib **0.3.0-beta.8**, whose Linux binary needs
  **glibc ≥ 2.38** (Ubuntu 24.04 yes, 22.04 no). Check with `ldd --version`.
- **Do not override `@utexo/rgb-sdk`** (e.g. to 1.0.6, whose binary needs only glibc 2.34). Another team
  found the same mnemonic then derives a **different wallet** (vanillaKeychain 0 instead of 1). If an
  override is ever unavoidable, every laptop and script must use it from the very first wallet creation.
- Networks: the 2.0.3 types say `mainnet | testnet | regtest`, but the wrapper passes `network` straight
  to rgb-sdk, which also accepts `signet` (UTEXO confirmed plain signet works; `signetcustom` does not).
  Extend the local type augmentation to include `'signet'` if we switch.
- The 2.0.3 TypeScript types omit `dataDir`, `indexerUrl`, `transportEndpoint` even though the runtime
  accepts them → add a small local type augmentation, pinned to the version.
- Useful account methods: `registerWallet`, `createUtxos({ upTo, num, size, feeRate })`,
  `issueAssetNia({ ticker, name, precision, amounts })`, `receiveAsset({ witness, assetId, amount })`,
  `transfer({ token, recipient, amount, feeRate, minConfirmations })`, `quoteTransfer`,
  `getAssetBalance(assetId)` → `{ settled, future, spendable }`, `listAssets`, `listTransfers(assetId)`,
  `getTransfers`, `refreshWallet`, `syncWallet`, `failTransfers`, `decodeRGBInvoice`, `sign`, `dispose`.
- **Verify every name above against the installed package's README/types before use.** Docs lag code.

## Learned the hard way
(fill in during setup and the hackathon: exact status strings, which calls are sync vs async,
how long a refresh takes, what errors look like when UTXOs run out, ...)

- `@utexo/wdk-wallet-rgb@2.0.3` on Node 22 / Ubuntu 24.04 WSL2: native addon
  (`@utexo/rgb-lib-linux-x64`) loads; `new WalletManagerRgb(mnemonic, { network: 'regtest', dataDir })`
  + `await getAccount()` + `getAddress()` works offline (returns `bcrt1p...`), no indexer needed.
- **`manager.dispose()` throws `Error: Invalid checksum`** after `getAccount()`: it blanks `xpriv` before
  `super.dispose()` disposes the account, whose `keyPair` getter then decodes the empty xpriv. Call
  `account.dispose()` only (or wrap `manager.dispose()` in try/catch).

## Tests
- `MockWallet`: vitest — pay between two instances sharing a ledger file; pending → settled timing.
- `RgbWdkWallet`: an opt-in integration test (`RGB_IT=1 npm test -w packages/wallet`) against regtest
  doing invoice → pay → mine → settled. Not part of the default test run.
