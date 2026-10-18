# Demo script (target: 4 minutes + Q&A)

## Stage setup
- Left laptop: **Client** view (`/client`). Right laptop: **Freelancer** view (`/freelancer`).
- Projector: **Agent** view (`/agent`) — big decision log, escrow state timeline, agent wallet balance.
- Balances visible on all three screens. Wallet badge: "Self-custodial · Tether WDK · RGB on Bitcoin".
- AI badge on the agent screen: "QVAC · <model name> · running locally".
- Before going on stage: `npm run demo:reset` (fresh wallets, client holds 100 tUSDT), model warm.

## Script

**0:00 — Problem (20 s).** "Freelancers get paid late or not at all; clients pay for work that doesn't
work. Escrow services are slow, custodial and take a cut. We built an escrow agent that runs on your
own machine, pays in USDT on Bitcoin, and checks the work itself."

**0:20 — Agreement in plain language (40 s).** Client types:
> "Build a JavaScript function `slugify` that lowercases text, replaces spaces with dashes and strips
> anything that isn't a letter, number or dash. The included tests must pass. Also include a README.
> Pay 50 USDT. Deadline: 30 minutes."

QVAC turns it into checks on screen: *Tests pass (`npm test`)*, *`README.md` present*. The log
explains in one sentence what each check means.

**1:00 — Both sides agree (20 s).** Client and freelancer each click Accept on their own laptops.
Log: "Both parties agreed to the same terms (hash a3f9…)". Point at "terms a3f9… · checked here ✓":
each browser recomputes the hash from the terms on its own screen, and won't accept if they differ.

**1:20 — Lock the money (30 s).** Client clicks "Lock 50 USDT". Client balance drops to 50, agent
shows 50 in escrow. Log explains: funds are held by the agent's own wallet on Bitcoin via RGB and
can only go to the freelancer or back to the client.

**1:50 — First delivery fails (40 s).** Freelancer uploads `slugify-v1.zip`. Verifier runs the tests:
1 failing. Decision: **no payment**. QVAC explains which test failed and why, in plain words.

**2:30 — Second delivery passes (40 s).** Freelancer uploads `slugify-v2.zip`. All checks pass.
Decision: **release**. Agent wallet pays the freelancer's invoice; freelancer balance goes to 50.

**3:10 — How it works (40 s).** One slide: QVAC (local AI) → conditions → humans approve →
deterministic verifier decides → WDK RGB wallet pays. "The AI never touches the money. It translates
and explains; the code decides; Bitcoin settles."

**3:50 — Close (10 s).** "Agreements in plain language, payments in USDT on Bitcoin, nothing leaves
your machine."

## Optional segment: client review (only if built and rehearsed)

Not part of the 4 minutes. Use it in Q&A when a judge asks about work a machine can't check, with a
second escrow already funded (`REVIEW_WINDOW_SEC` ≈ 120) so nobody waits on the chain.
On `/client` use **Paste review demo** for the agreement text; deliver `fixtures/dist/landing-v1.zip`
then `landing-v2.zip`. Approve and Dispute only work in the browser that created the agreement (it holds
the `clientToken`); the dispute form has one-click "Not met: …" reasons, so no typing on stage.

1. Agreement (already accepted and funded):
   > "Build a one-page landing site for my bakery as index.html. Also include a README. The page should
   > look clean and use warm colours. Pay 30 USDT. Deadline: 30 minutes."

   Terms on screen: *`index.html` present*, *`README.md` present* (automatic) and *You decide: the page
   looks clean and uses warm colours* (client review).
2. Freelancer uploads `landing-v1`. Automatic checks pass → state **Awaiting approval**.
3. Client screen shows the page and QVAC's report: "looks unmet: the header is dark blue, not a warm
   colour". Client clicks **Dispute**, reason "header should be warm". Back to funded.
4. Freelancer uploads `landing-v2`. Report: "looks met". Client clicks **Approve** → release.

Line to say: "The AI reads the work and gives the client an opinion. The client decides, and if they
don't answer in time, the freelancer gets paid. The AI still never touches the money."

## Rehearsal checklist (WS4)

Screens (any laptop can point at another over the LAN with query params; they stick for the tab):
- Client: `http://<web-host>:5173/client?agent=http://<agent-ip>:4000&party=http://localhost:4101`
- Freelancer: `http://<web-host>:5173/freelancer?agent=http://<agent-ip>:4000&party=http://localhost:4102`
- Projector: `http://<web-host>:5173/agent?agent=http://localhost:4000&client=http://<client-ip>:4101&freelancer=http://<freelancer-ip>:4102`

Before each run:
1. `npm run fixtures:zip` once per laptop that uploads; the files are in `fixtures/dist/`.
2. `npm run demo:reset` (or, in mock mode, delete `MOCK_LEDGER_PATH` and the agent data dir), restart the agent.
3. Header dots on every screen are green: Agent, Live, AI (and Wallet on the two party screens). A red
   dot names the process that is down; fix it before going on stage.
4. Projector footer shows `QVAC <model> · on-device` (not just `QVAC · on-device`, which means the AI
   service isn't reporting a model yet).
5. Client wallet shows 100 tUSDT, freelancer 0, "Held in escrow" 0.
6. Browser zoom: projector at 100–125 % so the decision log fills the centre column; party laptops at 100 %.
7. Client review segment only: create its agreement **in the client browser used on stage** (it keeps
   the approval key); a different browser gets "doesn't have the approval key".

During the run, check on the projector: v1 failure shows the failing test name in the explanation;
"Held in escrow" goes 0 → 50 → 0. Party balances are private to each laptop (the projector shows "private"
for the other laptops); check client 100 → 50 and freelancer 0 → 50 on their own screens.

Fallback without any service: `?fixture=1` on any screen renders a recorded mid-demo state (slugify
after v1 failed; `&escrow=esc_b4k3` for the client review).

## Likely judge questions — prepared answers
- *Isn't the agent a custodian?* Yes, during the escrow. It's transparent and local; the trust-minimized
  version uses RGB Lightning hold invoices (our next step).
- *What if the AI misreads the agreement?* Both parties must approve the exact conditions (hash) before
  any money moves; a failed AI parse falls back to a template.
- *Running the freelancer's code is dangerous.* Timeout, temp directory, no network; production would
  use a container sandbox.
- *Why RGB?* Native USDT on Bitcoin, private (client-side validation), no smart-contract platform needed.
- *What about things a machine can't check, like design?* They become client-review items in the agreed
  terms. QVAC reviews the delivery and the client approves or disputes; the decision function only sees
  the client's answer, never the AI's opinion.
- *Can't the freelancer trick the AI review?* They can try (prompt injection), which is why the review is
  advice only. The worst case is a misleading opinion; the client still looks at the work and decides.
- *What if the client never answers, or disputes forever?* No answer within the review window releases
  the payment. Endless disputes until the deadline are a known limit; real platforms solve that with
  human arbitration.

## Backup plan
If anything breaks live: switch to the recorded run (`demo-backup.mp4` on every laptop's desktop) and
narrate over it. Decide this in under 10 seconds; do not debug on stage.
