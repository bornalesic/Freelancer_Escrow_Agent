# Demo fixtures (test data, owned by WS4)

`demo-deliverable/` holds the freelancer's "work" used in the demo. It is test data for the product,
not part of the product.

## `slugify` job

Agreement text the client types (keep it identical every rehearsal):

> Build a JavaScript function `slugify` that lowercases text, replaces spaces with dashes and strips
> anything that isn't a letter, number or dash. The included tests must pass. Also include a README.
> Pay 50 USDT. Deadline: 30 minutes.

Two versions, committed as plain source folders (no .zip files in the repo — organizer rule):

| Folder | Contents | Expected verifier result |
| ------ | -------- | ------------------------ |
| `demo-deliverable/slugify-v1/` | `package.json` (`"test": "node --test --test-reporter=spec"`), `slugify.js` that forgets to strip punctuation, `slugify.test.js` (4 tests), `README.md` | tests fail (1 of 4), README present |
| `demo-deliverable/slugify-v2/` | same, with the bug fixed | all pass |

`npm run fixtures:zip` zips each folder's contents into `fixtures/dist/` (git-ignored) with zero
dependencies (`fixtures/zip.mjs`, `node:zlib`), so it works in both WSL and PowerShell. Output is
byte-identical every run (fixed timestamps, sorted entries), so a zip's sha256 never changes between
rehearsals and can be used in a `file_hash` condition.

The spec reporter matters: without a TTY, `node --test` prints TAP with long stack traces, which would
push the failing test out of the verifier's 40-line `stdoutTail`. With `spec`, the tail ends with
"failing tests" plus actual vs expected (`'hello,-world!'` vs `'hello-world'`).

Rules: **zero dependencies** (only `node:test` / `node:assert`), so `npm test` runs offline in under
2 seconds without `npm install`. Make the failing test's name self-explanatory
(e.g. `strips punctuation: "Hello, World!" → "hello-world"`) because the AI explanation quotes it.

Also add `agreements.json`: 8–10 example agreement texts with the conditions we expect, used by WS2's
eval script (`npm run eval -w apps/ai`). Include 2 vague ones ("make it look nice") that should produce
`clarifications` instead of conditions.
