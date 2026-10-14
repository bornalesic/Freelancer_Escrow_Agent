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
> anything that isn't a letter, number or dash. The included tests must pass. Pay 50 USDT. Deadline:
> 30 minutes."

QVAC turns it into checks on screen: *Tests pass (`npm test`)*, *`README.md` present*. The log
explains in one sentence what each check means.

**1:00 — Both sides agree (20 s).** Client and freelancer each click Accept on their own laptops.
Log: "Both parties agreed to the same terms (hash a3f9…)".

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

## Likely judge questions — prepared answers
- *Isn't the agent a custodian?* Yes, during the escrow. It's transparent and local; the trust-minimized
  version uses RGB Lightning hold invoices (our next step).
- *What if the AI misreads the agreement?* Both parties must approve the exact conditions (hash) before
  any money moves; a failed AI parse falls back to a template.
- *Running the freelancer's code is dangerous.* Timeout, temp directory, no network; production would
  use a container sandbox.
- *Why RGB?* Native USDT on Bitcoin, private (client-side validation), no smart-contract platform needed.

## Backup plan
If anything breaks live: switch to the recorded run (`demo-backup.mp4` on every laptop's desktop) and
narrate over it. Decide this in under 10 seconds; do not debug on stage.
