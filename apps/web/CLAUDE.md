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
   The `POST /escrows` response carries a one-time `clientToken`: keep it in memory and in
   `localStorage` keyed by escrow id (wrap storage in try/catch). It is needed to approve or dispute.
2. Proposed terms: AI summary, list of conditions as cards ("✓ Tests pass — `npm test`"), clarifications
   as yellow notes, termsHash short form, **Accept** button (calls party `/wallet/sign` if available,
   then agent `/accept`). `client_review` conditions get a visibly different card ("You decide: The logo
   uses warm colours") so both sides see which checks are automatic and which are the client's call.
3. Funding: "Lock 50 USDT" → party `/wallet/invoice` (refund invoice) → agent `/refund-invoice` →
   party `/wallet/pay` with the agent's funding invoice → agent `/funded` hint. Show pending → settled.
4. Status: timeline of states, deliveries with per-condition results, final outcome.
5. Review (state `AWAITING_APPROVAL`):
   - the delivered files from `GET /escrows/:id/deliveries/:n/files`, opened in an
     `<iframe sandbox>` (no `allow-same-origin`) or as plain text;
   - QVAC's report (`delivery.review`), labelled **"AI opinion — you make the call"**, one opinion chip
     per item (looks met / looks unmet / unsure); "template" badge when `source: 'template'`;
   - **Approve** and **Dispute** (dispute needs a reason) → agent `/approve` with the stored `clientToken`;
   - countdown to `reviewDueAt`: "Approves automatically in 1:42".
   If the token is missing (other browser, cleared storage), show a clear message instead of the buttons.

**Freelancer**
1. Open escrows list → escrow detail with the same terms view and **Accept**.
2. When `FUNDED`: upload deliverable (drag-and-drop) → before upload, get a fresh payout invoice from
   party `/wallet/invoice` and send both to agent `/deliveries`.
3. Results per condition (pass/fail, stdout tail collapsible), payout status.
4. In `AWAITING_APPROVAL`: "Waiting for the client's review" + the same countdown. After a dispute, show
   the client's reason next to the upload box so the next delivery can fix it.

**Agent (projector)**
- Left: escrow header (title, amount, state chip, deadline countdown) + state timeline. Give
  `AWAITING_APPROVAL` its own chip colour and show the review countdown while in it.
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
7. Client review (branch `New_Rules`, after the contract change lands): `client_review` cards, client
   review screen, freelancer waiting state, projector chip; add an `AWAITING_APPROVAL` escrow with a
   review to `src/fixtures/snapshot.ts`; prepare the `landing` fixture deliverable (`fixtures/README.md`).
   Done: `components/Review.tsx` (files viewer, AI opinion, Approve/Dispute), `lib/clientToken.ts`; fixture
   `?fixture=1&escrow=esc_b4k3`. Tested end to end against the real agent (dispute → v2 → approve, and expiry).

## Running it
- `npm run dev:web` → http://localhost:5173/{client,freelancer,agent} (listens on 0.0.0.0 for the LAN).
- `?fixture=1` renders every view from `src/fixtures/snapshot.ts` with no agent running (`?fixture=0` turns
  it off). Query overrides (`agent`, `party`, `client`, `freelancer`, `fixture`) are remembered per tab in
  sessionStorage. `/agent` shows both parties' balances from `CLIENT_PARTY_URL` / `FREELANCER_PARTY_URL`
  (exposed via `envPrefix`) or `?client=` / `?freelancer=`.
- VITE_* vars are read from the **repo-root** `.env` / `.env.local` (`envDir: '../..'`).
- `@escrow/shared` is a normal workspace dependency (TS sources, hence `allowImportingTsExtensions`). Paths
  come from `AGENT_ROUTES` / `PARTY_ROUTES`. Before Accept, the UI recomputes `termsHash` from the terms on
  screen (`lib/terms.ts`) and refuses to accept on a mismatch.
- Client, in "Terms proposed": **Edit agreement** re-sends the text to `/reparse` (agent goes back to DRAFT,
  acceptances cleared). With zero conditions the Accept button is replaced by "QVAC found nothing to check"
  and the edit box opens by itself (the agent refuses to accept empty terms).
- Party screens show the agent's latest `error` as a red banner while the escrow is stuck on that step
  (`currentProblem()` in `lib/escrowStore.ts`: logged in the current state, nothing changed since).
- Projector badge: `QVAC <model> · on-device` from the agent's `/health` `aiModel`; `QVAC · mock mode`
  when the AI runs with `AI_MODE=mock`.

## Learned the hard way
- Emoji don't render in every environment (headless Linux shows empty boxes). Actor icons are inline SVG.
- A smooth `scrollTo` fires `scroll` events mid-animation; the decision log only unpins auto-scroll when
  the viewer scrolls *up*, and follows content growth with a ResizeObserver (covers streamed tokens).
- `pgrep -f`/`pkill -f` with a pattern also matches your own shell's command line and kills it. Kill by PID.
- `Waiting` (and any `flex` row) turns every text node into its own flex item; wrap mixed text + elements in
  one `<span>` or they wrap as separate columns.
- A CSS grid `1fr` column never shrinks below its content: the verifier's long stdout lines pushed the
  wallet card off-screen. Use `minmax(0,1fr)` for content columns.
- `vite` uses `strictPort`: if 5173 is "in use", an old dev server is still running (`pgrep -af vite`).

## Done when
A non-technical person can follow the whole story on the projector without anyone explaining it.
With client review: it is obvious on every screen that the AI's review is an opinion and the client
decides.
