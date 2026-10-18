# Change request: marketplace UI on top of the existing escrow engine

## Context
We already have an escrow engine:
- QVAC (apps/ai /parse) turns a plain-English job into machine-checkable conditions plus a summary.
- The agent hashes the terms (termsHash) and issues a clientToken. Both parties accept the same termsHash.
- The agent's WDK wallet creates an RGB invoice, and the escrow is funded in tUSDT.
- A deterministic verifier runs tests_pass / file_hash / file_present and records evidence.
- The pure decide() function picks the outcome.
- Every state change emits a LogEvent, which QVAC explains in plain English and streams to the UI over WebSocket.

Keep that engine. The goal is to turn it into a two-sided marketplace app (desktop or web) with a simple UI, plus the rule changes below. This is mostly UI work, but some backend changes are needed.

## Hard rules (do not break)
- The AI never moves money. decide() stays pure. It reads only the verifier results, the client's answer, the escrow state and the clock. It never reads the AI review.
- Any change to price, deadline, requirements, team members or payout split creates a new termsHash. Earlier acceptances then no longer count.
- The fail → resubmit → pass loop must keep working. It is the core of the demo.
- The 5-second ticker still handles deadlines and expired review windows.

## Engine principles (apply these to every new feature, not just existing code)
- No undefined states. Every state, including new ones (OPEN listings, pending counteroffers, team proposals, SPLIT), must have a defined exit, including a timeout, so money can never get stuck. For example:
  - An OPEN listing nobody accepts before its deadline → CANCELLED.
  - An unanswered counteroffer or team proposal → expires.
  - A failed automatic payment in AWAITING_FUNDS → back to OPEN.
- Checking is mechanical, not an AI judgment.
  - "Requirements met" means only that the deterministic verifier's checks passed.
  - No LLM decides whether work is acceptable.
  - Nothing inside a deliverable (text, comments, file names) can influence the outcome.
  - QVAC's review is advice shown to the client, nothing more.
- Same inputs, same outcome. decide() must be reproducible and unit-tested for every path, so we can always show why money moved.
- Agreement is tied to exact terms.
  - Acceptances are stored against a termsHash.
  - The UI always shows the exact version being accepted.
  - Editing anything invalidates earlier acceptances.
- Time is enforced by the system, not by people. Every waiting state has a deadline or window handled by the ticker, so neither side can stall the other.
- Settlement never depends on later cooperation.
  - The client's refund invoice is attached at funding.
  - Each freelancer's payout invoice (every team member's) is attached at delivery.
  - The agent can therefore always pay out or refund without asking anyone.
- Everything is logged. Every transition emits a LogEvent with the evidence behind it, including SPLIT outcomes and team payouts.

## Parties
1. Client: posts jobs and pays.
2. Freelancer: browses jobs, accepts, delivers and gets paid.
3. Agent / escrow service: a backend service, not a user role. It holds and releases escrowed funds.
4. AI (QVAC): turns job descriptions into requirements and writes plain-English explanations and advisory reports. It is advisory only.

## Roles and visibility
- When opening the app, the user chooses whether to enter as a Client or a Freelancer. For now this is just a role choice, with no real sign-up or authentication.
- Each user has their own in-app WDK wallet.
- The only financial information a user sees is their own balance, shown in the header. They never see anyone else's balance.
- The agent can see only the funds frozen in escrow for each job. It must never read or query client or freelancer wallet balances. Enforce this in code and in the API, not just in the UI.
- Hide all crypto plumbing from users: no RGB invoices, termsHash or clientToken in the UI.
  - The app generates the client's refund invoice and the freelancer's payout invoice automatically from their in-app wallets.
  - The clientToken is kept in the client's session.

## The flow
1. Create listing (Client).
   - Form fields: job description in plain English, reward amount (tUSDT), deadline.
   - Show the fee breakdown: reward + 2% service fee = total to be escrowed.
   - Check that the client's balance covers the total.
2. Requirements (AI).
   - QVAC turns the description into requirements (automatic conditions and client_review conditions) plus a summary.
   - The client sees them on a review screen that clearly marks which requirements are checked automatically and which need client review.
   - The client can approve, edit the description and regenerate, or cancel.
3. Verifiability gate.
   - If QVAC cannot define at least one automatically checkable condition, the job is not eligible for autonomous escrow.
   - Explain why to the client and let them rewrite the description.
   - Optionally allow publishing it with a visible "Requires client review" badge, but never as a normal autonomous listing.
4. Publish.
   - Client approval counts as the client accepting the termsHash, and the agent then publishes the listing.
   - Add a listed/OPEN state, or derive it from PROPOSED + client accepted, whichever fits the existing code better.
   - By approving, the client pre-authorizes payment of reward + fee when a freelancer accepts.
