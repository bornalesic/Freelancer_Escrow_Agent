# Setup — do this BEFORE the hackathon

Installing tools, downloading models and learning the APIs is not "building", and it is where most
hackathon hours get lost. Everyone does section 1; each workstream also does its own section.
Venue Wi-Fi will be slow: **download everything at home.**

> Confirm with the organizers that a repo containing only docs/CLAUDE.md/config (no product code) is
> fine to bring. If not, bring these files as a zip and commit them on site at H0.

## 1. Everyone

- [ ] Node.js **≥ 22.17** and npm ≥ 10.9 (QVAC requirement). `node -v`
- [ ] Git, a GitHub account added to the team repo.
- [ ] Claude Code installed and logged in. Run it once in this repo and ask it to summarize `CLAUDE.md`.
- [ ] Read `docs/ARCHITECTURE.md`, `docs/ESCROW_FLOW.md`, `docs/RGB_PRIMER.md` (20 minutes total).
- [ ] Watch the two RGB videos and the WDK/QVAC tutorials from the organizers' Drive folder.
### All laptops are Windows → this is our standard environment

The wallet library has no Windows binary, so **everything except `apps/ai` runs inside WSL2 Ubuntu**.
`apps/ai` (QVAC) runs **natively on Windows**, because GPU inference needs the Windows Vulkan driver.

- [ ] Confirm the Ubuntu shell is **WSL2**, not WSL1: in PowerShell run `wsl -l -v` → VERSION must be 2.
      If it shows 1: `wsl --set-version Ubuntu 2`.
- [ ] Update WSL: `wsl --update`. Ubuntu 22.04 or 24.04 is fine.
- [ ] Inside Ubuntu: install Node 22 (via `nvm`: `nvm install 22`), `git`, `build-essential`, `python3`.
- [ ] Clone the repo **inside the WSL filesystem** (`~/code/rgb-escrow-agent`, not `/mnt/c/...`;
      it is much faster and avoids permission problems). Open it with `code .` from Ubuntu.
- [ ] Enable mirrored networking so WSL shares Windows' `localhost` **and LAN IP** (other laptops can
      then reach your WSL servers): create `%UserProfile%\.wslconfig` with
      ```
      [wsl2]
      networkingMode=mirrored
      ```
      then `wsl --shutdown` and reopen Ubuntu. Requires Windows 11 22H2+. On Windows 10, tell WS1;
      we'll use `netsh interface portproxy` rules instead.
- [ ] Windows Firewall: allow inbound TCP on our ports. In **admin** PowerShell:
      ```
      New-NetFirewallRule -DisplayName "escrow-demo" -Direction Inbound -Protocol TCP -LocalPort 3000,4000,4101,4102,4300,5173,18443,50001 -Action Allow
      ```
      With mirrored mode you may also need: `Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow`
- [ ] Test LAN reachability at home with two laptops: run `python3 -m http.server 4000` in one WSL,
      open `http://<its-LAN-IP>:4000` from the other laptop's browser.
- [ ] Docker (only the regtest-stack laptop needs it): Docker Desktop with the WSL2 backend, or
      Docker Engine installed directly inside Ubuntu.
- [ ] **Only on the AI laptop (Borna's):** install Node 22 on **Windows** too (from nodejs.org), and keep
      a second clone of the repo on the Windows side (e.g. `C:\code\rgb-escrow-agent`) used only to run
      `apps/ai`. Do not run `npm install` for the same folder from both Windows and WSL.
- [ ] Tell the team your laptop specs. Fill the table below.

| Laptop | Person | OS | RAM | GPU | Planned role on demo day |
| ------ | ------ | -- | --- | --- | ------------------------ |
| 1 | Borna | Windows + WSL2 | 16 GB | GTX 1060 | AI host (`apps/ai`, native Windows) |
| 2 | | Windows + WSL2 | | | Agent (projector) + regtest stack |
| 3 | | Windows + WSL2 | | | Client |
| 4 | | Windows + WSL2 | | | Freelancer |

If another laptop has a stronger GPU than the GTX 1060, swap it in as the AI host.

## 2. WS2 — AI (and whoever hosts the model)

- [ ] Check GPU support. Windows: install the Vulkan SDK, run `vulkaninfo --summary`, confirm
      **apiVersion ≥ 1.4** (QVAC requires Vulkan 1.4 on Windows even for CPU inference). Update the
      NVIDIA driver first if it is lower. Linux: same with `vulkan-tools`.
- [ ] `npx @qvac/cli doctor` (or install `@qvac/cli`) and save the output.
- [ ] Run the QVAC quickstart from https://docs.qvac.tether.io (quickstart page) with
      `QVAC_CONFIG_PATH` logging on.
- [ ] Find the **exact exported constant names** for the Qwen models in the installed SDK
      (`grep -o "QWEN[A-Z0-9_]*" node_modules/@qvac/sdk/dist -r | sort -u`). Write them into
      `apps/ai/CLAUDE.md` → "Model constants".
- [ ] **Pre-download** the 4B and 2B models by loading each once (they are cached). Note the cache
      directory. Copy the cache to a USB stick for the other laptops.
- [ ] Measure on your machine: load time, tokens/sec for 4B and 2B on GPU, and on CPU. Write them in
      `apps/ai/CLAUDE.md` → "Measured performance".
- [ ] Run the tool-calling example from the text-generation docs page; confirm `tool_choice` with a
      named tool works with a Qwen model.

## 3. WS1 — Wallet

- [ ] In Linux / WSL2 / macOS arm64: `npm i @utexo/wdk-wallet-rgb` in a scratch folder and run the
      README quick start against **regtest**. Confirm the native addon loads.
- [ ] Get a regtest stack running (bitcoind + electrs + rgb-proxy). Do **not** write one from scratch:
      reuse the compose file used by RGB-Tools for their own tests (look in the `rgb-lib` repo
      `tests/` folder, or `regtest.sh` in `rgb-lightning-node`). Pin the image versions, `docker pull`
      them at home, and write the exact start/stop/mine commands into `scripts/regtest/README.md`.
- [ ] In the scratch folder, script the full path once by hand: 3 wallets → fund BTC by mining →
      `createUtxos` → issue NIA `tUSDT` → invoice → transfer → mine → refresh both → settled.
      Note every surprise in `packages/wallet/CLAUDE.md` → "Learned the hard way".
- [ ] Check whether `@tetherto/wdk` core can register `WalletManagerRgb` (gives a clearer WDK story).

## 4. WS3 — Escrow core

- [ ] Read `docs/CONTRACTS.md` closely; you drive turning it into `packages/shared` at H0.
- [ ] Decide the HTTP framework (default: Fastify + `@fastify/websocket` + `@fastify/multipart`).
- [ ] Make sure Docker works (optional sandbox for running deliverable tests).

## 5. WS4 — UI + demo

- [ ] Sketch the three screens on paper (client, freelancer, agent log). Pick colours/fonts.
- [ ] Prepare the demo deliverable described in `fixtures/README.md` (a tiny project with a failing
      v1 and a passing v2). This is test data, not product code.
- [ ] Draft the pitch outline from `docs/DEMO_SCRIPT.md`.
