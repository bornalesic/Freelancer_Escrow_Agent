---
description: Propose and apply a change to the shared contracts (packages/shared + docs/CONTRACTS.md)
---

A contract change was requested: $ARGUMENTS

Follow these steps exactly:

1. Read `docs/CONTRACTS.md` and the relevant files in `packages/shared/src/`.
2. Classify the change:
   - **Additive** (new optional field, new event type, new route): allowed for any workstream.
   - **Breaking** (rename, remove, type change, required field, route change): must be merged by WS3.
3. Search the whole repo for every usage of the affected types/routes/events (`Grep`), and list which
   workstreams are affected.
4. Apply the change to `packages/shared` (types + zod schema together) **and** update
   `docs/CONTRACTS.md` in the same edit set. Keep both in sync.
5. Update every usage you found that is inside the current workstream. For usages in other workstreams,
   do not edit them; instead list them.
6. Run `npm run typecheck`.
7. Print a short message for the team chat:
   `CONTRACT CHANGE (<additive|breaking>): <one line>. Affects: <workstreams>. Action needed: <what each must do>.`
8. Commit with prefix `shared:` on its own (no other changes in the commit).
