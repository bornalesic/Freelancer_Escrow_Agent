# packages/wallet — `@escrow/wallet` (WS1)

Implements `EscrowWallet` from `@escrow/shared` twice: `RgbWdkWallet` (real) and `MockWallet`.
Used by `apps/agent` (agent wallet) and `apps/party` (client/freelancer wallets). Runs in **WSL2 Ubuntu**
only — the native RGB binaries have no Windows build.

## Deliver in this order
1. **`MockWallet` by H2** (others are blocked on it). In-memory balances persisted to a shared JSON
   file (`MOCK_LEDGER_PATH`, default `.mock-ledger.json`) with a file lock, so the agent and both
   party servers on one machine see each other's payments. A relative path resolves against the
   **repo root, not the process cwd**: `npm run -w <workspace>` starts each app in its own folder, so a
   cwd-relative path gave every process its own ledger. Invoices: `mock:<recipientId>:<assetId>:<amount>`.
   Transfers go `pending` → `settled` after `MOCK_SETTLE_MS` (default 3000) to mimic real behaviour.
   Seed the ledger: client 100 tUSDT, others 0. With `ESCROW_ASSET_ID` empty the mock asset id is
   `mock-tusdt`, the same default as `apps/agent` (`MOCK_ASSET_ID` in its `config.ts`); keep them equal.
   The seed only applies when the ledger file is first created, so after changing asset env vars
   delete `.mock-ledger.json`.
2. **`RgbWdkWallet`** wrapping `@utexo/wdk-wallet-rgb` (`WalletManagerRgb` → `getAccount()`):
   - `init()`: open manager with `{ network, dataDir, indexerUrl, transportEndpoint, transferMaxFee }`
     from env; `registerWallet()`; if fewer than `MIN_FREE_UTXOS` (default 5) free UTXOs, `createUtxos`.
   - `createInvoice()`: `receiveAsset({ witness: false, assetId?, amount, minConfirmations,
     durationSeconds })`, bound only if the wallet already knows the asset; return invoice + recipient id.
   - `pay()`: `transfer({ token, recipient, amount, feeRate, minConfirmations })`. It quotes internally
     and enforces `transferMaxFee` (`MAX_FEE_SAT`) itself.
   - `refresh()`: `refreshWallet()`; `transfers()`: map `listTransfers`/`getTransfers` output to
     `TransferSummary` (`pending|settled|failed`, keep `rawStatus`).
   - `waitForTransfer()`: loop `refresh()` + `transfers()` every `WALLET_POLL_MS` (env; 2000 on
     regtest, ≥ 10000 on signet: KaleidoSwap asked teams not to poll their esplora in tight loops)
     until settled/failed/timeout.
   - `sign()`: account `sign(message)` + the address `registerWallet()` returned (`getAddress()` hands
     out a new one each call).
   - Serialize all calls through one in-process queue (rgb-lib does not like concurrent calls).
3. **Factory** `createWallet({ role, mode })` reading env: `WALLET_MODE`, `RGB_NETWORK`, `RGB_DATA_DIR`,
   `RGB_INDEXER_URL`, `RGB_TRANSPORT_ENDPOINT`, `<ROLE>_MNEMONIC`.
4. **Scripts** (in `scripts/`, run with `tsx`; done, typecheck with `npx tsc --noEmit -p scripts`):
   - `setup-demo.ts`: treasury + agent wallets (+ client and freelancer, unless `--client-address` /
     `--freelancer-address` say they live on other laptops) → BTC to each from bitcoind's `miner`
     wallet (`sendtoaddress`, **not** mined to the treasury: immature coinbase) → mine → `createUtxos` →
     treasury issues NIA `TUSDT` (precision 6, supply 1,000,000) → 100 to the client (a remote client's
     invoice comes from its party server, `CLIENT_PARTY_URL`) → mine until settled → write
     `ESCROW_ASSET_ID` and new mnemonics into `.env.local` (0600, mnemonics never printed).
   - `reset-demo.ts`: refuses while :4000/:4101/:4102 answer; wipes this laptop's wallets, their
     mnemonics, `ESCROW_ASSET_ID` and the mock ledger, then runs `setup-demo` (fresh mnemonics: an old
     mnemonic on a wiped dataDir gets its BTC back but not its RGB state).
   - `setup-role.ts --role client|freelancer`: party laptop; new mnemonic if none, prints a BTC address
     for `--<role>-address`, then (once funded) UTXOs and balances. The party server also creates its own
     UTXOs once funded, so a re-run is optional. The tested sequence is in `scripts/regtest/README.md`.
   - The issuer is `Treasury` (`src/treasury.ts`, imported lazily as `@escrow/wallet/treasury`); it
     shares `openRgbAccount()` with `RgbWdkWallet`.

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
- The 2.0.3 TypeScript types **do** omit `dataDir`, `indexerUrl`, `transportEndpoint` and
  `transferMaxFee`. (An earlier note here said otherwise: the JSDoc `@typedef` lists them, but the
  emitted `export type RgbWalletConfig` that TypeScript actually uses has only `network` and `keys`.)
  The runtime accepts all of them, so `RgbWdkWallet` builds its own config type and casts at the
  constructor. `network` is typed `'mainnet' | 'testnet' | 'regtest'`; the same cast covers `'signet'`.
