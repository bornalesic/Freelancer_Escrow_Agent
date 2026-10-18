# User interfaces (as built)

Two web apps sit on the same escrow agent. **`apps/market`** is the marketplace used in the demo; **`apps/web`**
is the first UI, with one screen per role and a large decision log for the projector. Both are React + Vite +
TypeScript + Tailwind, take every type and route from `@escrow/shared`, and render only from the agent's
WebSocket feed plus polling of the user's own wallet. Architecture: [`TECHNICAL.md`](TECHNICAL.md).

## Principles both UIs follow
- **The AI is visibly advice.** QVAC's text always carries a badge ("QVAC · local", or "template" when the
  model was not used). Its review is headed "AI opinion — you make the call" (web) or shown as an advisory
  report (market), next to the work itself.
- **Plain language, no plumbing.** Users see "Open", "In progress", "Paid", never RGB invoices, `termsHash`
  values or tokens. The RGB details are one click away for those who want them (market: "Under the hood").
- **Only your own money.** The header balance comes from the party server on the same laptop. Nobody else's
  balance is shown, and the service screen shows only what it holds in escrow.
- **Nothing blank, nothing hanging.** Every call has a timeout; a down service shows a named error, not an
  empty page. Connection status is always visible.
- **Money is bigint.** Amounts stay in base units; formatting happens only for display.

## `apps/market` (port 5174)

Run with `npm run dev:market` next to `npm run dev:parties` on the same laptop (or `npm run dev:mock` for
everything). Open it as **http://localhost:5174**: the party servers answer balance and payment requests
only from a page served by `localhost`. Addresses come from `VITE_AGENT_URL`, `VITE_CLIENT_PARTY_URL` and
`VITE_FREELANCER_PARTY_URL`, and can be overridden per tab with `?agent=`, `?client=`, `?freelancer=`.

The role lives in the URL, so two tabs on one laptop can play both sides. The header shows the role switch,
"My balance" for that role, and whether the escrow service is connected.

### Screens

