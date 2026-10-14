---
description: Stand-up checkpoint — status of this workstream against the plan
---

Produce a stand-up status for the workstream of the current folder (or $ARGUMENTS if given).

1. Read `docs/WORKSTREAMS.md` and this workstream's `CLAUDE.md` task list.
2. Check the code: which tasks are done, partly done, not started. Base this on files and tests, not guesses.
3. Run `npm run typecheck` and this workstream's tests; report pass/fail counts.
4. Check `git log --oneline -15` and `git status` for uncommitted work.
5. Output, in under 15 lines:
   - Done since last checkpoint
   - Working now
   - Blocked on / needs from other workstreams (be specific: route, type, mock)
   - Risk to the demo, if any
   - Next 2 hours
6. If anything in "Learned the hard way" should be recorded, add it to the workstream's `CLAUDE.md`.