- Useful account methods: `registerWallet`, `createUtxos({ upTo, num, size, feeRate })`,
  `issueAssetNia({ ticker, name, precision, amounts })`, `receiveAsset({ witness, assetId, amount })`,
  `transfer({ token, recipient, amount, feeRate, minConfirmations })`, `quoteTransfer`,
  `listAssets`, `listTransfers(assetId)`, `getTransfers`, `refreshWallet`, `syncWallet`,
  `failTransfers`, `sign`, `dispose`. Two names in the original list do **not** exist — see below.
- **Verify every name above against the installed package's README/types before use.** Docs lag code.

## Driving the failure path in mock mode (for WS3 and WS4)
`MockWallet` can produce `status: 'failed'` two ways. Both refund the sender in full — `pay()` debits
up front, so a failure that did not refund would make the amount vanish and the escrow could never
be made whole. The recipient is never credited.

1. **`MOCK_FAIL_AMOUNT`** (env, base units). Paying exactly that amount resolves to `failed` instead
   of `settled` after `MOCK_SETTLE_MS`. No code change, so it is the way to rehearse the refund path
   from the UI: set `MOCK_FAIL_AMOUNT=25000000` and any 25 tUSDT payment fails.
2. **`wallet.failTransfer({ txid, reason? })`**. Not part of `EscrowWallet` — it is the mock's
   stand-in for rgb-lib's `failTransfers`, for tests that need to fail a specific transfer. Only the
   sender may fail its own transfer, and only while it is still pending.

`waitForTransfer` **returns** a failed transfer rather than throwing: a failure is an outcome the
agent has to act on, not an exception. It only throws `WalletTimeoutError` when nothing resolves in
time. A failed transfer does **not** free the invoice for reuse, matching a spent RGB blinded
receive — the payer must request a fresh one.

Verified across separate processes: `node scratch/mock-fail-path.mjs`.

## Learned the hard way

- `@utexo/wdk-wallet-rgb@2.0.3` on Node 22 / Ubuntu 24.04 WSL2: native addon
  (`@utexo/rgb-lib-linux-x64`) loads; `new WalletManagerRgb(mnemonic, { network: 'regtest', dataDir })`
  + `await getAccount()` + `getAddress()` works offline (returns `bcrt1p...`), no indexer needed.
- **`manager.dispose()` throws `Error: Invalid checksum`** after `getAccount()`: it blanks `xpriv` before
  `super.dispose()` disposes the account, whose `keyPair` getter then decodes the empty xpriv. Call
  `account.dispose()` only (or wrap `manager.dispose()` in try/catch).

### The host wall clock jumped ~96 s — FIXED, but check the other three laptops
Found while chasing a 1-in-8 flaky MockWallet test on 2026-10-17. `Date.now()` leaped forward ~96.7 s
and immediately back, several times per ten seconds, in **both** WSL distros, while
`performance.now()` advanced smoothly and `timedatectl` reported "System clock synchronized: yes".
Repro: `node scratch/wsl-clock-jump.mjs`.

**Root cause was on the Windows side, not in WSL.** The `W32Time` service was *Stopped* with startup
type *Manual*, so nothing corrected the host clock and it had drifted **96.67 s slow**
(`w32tm /stripchart /computer:time.windows.com /dataonly` showed `-96.668s`). Inside WSL two time
sources then fought over it: `systemd-timesyncd` pulled the clock forward to true NTP time, and the
Hyper-V host source (`/dev/ptp_hyperv`) dragged it back to Windows' wrong time, forever.

