# Handoff — read this first

Originally written 2026-09-05 by an outgoing Claude Code session running low
on budget; updated 2026-09-06 after a further round (antigravity's i18n/
one-tap/dictation additions, a review pass that found and fixed a severe bug
in them, then a `propose_transfer` feature closing the last real gap).
**The brief's deadline is Sunday 6 September 2026, 3:47 pm IST — today.**
Everything below is ordered so remaining time goes to what the deadline
actually needs, not to polish.

## The one-line status

The product is **complete, tested, committed, and pushed**. `git log` on
`claude/review-items-hyotki` (the repo's only branch — see below) ends at
commit `8ce6070`, CI is green on it, and locally: 192 unit tests, 87 DB/RLS/
race assertions against a real Postgres 16, and a 51-check browser e2e suite
at 360px all pass. There is no unfinished must-build feature, and both
directions of the proactive-suggestion feature are now one-tap actionable.
What's left is one **required manual step against the live Supabase project**
(next section) and verification-under-time-pressure — not more building.

## Required: re-run the SQL migrations against the live Supabase project

**This is the one action item in this file that isn't optional.** Today's
`propose_transfer` RPC is new — it exists in `supabase/migrations/0002_functions.sql`
and is granted in `0003_rls.sql`, but a `git push` only redeploys the Vercel
frontend. It does **not** touch the live Supabase database. Until someone
re-runs the updated `0002_functions.sql` and `0003_rls.sql` (in that order,
`create or replace function` / `grant` are both safe to re-run) in the
Supabase project's SQL Editor, the live database simply does not have this
function yet.

**Why this matters more than a normal "redeploy the schema" note:** if a judge
taps the new "Offer N vials to X" button before this is done, the call fails
with a genuine "function does not exist" error from real PostgREST — which
the client (correctly, for actual network failures) treats as "no signal, try
again later" and leaves the action `pending` forever. Because the offline
queue drains strictly serially, oldest item first, that one tap would **jam
every action queued after it** on that device, indefinitely. This is exactly
the failure mode this session spent real effort finding and fixing in a
different feature earlier today — do not let it happen here by skipping a
migration re-run. Five minutes in the SQL Editor now avoids it entirely.

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
  card reading roughly *"Ask Jadcherla ... for 19 vials"*, with an **"Ask for
  N vials" button** on it — tap it and confirm it turns into "Request
  posted," not a stuck "Waiting to send."
- Sign in as `JDCL` / `3456` instead. Confirm its Requests tab shows the
  *other* half of the same pairing — *"Offer N vials to Balanagar"* — with
  an **"Offer" button**. Tapping it needs the migration re-run above done
  first; if it stays stuck on "Waiting to send," that is the symptom of
  skipping that step, not a code bug.
- If either card or button is missing entirely: check the Vercel dashboard's
  deployment log for the repo. Because this repo's default branch **is**
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

### 4. Only if real time remains: what's actually left

Both items originally listed here — wiring the receiver half of the
suggestion card to `create_request`, and giving the sender half a real
`propose_transfer` RPC — are **done**, tested (SQL + unit + e2e), and
pushed. What's left, ranked by payoff-per-hour and how much it risks the
tested core, is smaller than it was:

1. **Finish the trilingual coverage.** `src/domain/i18n.ts` and `t()` exist
   and are wired into tabs, statuses, urgency levels, and the primary
   actions — a first pass antigravity added today, reviewed and fixed for a
   script-mixing bug (see commit `240e25c`). Still English-only: the sign-in
   screen (`src/ui/Login.tsx`), and the longer explanatory sentences in the
   surge-alert banner and expiry-risk summary (`src/ui/Requests.tsx`,
   `src/ui/Inventory.tsx`). This is pure string work against an
   already-working system — no new RPCs, no new domain logic, low risk by
   construction. If you do this, add a case to the existing
   `src/domain/i18n.test.ts` "script leak" test for anything new, and run
   `npm test` — that test is specifically what catches a wrong-script string
   before a Hindi-reading worker does.
2. **Anything else** — see "Do not build" just below. There isn't a second
   real functional gap left; resist inventing one.

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
  `src/data/intake.ts`) — one sentence in English, Telugu, or Hindi becomes a
  pre-filled draft request via a real Claude API call, dictated (browser
  Speech API, zero cost) or typed. This is the one place a model is used, and
  it's deliberately kept off the critical path: key held server-side only
  (never in the browser bundle), every field re-validated against the drug
  catalogue before it can touch the database, and the manual form works
  identically if the key is absent, rate-limited, or the request fails.
  `docs/ai-design.md` has the full reasoning, including a correction of an
  early mistake (initially over-read the brief's "no paid APIs" constraint as
  banning any model call at all — wrong; free tier is not paid, and the
  spec's own justification for using Supabase says so explicitly).
- **Both halves of the suggestion are now one-tap actionable.** The receiver
  gets a real "Ask for N vials" button (`create_request`); the sender gets a
  real "Offer N vials to X" button (`propose_transfer`, added today —
  see the required migration step above). Neither reserves or locks
  anything by itself; `accept_transfer`'s existing locked check is still the
  one place that arbitrates a real claim, exactly as it already did for the
  seeded double-offer demo.
- **Trilingual UI, first pass** (`src/domain/i18n.ts`) — English, Telugu
  (`తెలుగు`), Hindi (`हिन्दी`). Tabs, statuses, urgency levels, and primary
  actions switch language from the topbar; the sign-in screen and longer
  explanatory sentences are still English-only (see item 1 under "what's
  actually left" above).

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
npm test          # 192 unit tests, ~1s
npm run typecheck
npm run test:db    # spins up throwaway Postgres 16, applies real migrations + seed
npm run test:race  # + 5 clinics claiming the same 4 vials concurrently
npm run test:e2e   # + real headless Chromium at 360px against the real stack, 51 checks
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
  i18n.ts         en/te/hi strings + t() — first pass, not full coverage
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
- Latest commit: `8ce6070` — `feat: propose_transfer — the sender side can
  now offer stock unprompted`. CI (`.github/workflows/ci.yml`) is green on it.
  Full history of today's second round, oldest first: `dca674f` (antigravity's
  i18n/one-tap/dictation additions) → `240e25c` (review pass: fixed a severe
  queue-jamming bug in the new suggestion button, plus several smaller real
  issues — full detail in that commit's message) → `8ce6070` (this one).
- A `keep-warm` GitHub Action exists (`.github/workflows/keep-warm.yml`,
  pings Supabase every 3 days so the free-tier project doesn't pause) but
  needs `SUPABASE_URL`/`SUPABASE_ANON_KEY` added as **repository secrets**
  (Settings → Secrets and variables → Actions) to do anything; unconfirmed
  whether the user has done this. It no-ops safely if not. Not urgent for a
  submission happening within 24 hours — only matters if a judge opens the
  link a week later.
- No secrets are in the repo (`.env` is gitignored, `.env.example` documents
  the two Supabase vars plus the optional `ANTHROPIC_API_KEY`).
