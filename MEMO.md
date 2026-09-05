# Trade-off memo

**Rural Vet Medicine Expiry & Emergency Swap Board** · one page

The user is a livestock assistant on a cheap Android phone, outdoors, on 2G,
during an outbreak. Every decision below is downstream of that.

---

## The one decision the rest hang off

**On-hand stock is derived, never stored.** There is no `qty_on_hand` column;
quantity is `SUM(delta)` over an append-only ledger.

Two workers, both without signal, both dispense 5 vials from the same batch. A
stored total has each device write `qty = 7`, last write wins, and five vials
vanish with no trace. Deltas keep both rows and reach `12 − 5 − 5 = 2`. Deltas
commute, so merge order cannot change the answer; totals do not. An app that
overwrites a running total has destroyed the information needed to merge before
the sync code ever runs — no amount of clever reconciliation gets it back.

Everything below is a consequence.

---

## Trust safeguards

**Contested actions are never decided on the device.** Every action is one of two
kinds. *Own-clinic* — dispensing, adding a batch, a correction — cannot be
contradicted by anyone, merges by addition, and so applies immediately even
offline. *Cross-clinic* — claiming stock — can race another dispensary, so it
queues and the **server** arbitrates. One app, two consistency models, chosen per
action by whether the action can conflict. That single distinction is what makes
the offline mode honest instead of dangerous.

**Claiming is one locked transaction.** `accept_transfer` locks the batch row
(`FOR UPDATE`), sweeps lapsed reservations, recomputes availability, and either
commits or refuses. Lock order is uniform everywhere — batch, then its transfers,
then the subject — so concurrent claims serialise instead of deadlocking. Five
clinics claiming the same four vials simultaneously yields exactly one winner and
`qty_reserved = 4`; `scripts/race-test.sh` runs it for real.

**The loser is told who won.** *"Already committed to Midjil Veterinary Sub-Centre
just now"*, not an error code. A worker who gets a vague failure phones around and
burns the outbreak.

**The UI never claims a state the server has not confirmed.** A queued claim reads
*Waiting to send*. A worker who drives 30 km on a false confirmation never trusts
the system again, and would be right not to.

**Both handoff codes are issued at claim time, not dispatch.** The handoff happens
on a road with no signal, so both phones must already hold their code before
either sets off. Each side reads back the *other* side's code — echoing your own
proves only that you can read your own screen.

**A drug catalogue, never free text.** "FMD vaccine" / "Foot & Mouth vaccine" /
"F.M.D." never match each other. Free text would silently break matching, which is
a trust failure dressed as a UX choice.

**Nothing is ever deleted.** Corrections are new rows with a reason. Shrinkage
stays visible — the point of an audit trail between parties who do not report to
each other.

**PIN lockout.** A 4-digit PIN is 10,000 combinations, walkable in seconds. Five
wrong tries locks the clinic for 15 minutes. The brief mandates the PIN; it does
not mandate leaving it open.

**The browser is assumed hostile.** The anon key ships in the bundle, so it gets
read access to the shared board — which *is* the product — and write access to
nothing. Every mutation is a `SECURITY DEFINER` function behind a session token.
Thirteen hostile probes are asserted blocked in `supabase/tests/rls_test.sql`.

---

## Offline reconciliation

Every action is written to IndexedDB **before** the network is touched, with a
client-generated UUID. The server dedupes on that UUID with a `UNIQUE` constraint
— in the database, not in application code, which would race itself. Three
retries on a flaky link produce one movement.

Replay returns the **stored result**, not a fresh attempt. A retried claim gets
the first attempt's answer byte for byte, rejections included, so a retry can
never succeed against different stock.

The queue drains strictly serially in creation order. Parallel would look faster
and be wrong: dispatch must not overtake the accept that issued its codes.

**Server time orders the ledger; device clocks never do.** Cheap handsets drift by
hours and reset on a battery pull. Client timestamps are for display and
within-device sequencing only.

**The dual-code reconciliation has three outcomes, and the middle one matters
most.** Both halves matching → completed. A mismatch → disputed, with the full
trail visible to both clinics. **One half only → stays *On the way*, pending on
both boards.** A receiver's phone dying on the road must not fabricate a
completion, and must not write off a real handoff. "Waiting for the other side" is
the only honest answer.

**Reservations expire after 24 hours**, swept lazily on read — no cron, no paid
scheduler. Without it a clinic freezes scarce antivenom by claiming it and going
quiet. The sweep runs *inside* the claim lock and *before* the availability
recount; the other order would reject a legitimate claim on stock that is
actually free.

**The cached board serves two purposes.** It makes the app useful with zero
signal, and it hides a Supabase cold start behind instantly-rendered content. A
permanent staleness marker — *"Last updated 2 hours ago"* — keeps that honest.

---

## Prioritised cuts

**Cut, and I would not add them back first:** maps and routing, photo uploads,
push notifications, SMS/IVR, multi-language, admin analytics, temperature-sensor
integration, inter-clinic payment, sub-clinic roles. All are out of scope in the
brief, and each would have cost time that went into the claim transaction
instead.

**Cut with real regret, in the order I would restore them:**

1. **Real identity verification.** A clinic PIN identifies a *dispensary*, not a
   person. For controlled stock moving between government facilities that is
   genuinely thin. It is what the brief asks for, and I would not ship it beyond
   a pilot without per-worker identity.
2. **Multi-language.** The audience is Telugu-speaking. An English-only UI for
   low-digital-literacy field workers is the largest real-world gap here, and the
   copy was written plain partly to make translation cheap later.
3. **Push notifications.** An outbreak request currently waits to be noticed. SMS
   is banned by the brief and web push is unreliable on the target handsets, but
   "nobody looked at the board" is a real failure mode.
4. **A demo GIF in the README.** Explicitly the first thing the brief says to cut.

**Chosen against, not run out of time for:** Supabase Realtime (a held websocket
costs battery and data on a handset idle in a drawer; a 20-second poll plus
refresh-on-focus is cheaper and enough), and `@supabase/supabase-js` — 100 KB
gzipped of a 125 KB bundle for `.rpc()` and one `select`. Dropping it took first
load to 71.8 KB, roughly four seconds on 2G. That is the same argument the spec
makes about webfonts, with a bigger number.

**Known limit I would fix next:** `qty_reserved` is the one stored running total
in the schema — exactly what the ledger exists to forbid. It is safe only because
it is written in one place, inside the row lock. `reservedDrift()` states the
invariant and the tests assert it, but a periodic reconciliation job would be
better than a proof that holds only as long as everyone respects the rule.