| Path | Who | What it shows |
| ---- | --- | ------------- |
| `/` | anyone | Role choice: Client or Freelancer ("Last used on this laptop" is remembered), plus a link to the service screen |
| `/client` | client | **My listings**, grouped by what needs attention ("Review the requirements", "Review the offers", "Review the work"), in progress, finished |
| `/client/new` | client | **New listing**: description, reward, deadline; fee breakdown (reward + 2 % fee = total escrowed); balance check against the client's own wallet; QVAC price/deadline check. "Nothing is paid yet. Nobody sees the listing until you approve its requirements." |
| `/client/jobs/:id` | client | **Job page.** While QVAC reads the description: a waiting card. Then **Requirements proposed by QVAC**, each marked as checked automatically or "Client reviews", with **Make more of it checkable automatically** (QVAC's measurable rewrites, one click **Use this** to regenerate); **Approve and publish** (checks the balance covers reward + fee, then pre-authorises auto-pay) or edit and regenerate. Once listed: offers, payment status ("Payment pre-authorised…", "Your wallet is sending the payment…", "Payment complete"), delivered versions with check results and evidence, QVAC's advisory review, image previews, **Approve / Dispute**, downloads after release, and the live timeline |
| `/freelancer` | freelancer | **Marketplace**: every `OPEN` listing with reward, deadline and requirement types; sort by reward or deadline, filter by deadline. New listings appear live |
| `/freelancer/jobs/:id` | freelancer | **Listing**: the job, "How your work is accepted" (each requirement and how it is checked), what you get; **Ask about this job** (QVAC answers only from the terms, otherwise "The terms don't say"); **Take this job** (first freelancer wins) or offer a lower price. Once taken: "Waiting for the client's payment", then **Send your work** with a **Practice check** (runs the real checks without submitting, plus QVAC hints for failures); results per check with evidence; payout status |
| `/freelancer/mine` | freelancer | **My jobs** (send work, waiting for payment, finished) and **My offers** |
| `/how` | anyone | **How payments work**: the steps, the rules that always hold (the AI never moves money, nothing waits forever, payout never needs anyone's help later, any change means new terms, your balance is private, everything is logged) and what RGB is |
| `/service` | projector | **The escrow service's view**: held in escrow now (reward + fee per job), fees earned (2 % of every paid job), the service's own wallet, every job's live log with QVAC explanations, the "Under the hood: RGB on Bitcoin" panel open. Never a party's balance. "Demo: clear all jobs" calls `POST /dev/reset` |

### State labels
| Internal state | Shown as |
| -------------- | -------- |
| `DRAFT` | Draft |
| `PROPOSED` | Reviewing requirements |
| `OPEN` | Open |
| `AGREED`, `AWAITING_FUNDS` | Funding |
| `FUNDED` | In progress |
| `DELIVERED`, `VERIFYING` | Checking work |
| `AWAITING_APPROVAL` | Waiting for client |
| `RELEASING`, `RELEASED` | Paid |
| `REFUNDING`, `REFUNDED` | Refunded |
| `CANCELLED` | Cancelled |

### How it keeps state
- `lib/hooks.tsx` (`MarketProvider`): one WebSocket to the agent, `GET /escrows` every 15 s, `/config` once.
- `lib/stream.ts`: the reducer over WebSocket messages; jobs the agent no longer has are dropped.
- `lib/session.ts`: tokens per job in `localStorage`. A freelancer job counts as "mine" only while its
  acceptance is the one this browser made.
- `lib/format.ts`: display rules (labels, money, countdowns, sort/filter, the RGB trail from the log).
- Files are fetched with the token in the `x-escrow-token` header and shown as blob URLs.

## `apps/web` (port 5173)

Run with `npm run dev:web`. Three routes, one per screen in the original stage setup:

| Path | Screen | What it shows |
| ---- | ------ | ------------- |
| `/client` | client laptop | New agreement (with **Paste demo agreement** buttons and QVAC's clarifying questions), proposed terms with **Accept** (the browser recomputes `termsHash` and refuses on a mismatch) and **Edit agreement**, funding ("Lock 50 USDT": refund invoice, pay, confirm), deliveries with per-check results, client review |
| `/freelancer` | freelancer laptop | Job list, terms + **Accept**, ask about the job, upload with **Check without submitting**, results per check (output tail collapsible), payout status; after a dispute, the client's reason above the upload box |
| `/agent` | projector | Escrow header and state timeline (left), the **decision log** (centre: actor icon, time, title by code, QVAC explanation typing in, min. 20 px text, auto-scroll), money held in escrow from the agent's real wallet balance and both parties' balances (right), footer badges "RGB on Bitcoin · regtest", "Self-custodial · Tether WDK wallet", "QVAC <model> · on-device" |

**Client review screen** (`AWAITING_APPROVAL`): the delivered files in a list with a preview pane
(HTML/SVG in a fully sandboxed iframe, images, text files), QVAC's opinion per item (Looks met / Looks unmet /
Unsure), **Approve and pay** or **Dispute** (one-click "Not met: …" reasons), and "Approves automatically in
1:42". The `clientToken` is kept in `localStorage`; a browser without it gets a clear message instead of the
buttons.

**Other behaviour**
- One WebSocket per screen with reconnect backoff; wallet polling every 3 s, paused while the tab is hidden.
- A red banner on the party screens while the agent is stuck on a step (e.g. a failed payout), with QVAC's
  explanation.
- AI assist features (verifiability badge, "Make it checkable", interview, price check, dry run, `examples`
  cards with "Download acceptance test", Q&A, job matching, team split) hide themselves when the agent or AI
  does not offer them.
- `?agent=`, `?party=`, `?client=`, `?freelancer=` re-point a screen without rebuilding (remembered per tab).
- `?fixture=1` renders recorded states with no server at all: the slugify demo after v1 failed, and
  `&escrow=esc_b4k3` for a client review, `&escrow=esc_t1c4` for the assist features.

## Checking a UI change
- `npm run typecheck -w apps/market` (or `apps/web`) and `npm test -w apps/market`.
- Use the fixture mode (`apps/web`) or `npm run dev:mock` (both) to see every state without a chain or GPU.
- Notes and lessons learned per app: `apps/market/CLAUDE.md`, `apps/web/CLAUDE.md`.
