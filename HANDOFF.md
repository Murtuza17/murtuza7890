# Handoff — read this first

Written 2026-09-05, late afternoon IST, by the outgoing Claude Code session
because it is running low on budget and a different tool is picking this up.
**The brief's deadline is Sunday 6 September 2026, 3:47 pm IST — tomorrow.**
Everything below is ordered so the next hour of work goes to what the deadline
actually needs, not to polish.

## The one-line status

The product is **complete, tested, committed, and pushed**. `git log` on
`claude/review-items-hyotki` (the repo's only branch — see below) ends at
commit `1ce6cdf`, CI is green on it, and locally: 182 unit tests, 77 DB/RLS/race
assertions against a real Postgres 16, and a 46-check browser e2e suite at
360px all pass. There is no unfinished must-build feature. What's left is
verification-under-time-pressure and two genuinely optional calls — not more
building.

**Do not re-architect anything in `src/domain/` under deadline pressure.** It
is the part that's graded most heavily (judging criterion #4, "deterministic
state management") and the part most recently gone over twice for bugs. If
something looks odd there, read the comment above it first — most of this
codebase's non-obvious lines have a comment explaining exactly why, usually
because an earlier, more "obvious" version was wrong in a specific traceable
way. `git log --oneline` tells that whole story if you want the detail.

---

## Do these, in this order

### 1. Confirm the live URL actually works (5 minutes, do this first)

`https://sidproject-zeta.vercel.app` is the submission URL. **This sandbox's
network egress is blocked, so the outgoing session could not load it and
verify the latest push actually deployed.** This is the single most important
unverified fact in this handoff — check it from a real browser before anything
else:

- Open the URL. Confirm it loads the sign-in screen (clinic code + PIN, PINs
  listed on-screen).
- Sign in as `BLNG` / `5678`. Confirm the Requests tab shows a suggestion
  card reading roughly *"Ask Jadcherla ... for 19 vials"* — this is the
  newest feature (the forecast/anticipate engine) and the easiest way to
  confirm the latest commit is what's actually live, not a stale build.
- If it's stale or broken: check the Vercel dashboard's deployment log for
  the repo. Because this repo's default branch **is**
  `claude/review-items-hyotki` (there is no `main`), a normal
  Vercel-GitHub-integration setup auto-deploys on every push to it, so a push
  minutes ago should already be live or building. If it isn't, the Vercel
  project's "Production Branch" setting may be wrong — check
  **Vercel → Project → Settings → Git**.
- If Supabase itself is cold/erroring: Settings → paused projects need a
  manual "Restore" click in the Supabase dashboard (free-tier projects pause
  after 7 days idle; this one is only hours old as of writing, so this is
  unlikely to bite before tomorrow, but check if anything acts dead).

### 2. Try the two things a judge will actually try (10 minutes)

Both are described with exact steps in `README.md` under "Two things worth
trying first." Do them for real, on the live URL:

- **The double-claim**: two browser windows/tabs, sign in as `BLNG` and
  `MDJL`, both claim the same antivenom batch. One must get 6-digit handoff
  codes; the other must be told *"Already committed to ... just now,"* not a
  generic error.
- **The offline queue**: sign in anywhere, "Demo controls" → "Cut the
  connection," record use of a batch, confirm it reads "Waiting to send"
  (never "Confirmed"), then "Go back online" and watch it drain to "Saved."

If either of these is broken on the *live* deploy despite passing locally,
that's an environment/config problem (stale env vars, a paused Supabase
project), not a code problem — the code path is covered by
`scripts/race-test.sh` and `e2e/smoke.mjs` and passes against a real Postgres.

### 3. Skim the submission checklist against `CLAUDE.md` §1 "What to submit"

