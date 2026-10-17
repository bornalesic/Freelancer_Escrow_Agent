# apps/web — UI (WS4)

React + Vite + TypeScript + Tailwind. One app, three routes, each shown on a different screen in the
demo. It must look like a polished web app to the audience; everything runs locally.

## Routes
- `/client` — on the client's laptop. Talks to agent (`VITE_AGENT_URL`) and own party server
  (`VITE_PARTY_URL`, :4101).
- `/freelancer` — on the freelancer's laptop. Agent + own party server (:4102).
- `/agent` — on the projector. Agent only. Read-only.
URLs come from `VITE_*` env vars (see `.env.example`) and can be overridden with query params
(`?agent=http://192.168.1.20:4000&party=http://localhost:4101`) so we can re-point screens on stage
without rebuilding.

## Screens
**Client**
1. New agreement: title, plain-language textarea, amount (display units), deadline (minutes from now).
2. Proposed terms: AI summary, list of conditions as cards ("✓ Tests pass — `npm test`"), clarifications
   as yellow notes, termsHash short form, **Accept** button (calls party `/wallet/sign` if available,
   then agent `/accept`).
3. Funding: "Lock 50 USDT" → party `/wallet/invoice` (refund invoice) → agent `/refund-invoice` →
   party `/wallet/pay` with the agent's funding invoice → agent `/funded` hint. Show pending → settled.
4. Status: timeline of states, deliveries with per-condition results, final outcome.

**Freelancer**
1. Open escrows list → escrow detail with the same terms view and **Accept**.
2. When `FUNDED`: upload deliverable (drag-and-drop) → before upload, get a fresh payout invoice from
   party `/wallet/invoice` and send both to agent `/deliveries`.
3. Results per condition (pass/fail, stdout tail collapsible), payout status.

**Agent (projector)**
- Left: escrow header (title, amount, state chip, deadline countdown) + state timeline.
- Center: **decision log** — big, high-contrast, newest at the bottom, auto-scroll; each event shows
  actor icon, time, deterministic title, and the AI explanation streaming in (typewriter effect,
  "QVAC · local" badge; "template" badge when `source: 'template'`).
- Right: agent wallet balance ("held in escrow"), plus small client/freelancer balances if reachable.
- Footer badges: "RGB on Bitcoin · regtest", "Tether WDK wallet", "QVAC <model> · on-device".

**All views:** wallet card (balance, network, "Self-custodial · Tether WDK"), connection status dots
for agent / party / AI (from `/health`), and a clear error banner instead of blank screens.

## State management
- One WebSocket connection to the agent per view (`/ws?escrowId=`), reconnect with backoff.
  `snapshot` replaces state; `escrow`/`event`/`explanation_*` patch it. Render only from this state.
- Party wallet data via polling `GET /wallet` every 3 s (pause when tab hidden).
- Amount display via `formatAmount` from `@escrow/shared` with `precision` from agent `/config`.

## Tasks, in order
1. Scaffold + routes + layout + connection dots (H1–H2).
2. `npm run dev:mock` workflow: build every screen against the mock agent/party (WS3/WS1 provide mocks
   by H3–H4; until then use a local fixture `snapshot`).
3. Decision log with streaming explanations — this is the money shot; make it beautiful and readable
   from the back of the room (min 20 px text on `/agent`).
4. Upload + funding flows.
5. Polish: animate balance changes, state chip colours, empty states, keyboard-free demo (no typing
   needed except the agreement — keep a "Paste demo agreement" button).
6. Prepare `fixtures/demo-deliverable` zips and own `docs/DEMO_SCRIPT.md` rehearsals.

## Running it
- `npm run dev:web` → http://localhost:5173/{client,freelancer,agent} (listens on 0.0.0.0 for the LAN).
- `?fixture=1` renders every view from `src/fixtures/snapshot.ts` with no agent running (`?fixture=0` turns
  it off). Query overrides (`agent`, `party`, `client`, `freelancer`, `fixture`) are remembered per tab in
  sessionStorage. `/agent` shows both parties' balances from `CLIENT_PARTY_URL` / `FREELANCER_PARTY_URL`
  (exposed via `envPrefix`) or `?client=` / `?freelancer=`.
- VITE_* vars are read from the **repo-root** `.env` / `.env.local` (`envDir: '../..'`).
- `@escrow/shared` resolves to `src/shared-shim.ts` until `packages/shared/src/index.ts` exists, then to the
  real package automatically (alias in `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`). Delete the
  shim and the aliases once shared is on main.

## Learned the hard way
- Emoji don't render in every environment (headless Linux shows empty boxes). Actor icons are inline SVG.
- A smooth `scrollTo` fires `scroll` events mid-animation; the decision log only unpins auto-scroll when
  the viewer scrolls *up*, and follows content growth with a ResizeObserver (covers streamed tokens).
- `vite` uses `strictPort`: if 5173 is "in use", an old dev server is still running (`pgrep -af vite`).

## Done when
A non-technical person can follow the whole story on the projector without anyone explaining it.
