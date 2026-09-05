# Where AI is used in this project, and where it is not

Supplementary to [`MEMO.md`](../MEMO.md), which stays on the three things the
brief asks a memo for. This is the design reasoning behind the intelligence
layer.

The user is a livestock assistant on a cheap Android phone, outdoors, on 2G,
during an outbreak. That sentence decides everything below.

---

Two different tools, chosen per job rather than applied uniformly.

**Forecasting — deterministic, on-device, offline.** The ledger was already a
complete time series of demand per clinic per drug, and nothing read it.
Inferring a consumption rate from it answers the two questions the product
exists for — will this expire unused, will this run out — in well under a
millisecond, with the connection cut. That last property is why this half is
not a model call: the user is on 2G mid-outbreak and may have no signal at all,
so anything needing a round trip is unavailable exactly when the stakes peak.

It runs the loop closed. Pairing a forecast of waste at one clinic against a
forecast of stockout at another produces a proposed transfer with **no human
trigger anywhere** — which matters because the brief's own diagnosis is
inattention: stock spoils *"because staff cannot easily see what neighbouring
centres have or need before batches expire."* Nobody browses an inventory list
during an outbreak. In the seeded district, Jadcherla holds 48 FMD vials
expiring in 27 days and barely uses FMD, Balanagar gets through about one a day
and is nearly out, they are 13 km apart, and neither knows. The board now says
so before anyone posts anything.

Two guards decide whether that helps or harms, and both fall out of the
forecast rather than being rules to remember. Quantity is capped at the
sender's *projected waste*, so a suggestion can never cause the stockout it
exists to prevent. It is capped again at what the receiver can actually get
through before the same expiry date — otherwise sending 25 vials expiring in
five days to a clinic using one a day just moves the bin 12 km and calls it a
save.

**A language model — for language, off the critical path.** I first ruled this
out because the brief bans paid APIs. That reasoning was wrong: the spec sets
the opposite precedent itself when it justifies Supabase — *"the constraint
bans **paid** APIs... Free tier is not paid."* What actually survives is
narrower and still binding — an LLM must not sit on the critical path, because
claiming and handing off stock has to work at 2G with no signal.

Intake is not that path, and it is where the biggest real gap was: an
English-only UI for a Telugu-speaking audience. So one sentence in either
language, typed or dictated, becomes a **draft** request the worker confirms.
The dropdown was the low-tech answer to a problem this brief itself identifies
(free-text drug names destroy matching); this is a better answer that keeps the
same invariant, because the model resolves *to a catalogue id* or fails
honestly and hands back the picker.

Three properties make it safe rather than merely impressive:

1. **The key never reaches the browser.** It sits in a Vercel serverless
   function, matching what this system already assumes about the client. The
   SDK stays server-side, so the bundle a 2G worker downloads grew by 1.15 KB,
   not 100 KB.
2. **A hallucinated drug cannot reach the database.** Every field is
   re-validated against the real catalogue, with a foreign key behind that.
3. **Prompt injection is a non-event.** The worker's sentence is untrusted
   input; bounds reject absurd values and a human confirms the draft, so the
   worst case is a nonsense draft somebody declines.

And it degrades to nothing at all. Offline, unconfigured, rate-limited or just
slow, the manual form is untouched and right there — the model is an
accelerant, never a dependency. The e2e suite runs with no API key on purpose,
so the fallback is the path that gets tested.

**What I did not use a model for:** ranking matches, arbitrating claims, or
anything a worker must be able to check. Those stay arithmetic a person can
verify, because a ranking you cannot interrogate is useless to someone deciding
whether to send a colleague 30 km on a motorbike.

---

## What runs where

| | Forecasting + anticipation | Natural-language intake |
|---|---|---|
| Where it runs | On device, pure functions | Vercel serverless function |
| Needs network | No | Yes — degrades to the form |
| Needs a key | No | Yes, held server-side only |
| Client bundle cost | ~2 KB | 1.15 KB (SDK stays server-side) |
| Latency | Sub-millisecond | ~1–3s, off the critical path |
| On failure | n/a — cannot fail | Manual form, untouched |
| Cost | Zero | Free tier |

## Files

```
src/domain/forecast.ts     consumption rate, waste + stockout outlook, confidence
src/domain/anticipate.ts   pairs predicted waste against predicted stockout
src/domain/intake.ts       validates model output before a human ever sees it
src/data/intake.ts         client adapter; every failure path returns, none throw
api/parse-request.ts       serverless proxy; the API key lives here and only here
supabase/migrations/…      clinic_drug_consumption view — the demand aggregate
```

All three domain modules are pure — no React, no network, no clock, no SDK — and
carry 57 unit tests between them. `api/parse-request.ts` is typechecked under its
own `tsconfig.api.json`, wired into `npm run typecheck`.

## Setting up the language model (optional)

The app is fully functional without it; this only enables the one-sentence
intake field.

1. Get a key from [console.anthropic.com](https://console.anthropic.com).
2. In Vercel: **Settings → Environment Variables** → add `ANTHROPIC_API_KEY`.
   Do **not** prefix it with `VITE_` — that would expose it to the browser,
   which is the one thing this design exists to prevent.
3. Redeploy.

Without the key the endpoint returns `not_configured`, the client shows
"Typing help is not switched on — fill the form in below", and everything else
works exactly as before.

The model is `claude-opus-5` at `effort: "low"` — extraction from one sentence
is a simple task, and low effort keeps it fast for someone on a bad connection
without changing the model doing the work. Both are one-line changes in
`api/parse-request.ts`.