- Public live URL — have it (pending step 1's confirmation).
- Public GitHub repo with source + commit history — have it
  (`github.com/manideep1799/sidproject`, this branch, ~30 commits, each
  scoped and described).
- One-page trade-off memo — `MEMO.md`, done, covers trust safeguards, offline
  reconciliation, and prioritized cuts exactly as asked.
- Nothing else is required. Stop here if time is genuinely tight — everything
  past this point is optional polish, not a missing deliverable.

### 4. Only if real time remains: build in this order, not any other

Nothing below blocks submission — stop after step 3 if time is tight. If
there genuinely is time left, this is ranked by payoff-per-hour and how much
each risks the tested core, not by how interesting it is:

1. **Wire the suggestion card's receiver half to an action.** `SuggestionCard`
   in `src/ui/Requests.tsx` already tells a clinic *"Ask Jadcherla for 19
   vials"* with full reasoning — but tapping it does nothing today; the
   worker still has to separately open "Ask for medicine" and retype the same
   drug/qty by hand. Wire a button straight to the **existing, already-tested
   `create_request` RPC** (`supabase/migrations/0002_functions.sql`),
   pre-filled from the suggestion's fields. Small, low-risk, reuses tested
   plumbing, and it's a direct hit on judging criterion #1 ("simplicity and
   speed of the... workflow").
2. **Then, only if #1 is done and verified: give the sender half the same
   treatment.** The same card's outgoing half says *"Post this as an offer"*
   — but **no RPC exists today that lets a user create an unsolicited
   `proposed` transfer.** Every `proposed` row in the app right now comes
   from `supabase/seed.sql`, none from a user action. This needs a new
   `propose_transfer` RPC (simple insert — not contested, so none of
   `accept_transfer`'s locking complexity applies), an RLS grant for it, a
   couple of SQL tests, then wiring the button. Bigger than #1, but still
   additive: once the row exists, the entire accept/dispatch/handoff state
   machine already handles it unchanged. Do not start this without also
   adding the SQL tests — an unlocked insert path into `transfers` is exactly
   the kind of surface `supabase/tests/rls_test.sql`'s hostile probes exist
   to cover, and a new RPC that isn't probed the same way is a real gap, not
   a shortcut.
3. **Telugu strings for the static UI — real, but bigger and riskier than
   1–2, do it last if at all.** The natural-language intake feature already
   *accepts* Telugu speech (`docs/ai-design.md`); every other screen is
   English-only. `MEMO.md` names this the #2 regret in its own words. There
   is no i18n scaffold in the codebase yet and copy is scattered across
   roughly 1,500 lines of `src/ui/*.tsx`, not centralized — this is genuine,
   multi-file work, not a quick win, and it touches every screen right
   before a deadline. Worth doing eventually; not the thing to reach for
   with only hours left.

**Do not build these, even though `MEMO.md`'s "cut with real regret" section
mentions them** — they read like unfinished business but are actually
contradicted by the brief, not just deferred:
- **Push notifications** — `CLAUDE.md` §9 lists this as explicitly out of
  scope, and the brief separately bans SMS/IVR outright.
- **Per-worker identity / role hierarchy** — the brief's constraints ask
  specifically for "lightweight clinic PIN identification," and §9 lists
  "role hierarchies beyond clinic-level access" as out of scope. The memo's
  regret about this is forward-looking commentary about what a real
  multi-district pilot would need, not a to-do for this submission.
- Anything else in the §9 list generally (maps/routing, photo uploads,
  admin analytics, temperature-sensor integration, inter-clinic payment).

---

## What "done" actually covers

Every must-build in `CLAUDE.md` §1 and every item in the §8 build order is
built, and the codebase now also does more than the brief strictly asked for
(see "Beyond the brief" below). In brief:

1. **Inventory logging** — batch, vial count, cold-chain status, expiry date.
   `src/ui/Inventory.tsx`.
2. **Urgent requests** by urgency + radius. `src/ui/Requests.tsx`.
3. **Automatic matching** — Haversine distance, tiered ranking (soonest
   expiry → nearest → largest qty), always shows *why* a match surfaced.
   `src/domain/matching.ts`.
4. **Dual-party transfer pass** — 6-digit codes issued at accept time, locked
   claim RPC, TTL sweep. `src/domain/transfer.ts` (pure reducer) +
   `supabase/migrations/0002_functions.sql` (the RPC).
5. **Offline draft mode** — IndexedDB outbox, idempotent server-side replay,
   honest "Waiting to send" states. `src/domain/outbox.ts`, `src/data/idb.ts`,
   `src/data/sync.ts`.

**Beyond the brief**, added because this is an OAKS AI Builders submission and
judging criterion #5 rewards "pragmatic product decisions," not just
compliance:

- **Deterministic forecast/anticipate engine** (`src/domain/forecast.ts`,
  `src/domain/anticipate.ts`) — infers each clinic's consumption rate from the
  ledger itself (no new input needed) and proactively proposes transfers by
  pairing one clinic's predicted waste against another's predicted stockout,
  with **no human trigger**. This directly answers the brief's own diagnosis
  of the problem ("staff cannot easily see... before batches expire") instead
  of just building the tool staff would have to remember to check. Fully
  on-device, deterministic, zero cost, works offline.
- **Natural-language intake** (`api/parse-request.ts`, `src/domain/intake.ts`,
  `src/data/intake.ts`) — one sentence in English or Telugu becomes a
  pre-filled draft request via a real Claude API call. This is the one place
  a model is used, and it's deliberately kept off the critical path: key held
  server-side only (never in the browser bundle), every field re-validated
  against the drug catalogue before it can touch the database, and the
  manual form works identically if the key is absent, rate-limited, or the
  request fails. `docs/ai-design.md` has the full reasoning, including a
  correction of an early mistake (initially over-read the brief's "no paid
  APIs" constraint as banning any model call at all — wrong; free tier is not
  paid, and the spec's own justification for using Supabase says so
  explicitly).

The single most important design decision in the whole codebase, underlying
everything else: **on-hand stock is never stored, only derived** —
`SUM(delta)` over an append-only ledger (`stock_movements`), never a
`qty = N` column that a sync could overwrite. `README.md`'s "The one decision
everything else follows from" section explains why in one paragraph; it's
worth reading before touching anything in `src/domain/ledger.ts`.

## Open decisions (optional, not blocking)

**1. LLM provider configurability.** Right now `api/parse-request.ts` calls
Anthropic directly (`claude-opus-5`) and this is fully tested and working.
Partway through this session the user asked about pointing the natural-language
intake feature at a different/free provider instead (GLM, Nemotron via NIM,
Groq — OpenAI-SDK-compatible endpoints) rather than Anthropic. This was never
decided or built — it was raised, and then the session moved on to fixing
test failures instead. If the user wants this: it would mean making the base
URL/model/key env-var-driven in `api/parse-request.ts` and switching the
Anthropic SDK call to a generic OpenAI-compatible client (or keeping the
Anthropic SDK and adding a second code path — worth asking the user which,
since it changes `docs/ai-design.md`'s "why Claude" framing). **Do not do
this unasked** — the feature works and is tested as-is; changing the provider
this close to the deadline risks the one thing in the codebase that touches
an external network call during a demo. If the user explicitly asks, treat it
as a small, isolated, well-tested change to one file, not a redesign.

**2. `ANTHROPIC_API_KEY` may not be set in Vercel.** The natural-language
intake feature is optional by design — the manual form works identically
without it (`api/parse-request.ts` returns `not_configured` and the client
shows a plain message). As of the last conversation with the user, they had
not yet added this key to Vercel. This is fine to submit without. If the user
wants the feature live: **Vercel → Settings → Environment Variables** → add
`ANTHROPIC_API_KEY` (get one at console.anthropic.com) → redeploy. It must
**never** be prefixed `VITE_` — that would ship it to the browser, which is
exactly what the current design prevents.

## Known limits, already decided and documented — do not "fix" these blind

`MEMO.md`'s "Known limits I would fix next" section names two real,
deliberate simplifications:

1. `qty_reserved` on `batches` is the one stored running total in an
   otherwise derived-everything schema — safe only because it's written in
   one place inside a row lock, and `reservedDrift()` + tests assert the
   invariant holds. A periodic reconciliation job would be more robust; not
   worth building under this deadline.
2. `batches.status` never ages past its expiry date automatically — harmless
   today because matching filters on the expiry *date*, not the status
   column, but two sources of truth for one fact will eventually disagree.

Both are intentional, already reasoned about in the memo, and explicitly
**not** on the critical path for tomorrow.

---

## Verifying locally, in one shot

No Supabase account or network needed for any of this:

```bash
npm install
npm test          # 182 unit tests, ~1s
npm run typecheck
npm run test:db    # spins up throwaway Postgres 16, applies real migrations + seed
npm run test:race  # + 5 clinics claiming the same 4 vials concurrently
npm run test:e2e   # + real headless Chromium at 360px against the real stack
```

`test:db`/`test:e2e` need real Postgres 16 binaries; set `PGBIN` if they
aren't at `/usr/lib/postgresql/16/bin`. Full detail, including what each
suite actually asserts, is in `README.md`'s "Testing" section.

**Gotcha if you poke at the test database directly with `psql`:**
`scripts/test-db.sh` always runs `supabase/tests/rpc_test.sql` after seeding,
and that suite *completes real transfers* as part of testing the RPCs (e.g.
it moves 12 vials from Jadcherla to Balanagar to test the dual-code handoff).
So a database you inspect right after `test-db.sh` finishes is in a
**post-test-mutated** state, not the pristine demo state — this cost the
outgoing session a real detour chasing a "missing batches" ghost that turned
out to be exactly-correct test data. `scripts/e2e.sh` already knows this and
re-runs `supabase/seed.sql` after `test-db.sh` and before starting the
browser (there's a comment on that exact line). If you're poking at the DB
by hand, do the same: re-run `psql -f supabase/seed.sql` before trusting what
you see.

## Where things live (fuller map in `README.md`)

```
src/domain/     Pure logic. No React, no Supabase, no clock. Unit-tested.
  ledger.ts       on-hand = SUM(delta); the load-bearing decision
  transfer.ts     (state, event) => state — the handoff state machine
  matching.ts     haversine + tiered ranking + the "why" string
  forecast.ts     consumption rate, waste/stockout outlook, confidence
  anticipate.ts   pairs predicted waste against predicted stockout
  intake.ts       validates the model's output before anyone sees it
  expiry.ts       date bands, plain language
  outbox.ts       contested vs uncontested actions; what the UI may claim
src/data/       Adapters: IndexedDB, fetch, session, the drain loop.
src/ui/         React. Presentation and wiring only.
api/            Vercel serverless. Holds the model key; never reaches the browser.
supabase/       migrations/ (schema+RLS), seed.sql, tests/ (server-side suite)
scripts/        test-db.sh, race-test.sh, e2e.sh, local-api.mjs (PostgREST shim)
docs/ai-design.md   Full reasoning on the two AI features and what was wrong
                    about the "no paid APIs" call earlier in the project.
MEMO.md         The one-page trade-off memo the brief asks for as a deliverable.
```

## Repo/branch facts worth knowing

- **`claude/review-items-hyotki` is the repository's only branch and its
  default branch** — there is no `main` to merge into. Every push to it is
  already "production" as far as GitHub and (almost certainly) Vercel are
  concerned.
- Latest commit: `1ce6cdf` — `fix: review pass on the forecast feature — 2
  real bugs, 5 hygiene fixes`. CI (`.github/workflows/ci.yml`) is green on it.
- A `keep-warm` GitHub Action exists (`.github/workflows/keep-warm.yml`,
  pings Supabase every 3 days so the free-tier project doesn't pause) but
  needs `SUPABASE_URL`/`SUPABASE_ANON_KEY` added as **repository secrets**
  (Settings → Secrets and variables → Actions) to do anything; unconfirmed
  whether the user has done this. It no-ops safely if not. Not urgent for a
  submission happening within 24 hours — only matters if a judge opens the
  link a week later.
- No secrets are in the repo (`.env` is gitignored, `.env.example` documents
  the two Supabase vars plus the optional `ANTHROPIC_API_KEY`).
