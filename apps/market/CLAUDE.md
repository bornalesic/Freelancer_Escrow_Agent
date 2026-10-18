# apps/market — marketplace UI (replaces apps/web for the demo)

React + Vite + TypeScript + Tailwind on :5174 (apps/web keeps :5173). Built from `Change_of_UI_and_system.md`:
a two-sided marketplace on the existing engine. Everyday screens hide the crypto plumbing; each job has
an "Under the hood: RGB on Bitcoin" panel, open on the service screen.

## Run
`npm run dev:market`, plus on the same laptop the agent URL (`VITE_AGENT_URL`) and both party servers
(`npm run dev:parties`). Open it as **http://localhost:5174**: the party servers refuse pages from any
other origin. `npm run dev:mock` starts everything (agent, both parties, mock AI, market) in mock mode.
URLs: `VITE_AGENT_URL`, `VITE_CLIENT_PARTY_URL`, `VITE_FREELANCER_PARTY_URL`, overridable per tab with
`?agent=` `?client=` `?freelancer=` (remembered in sessionStorage).

## Routes
| Path | Who | What |
| ---- | --- | ---- |
| `/` | anyone | pick Client or Freelancer (switchable any time in the header) |
| `/client`, `/client/new`, `/client/jobs/:id` | client | my listings; new listing (fee breakdown + balance check); requirements review → approve and publish (pre-authorises auto-pay) → status, checks, QVAC review, previews, approve/dispute, downloads after release |
| `/freelancer`, `/freelancer/mine`, `/freelancer/jobs/:id` | freelancer | marketplace (sort by reward/deadline, filter); listing (ask QVAC, take); my jobs; practice check, send work (payout invoice attached automatically) |
| `/how` | anyone | how payments work, rules, what RGB is |
| `/service` | projector (agent laptop) | money held per job, fees, the service's own wallet, live log, RGB panel open. Never party balances. "Demo: clear all jobs" = `POST /dev/reset` |

The role lives in the URL, not in storage, so two tabs on one laptop can play both sides.

## Code map
- `src/lib/format.ts` — pure display rules: plain state labels, money (`tUSDT`), countdowns, sort/filter,
  `frozen()`, `rgbTrail()` (the RGB steps from the agent's log). Unit-tested.
- `src/lib/stream.ts` — WebSocket reducer; `list` drops jobs the agent no longer has. Unit-tested.
- `src/lib/hooks.tsx` — `MarketProvider` (one WebSocket + `GET /escrows` every 15 s + `/config`),
  `usePoll`, `useAction`, `useAssistResult`, `useOwnWallet`.
- `src/lib/session.ts` — tokens in localStorage. A freelancer job is "mine" only while its freelancer
  acceptance is the one this browser made (`saveTake`/`isMyJob`): after a reopen the old token is stale.
- `src/lib/api.ts`, `assist.ts`, `http.ts` — typed clients; every call has a timeout.

## Rules
- Never show anyone's balance but this laptop's own (`useOwnWallet(role)` → own party server).
- Tokens go only to the agent, in a body or the `x-escrow-token` header, never in a URL.
- Before release the client sees image previews only; downloads unlock at `RELEASED`.
- Money is bigint/base units; `money()` formats for display only.

## Learned the hard way
- The agent's code-written titles say `TUSDT` (rgb-lib needs upper-case tickers): `displayText()`
  rewrites it for people. Don't change the titles in the agent.
- Headless screenshots for checking the UI from Windows:
  `msedge --headless=new --window-size=1440,1600 --virtual-time-budget=6000 --screenshot=C:/…/x.png http://localhost:5174/service`.
  Use forward slashes in `--screenshot` from Git Bash (backslash + `$var` got mangled).