5. Marketplace (Freelancer).
   - Freelancers see all open listings: description, requirements (with check type), deadline and reward.
   - Listings can be sorted and filtered by reward and deadline.
   - A freelancer can accept at the listed price. The first acceptance locks the listing.
6. Funding.
   - On acceptance (AGREED → AWAITING_FUNDS), reward + 2% fee are paid automatically from the client's wallet into escrow, with the client's refund invoice attached.
   - Once the transfer settles, the state becomes FUNDED.
   - The freelancer's job page clearly shows either "Funded – you can start" or "Waiting for funding".
   - Either party can cancel before funding (CANCELLED).
   - Keep automatic block mining on regtest.
7. Delivery (Freelancer).
   - The freelancer uploads the work, and the app attaches a fresh payout invoice automatically.
   - The verifier runs and records evidence.
   - The freelancer sees which checks passed or failed, with the evidence, so they can fix the work and resubmit.
8. Decide (existing logic, plus the dispute rule if it is built):
   - A check fails and the deadline hasn't passed: back to FUNDED, so the freelancer can resubmit.
   - All checks pass and there are no client_review conditions: release.
   - All checks pass and there are some client_review conditions: AWAITING_APPROVAL.
   - The deadline has passed and nothing passed: refund.
9. Client review (only when there are client_review conditions).
   - The client sees the QVAC advisory report, the verifier evidence and previews of the deliverables. They do not get the full files; full download is available only after release.
   - Approve: release.
   - Dispute before the deadline: the freelancer can revise and resubmit.
   - Dispute after the deadline: refund, or SPLIT if the dispute rule below is built.
   - No answer within REVIEW_WINDOW_SEC: release.
10. Settle.
   - Release: the reward goes to the freelancer and the service keeps the 2% fee.
   - Refund: reward + fee go back to the client.
   - Final states: RELEASED, REFUNDED, or SPLIT (only if the dispute rule is built).
11. Activity timeline.
   - Show the LogEvent stream, with QVAC's plain-English explanations, as a live timeline on each job page for both client and freelancer.

## Possible new features

### Counteroffers
- Instead of accepting, a freelancer can offer a lower price, optionally with a note.
- The client sees all counteroffers on the listing and can accept one.
- Accepting a counteroffer creates new terms: a new termsHash, with the fee recalculated on the new amount. Both sides accept, and the flow continues from step 6.
- All other counteroffers are declined, and those freelancers are notified.

### Teams
- One freelancer can start a team proposal on a listing and invite other freelancers.
- On a team setup screen, the team agrees on:
  - how to split the reward (percentages summing to 100%);
  - which requirements each member covers.
- Team members, the split and the assignments are part of the terms and the termsHash. The client and every team member must accept the same termsHash.
- Verification and payout stay all-or-nothing for the whole job. On release, each member is paid their share to their own payout invoice.
- Per-requirement partial payouts are out of scope for now.

### Dispute rule (90/10)
This rule applies when all automatic checks passed but the client disputes.
- Dispute before the deadline: the freelancer can revise and resubmit, as now.
- Dispute after the deadline, or the deadline passes after a dispute with no accepted resubmission: settle as SPLIT, a new terminal state.
  - 10% of the reward goes to the freelancer.
  - 90% of the reward plus the 2% fee goes back to the client.
  - The client does NOT get the full deliverables.
- Make the 10% a config constant.
- decide() must make this decision from the client's answer, the verifier results, the state and the clock, never from the AI review.
- Explain this rule in three places: a public "How payments work" page, the listing creation screen, and the dispute confirmation dialog.

## UI summary
- Role choice: Client or Freelancer (just the choice for now).
- Header: the user's own balance only.
- Client screens:
  - New listing
  - Requirements review
  - My listings, with status badges
  - Job page: timeline, deliverable previews, AI report, Approve / Dispute; plus counteroffers and team proposals if built
- Freelancer screens:
  - Marketplace
  - Listing detail: Accept; plus Counteroffer and Form team if built
  - My jobs: upload, check results, resubmit, payout status
- Map internal states to plain labels: Draft, Reviewing requirements, Open, Funding, In progress, Checking work, Waiting for client, Paid, Refunded, Split, Cancelled.

## How to approach this
1. Read the existing code first: the agent, apps/ai, the verifier, decide(), the state machine and the WebSocket stream.
2. Give me a short plan before implementing, and wait for my OK. The plan should cover:
   - backend changes;
   - new states, fields and endpoints;
   - which screens you will build.
3. Implement in this order:
   1. role choice and balances;
   2. listing/marketplace flow on the existing engine.
4. For the possible new features (counteroffers, 90/10 dispute rule, teams):
   - assess each one: how it fits the engine, and the effort;
   - recommend which are worth building;
   - build them only after I confirm, in that order.
5. Add or update tests for decide() covering every outcome, including SPLIT and team payouts if those are built.
6. List any open questions instead of guessing.