**Fix applied** (admin PowerShell):
```powershell
Set-Service -Name W32Time -StartupType Automatic
Start-Service -Name W32Time
w32tm /resync /force
```
Offset went from −96.668 s to ~2 ms, and both distros now measure 0 jumps with ~1.6 ms worst drift.
`timesyncd` needs a minute or two to stop slewing afterwards (the residual steps shrink 1751 → 1125
→ 711 → 0 ms), so do not judge the fix on the first thirty seconds.

**Every laptop should be checked before the hackathon.** Run `scratch/wsl-clock-jump.mjs` on each.
If two laptops' clocks disagree by ~96 s, the agent's decision log will interleave events in the
wrong order across machines and the judges will see it.

What it did to the mock wallet: a forward jump made every pending transfer instantly "due", so a
60-second settlement completed at once — in the real flow that is **releasing escrowed funds early**.
The backward jump then stalled settlement for ~96 s.

Keep the code defensive anyway. A clock step is not exotic: an NTP correction, a laptop resuming
from sleep, or a venue network finally letting NTP through will all do it mid-demo.
**Any deadline measured as `Date.now() + timeout` can fire early or stall.** That covers
`AI_PARSE_TIMEOUT_MS`, `AI_EXPLAIN_TIMEOUT_MS`, `AI_REVIEW_TIMEOUT_MS`, `VERIFY_DEFAULT_TIMEOUT_SEC`,
the verifier's per-condition `timeoutSec`, `waitForTransfer` timeouts, invoice expiry and
`REVIEW_WINDOW_SEC`. Tell WS2 and WS3.

`REVIEW_WINDOW_SEC` is the dangerous one (client review, `docs/ESCROW_FLOW.md`): when
`reviewDueAt = now + REVIEW_WINDOW_SEC` passes with no answer, the agent **releases** to the
freelancer. With the ~120 s demo window, a ~96 s forward jump pays out before the client has had a
chance to approve or dispute. WS3 should time the window monotonically (keep `reviewDueAt` as the
displayed value only).

The fix in this package is `src/clock.ts`: wall clock for human-facing timestamps only (`createdAt`,
`expiresAt` — coarse enough to tolerate the skew), and a monotonic clock for every duration and
deadline. `performance.now()` has a per-process origin so it cannot be written to the shared ledger;
`/proc/uptime` is monotonic *and* shared by every process on the host, so that is what the ledger
stores. A transfer whose `createdAtMono` is in the future came from a previous boot and is treated as
due. Regression test: "does not settle a pending transfer when Date.now() jumps forward".

### From pre-hackathon setup (2026-10-16/17, verified against the installed package)
Probe folder: `~/scratch/wdk-probe` in WSL **Ubuntu-24.04**. Everything below was read out of
`@utexo/wdk-wallet-rgb@2.0.3` as actually installed, not from docs.

- **Installs and loads on Ubuntu 24.04 / glibc 2.39 / Node 22.23.3.** Exports are `default`
  (= `WalletManagerRgb`), `WalletAccountRgb`, `WalletAccountReadOnlyRgb`. It pins `@utexo/rgb-sdk`
  to exactly `1.0.3`, confirming the glibc ≥ 2.38 constraint. Ubuntu 22.04 (glibc 2.35) is unusable.
- **`WalletManagerRgb extends WalletManager` from `@tetherto/wdk-wallet`**, and `WalletAccountRgb
  extends WalletAccountReadOnlyRgb implements IWalletAccount`. So it is already WDK-shaped — that is
  most of the answer to the SETUP question "can `@tetherto/wdk` core register `WalletManagerRgb`?".
  `@tetherto/wdk` core is `1.0.0-beta.20`; the actual `registerWallet`-into-core call is still untested.
- **The balance API is not what the plan above assumes.** There is no public `getAssetBalance`.
  The wrapper exposes:
  - `getBalance(): Promise<bigint>` — BTC in sats, internally `getBtcBalance().vanilla.settled`
  - `getTokenBalance(assetId): Promise<bigint>` — asset base units, internally
    `getAssetBalance(assetId).settled`

  Both **flatten to `.settled` and throw away `future` and `spendable`.** If the agent needs to show
  a pending-but-not-settled balance, reach the underlying rgb-lib wallet via `account.getRgbWallet()`.
  Decide this early — it affects what `EscrowWallet.balance()` can return.
