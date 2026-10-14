# Demo fixtures (test data, owned by WS4)

`demo-deliverable/` holds the freelancer's "work" used in the demo. It is test data for the product,
not part of the product.

## `slugify` job

Agreement text the client types (keep it identical every rehearsal):

> Build a JavaScript function `slugify` that lowercases text, replaces spaces with dashes and strips
> anything that isn't a letter, number or dash. The included tests must pass. Also include a README.
> Pay 50 USDT. Deadline: 30 minutes.

Two versions, each zipped with the project at the zip root (not inside a subfolder):

| File | Contents | Expected verifier result |
| ---- | -------- | ------------------------ |
| `slugify-v1.zip` | `package.json` (`"test": "node --test"`), `slugify.js` that forgets to strip punctuation, `slugify.test.js` (4 tests), `README.md` | tests fail (1 of 4), README present |
| `slugify-v2.zip` | same, with the bug fixed | all pass |

Rules: **zero dependencies** (only `node:test` / `node:assert`), so `npm test` runs offline in under
2 seconds without `npm install`. Make the failing test's name self-explanatory
(e.g. `strips punctuation: "Hello, World!" → "hello-world"`) because the AI explanation quotes it.

Also add `agreements.json`: 8–10 example agreement texts with the conditions we expect, used by WS2's
eval script (`npm run eval -w apps/ai`). Include 2 vague ones ("make it look nice") that should produce
`clarifications` instead of conditions.