- **`decodeRGBInvoice` does not exist** anywhere in the package. If we need to validate or inspect an
  invoice before paying, it has to come from `@utexo/rgb-sdk` or be done by hand.
- **Most read calls are synchronous** (return a value, not a Promise): `listAssets()`,
  `listTransfers(assetId)`, `listUnspents()`, `listTransactions()`, `failTransfers(id)`,
  `refreshWallet()`, `syncWallet()`, `dispose()`. Async ones: `getBalance`, `getTokenBalance`,
  `transfer`, `quoteTransfer`, `sendTransaction`, `sign`, `verify`, `getTransfers`,
  `getTransactionReceipt`, `getTransferReceipt`, `toReadOnlyAccount`, `registerWallet`.
  Do not blanket-`await` — and the serializing queue must handle sync calls too.
- **`registerWallet()` is async.** The package README shows it used synchronously ("synchronous in
  v2"), but the source is `async registerWallet ()` and the shapes probe saw a Promise. `await` it.
- `manager.getAccount(index?)` is **async** and only index 0 is valid. `getAccountByPath()` returns
  `Promise<never>` — it is not supported; do not plan on derivation paths.
- `transferMaxFee` is a config field on `RgbWalletConfig` — use it for `MAX_FEE_SAT` instead of only
  checking `quoteTransfer` by hand.
- The JSDoc on both constructors says "network and **rgbNodeEndpoint** are required", but no
  `rgbNodeEndpoint` field exists in `RgbWalletConfig`. Stale doc text; ignore it.
- v2 is a breaking change from v1 and the package ships its own `MIGRATION.md` — read it before
  copying any v1 example off the internet.
- The package declares **no peerDependencies**, so nothing will warn you if an override changes the
  `@utexo/rgb-sdk` version. The "do not override" rule above is unenforced — be careful.

### From the full-path rehearsal (2026-10-17, regtest, all green)
Script: `scratch/rehearsal.mjs` (also at `~/scratch/wdk-probe/rehearsal.mjs`, run it with
`node rehearsal.mjs --fresh`). It does the whole SETUP §3 path: 3 wallets → fund by mining →
`createUtxos` → issue NIA → invoice → transfer → mine → refresh both → settled, twice
(treasury→client 100, client→freelancer 40). Full log: `scratch/rehearsal-log.txt`.

**Transfer status strings — the answer this section was waiting for.** Both sides go through exactly:
```
WaitingCounterparty  ->  WaitingConfirmations  ->  Settled
```
Map these in `TransferSummary`: `WaitingCounterparty`/`WaitingConfirmations` → `pending`,
`Settled` → `settled`, `Failed` → `failed`. Keep the raw string in `rawStatus`.

**Who has to refresh, and in what order.** The transfer does not advance on its own:
1. `transfer()` returns with both sides at `WaitingCounterparty`.
2. **Recipient** `refreshWallet()` → recipient moves to `WaitingConfirmations` (this is the step that
   pulls the consignment off the proxy — without it nothing ever progresses).
3. **Sender** `refreshWallet()` → sender moves to `WaitingConfirmations`.
4. Mine blocks, refreshing both after each. Each side settles at its **own** `minConfirmations`: the
   sender at the value passed to `transfer()` (1 in the rehearsal), the recipient at the value its
   invoice was created with — and rgb-sdk's `blindReceive` defaults to **3** (README: `minConfirmations:
   3`, `durationSeconds: 2000`). The rehearsal didn't pass one, so the sender settled after block 1
   and the recipient only after block 3. **Do not stop polling when the sender says Settled** — wait
   for the recipient. `RgbWdkWallet.createInvoice()` must pass `minConfirmations: MIN_CONFIRMATIONS`:
   WDK's `receiveAsset(options)` forwards options to `blindReceive` untouched, though its 2.0.3 types
   declare only `assetId`, `amount`, `witness` (needs a small type augmentation). On signet, 3 blocks
   is ~30 min.

On regtest the whole invoice→settled cycle takes **under a second**. `WALLET_POLL_MS=2000` is fine.

**`ESCROW_ASSET_TICKER=tUSDT` in `.env.example` is invalid.** rgb-lib rejects a mixed-case ticker:
`RgbLib(InvalidTicker { details: "ticker needs to be all uppercase" })`. The ticker must be `TUSDT`.
The asset *name* is free-form, so "tUSDT" can still be what the UI shows. Fixed in `.env.example`.

**A wallet cannot invoice for an asset it has never seen.** `receiveAsset({ assetId, ... })` on a
wallet with no history of that asset throws `RgbLib(AssetNotFound { asset_id: "rgb:..." })`. The
first invoice to each new wallet must **omit `assetId`** — it learns the asset from the incoming
consignment, and later invoices can be bound. This hits the demo directly: the freelancer's first
tUSDT invoice is necessarily unbound. `scratch/rehearsal.mjs` has a `makeInvoice()` helper that picks
the right form by checking `listAssets()` first; reuse that shape in `RgbWdkWallet.createInvoice()`.
Note the security consequence: an unbound invoice will accept *any* asset, so the agent must verify
the asset id on the received transfer rather than trusting the invoice.

**Coinbase maturity.** rgb-lib's coin selection does not filter for it. Funding a wallet by mining
straight to its address and immediately calling `createUtxos` fails with
`FailedBroadcast ... bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 26`.
`setup-demo.ts`'s design (mine to a treasury, *send* BTC to each wallet) sidesteps this because
ordinary outputs have no maturity rule — keep that design. If you ever do mine directly to a wallet,
mine 100+ more blocks before using the funds.

**Other things that will bite:**
- `electrs` accepts TCP on 50001 immediately but **never answers while the chain is at height 0**
  (`waiting for 0 blocks to download (IBD)`). Every rgb-lib call then fails with
  `WalletError: Failed to establish online connection`. After `down -v`, mine a block *before*
  opening any wallet. `demo:reset` must do this. The rehearsal has an `electrsReady()` gate.
- Node's `fetch()` **refuses** `http://user:pass@host` ("Request cannot be constructed from a URL
  that includes credentials"). `/dev/mine` has to send an `Authorization: Basic ...` header instead.
- `quoteTransfer()` and `transfer()` return **BigInt** fields (`fee`), so a plain `JSON.stringify` of
  the result throws `Do not know how to serialize a BigInt`. Matters wherever we log or send them.
- `transfer()` internally calls `sendBegin` **twice** (plus once more if you call `quoteTransfer`
  first). Harmless but it makes the logs confusing, and it means a transfer is not as cheap as it looks.
- The SDK prints to stdout uninvited: `indexerUrl tcp://...`, `sendBegin params {...}`, and
  `rgb-lib estimation fee are not available, using default fee rate 2`. On regtest the `feeRate` we
  pass appears to be ignored in favour of that default. Expect noise in the agent logs.
- The fee for a transfer was a flat **309 sats** in both transfers.
- `createUtxos()` was ~800 ms on a warm indexer, but took **98 s once** right after bulk-mining a few
  hundred blocks, while electrs caught up. Do not set a tight timeout on the first call after
  `demo:reset`, and prefer to warm up before the audience is watching.
- `issueAssetNia()` returns the full asset including `balance: { settled, future, spendable }` — this
  is the one place the triple is visible without reaching for `getRgbWallet()`.

**Measured on this laptop (regtest, warm):** `getAccount` ~310 ms · `registerWallet` ~390 ms ·
`createUtxos` ~800 ms · `syncWallet` ~330 ms · `transfer` ~190 ms · `quoteTransfer` ~100 ms ·
`issueAssetNia` ~90 ms · `receiveAsset` ~50 ms · `refreshWallet` 1–250 ms · `getBalance` ~125 ms ·
`getTokenBalance` ~1 ms. Confirms the sync/async split listed above.

### From the shapes probe (2026-10-17, regtest, all steps green)
Script: `~/scratch/wdk-probe/probe-shapes.mjs` in Ubuntu-24.04 (full output in `probe-shapes-log.txt`
next to it): treasury issues TUSDT, then unbound and bound invoices, payments, errors, sign. The
`.d.ts` files are wrong in several places, so `RgbWdkWallet` declares its own narrow types for the
account from **these** runtime shapes instead of using the package's.

- **Transfer rows** (`listTransfers`): `{ idx, batchTransferIdx, createdAt, updatedAt` (unix seconds)`,
  status, requestedAssignment: { Fungible }, assignments: [{ Fungible }], kind, txid, recipientId,
  receiveUtxo, changeUtxo, expiration, transportEndpoints, invoiceString, consignmentPath }`. `status`
  and `kind` are **strings** (`"WaitingCounterparty"`, `"ReceiveBlind"`, `"Send"`, `"Issuance"`) even
  though the `.d.ts` declares numeric enums. There is **no `amount` field**.
- **Amounts.** On a `Send` row `requestedAssignment.Fungible` is what was sent and `assignments` is the
  **change**. On a receive row `assignments` is what actually arrived. **A recipient accepts and
  settles an underpayment**: invoice for 2, paid 1 → `Settled` with `assignments: [{Fungible: 1000000}]`,
  and nothing stopped the sender either. So the incoming amount must come from `assignments`, or the
  agent's "received less than expected" check never fires.
- **An invoice is a transfer row from the moment it is created**: `ReceiveBlind`, `WaitingCounterparty`,
  `txid: null`, `assignments: []`, before anyone pays. Reported as a transfer it would make the agent
  log "payment seen" early, so `RgbWdkWallet.transfers()` drops rows that have received nothing.
- **A wallet that has never seen the asset:** `listTransfers(assetId)` and `getAssetBalance(assetId)`
  both throw `RgbLib(AssetNotFound)`, and its unbound invoice shows up only in `listTransfers()` with no
  argument (which lists asset-less rows only). After the recipient's first refresh the row moves under
  the asset (`WaitingConfirmations`, `txid` set).
- **`transfer().hash` equals the sender row's `txid`**, and the recipient row's once it is picked up. The
  agent matches payouts by txid, so this has to hold.
- **While an outgoing payment is in flight:** `settled` is unchanged, `future` is reduced, `spendable` is
  **0** (the whole allocation is locked). **So a wallet can have only one outgoing payment at a time**:
  a second `transfer()` fails with `InsufficientAssignments { available: { fungible: 0 } }` until the
  first settles. For the agent: releasing one escrow blocks paying out another until it settles.
  `MockWallet` lowers `settled` immediately; that difference is known and harmless for the demo.
- `receiveAsset` passes `minConfirmations` and `durationSeconds` through (expiry exactly 600 s; recipient
  settled after 1 block). **`BigInt` amounts are rejected** (`Do not know how to serialize a BigInt`):
  pass a `number`, after checking it is a safe integer.
- **Each open invoice reserves one colorable UTXO** (`pendingBlinded`) until it is paid or expires. With
  none free, `receiveAsset` throws `RgbLib(InsufficientAllocationSlots)`; `createUtxos({ upTo: true,
  num: 5 })` made 5 more. Free means `colorable && rgbAllocations.length === 0 && !pendingBlinded`.
- **Error messages** (`err.message`): already-paid invoice → `RGB transfer failed: RgbLib(RecipientIDAlreadyUsed)`;
  not enough → `RgbLib(InsufficientAssignments { ..., available: ... })`, thrown by the internal
  `quoteTransfer` and therefore **not** prefixed; bad invoice → `RgbLib(InvalidInvoice { details:
  "invalid contract ID." })`.
- BTC: `getBtcBalance().vanilla.settled` stays 0 until `syncWallet()`, but `spendable` is right without
  it. `getAddress()` returns a **new address on every call**; keep the one `registerWallet()` returned.
- `issueAssetNia()` returns the asset flat (the `.d.ts` says `{ asset }`); `listAssets()` returns
  `{ nia, uda, cfa, ifa }` arrays, each asset with `balance: { settled, future, spendable }`.
- `sign()` returns a base64 string and `verify()` accepts it. `failTransfers({ batchTransferIdx: 5 })`
  throws "numbers must be passed as strings"; not explored further, since `EscrowWallet` does not need it.
- **The Ubuntu-24.04 distro shuts down when idle**, which stops Docker. On the next start the containers
  come back with the chain intact but bitcoind's `miner` wallet **unloaded**: `loadwallet miner` before
  mining from it. Keep a 24.04 terminal open during the demo.

### From the hackathon
(fill in)

## Tests
- `MockWallet`: vitest — pay between two instances sharing a ledger file; pending → settled timing.
- `RgbWdkWallet`: an opt-in integration test (`RGB_IT=1 npm test -w packages/wallet`) against regtest
  doing invoice → pay → mine → settled. Not part of the default test run.
