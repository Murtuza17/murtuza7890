-- ============================================================================
-- 0001 — schema
--
-- Vials are the unit. Money does not exist here.
--
-- The governing rule: nothing is ever hard-deleted. Corrections are new rows
-- with a reason. Shrinkage has to stay visible, because this system moves
-- expensive controlled stock between parties who do not report to each other.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- clinics
-- ---------------------------------------------------------------------------
create table if not exists public.clinics (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  village       text not null,
  district      text not null,
  lat           double precision not null,
  lng           double precision not null,
  phone         text not null default '',
  pin_hash      text not null,
  -- A 4-digit PIN is 10,000 combinations: brute-forceable in seconds without a
  -- lockout. The brief mandates the PIN; it does not mandate leaving it open.
  failed_attempts int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- drugs — a controlled catalogue, deliberately not free text.
--
-- "FMD vaccine" / "Foot & Mouth vaccine" / "F.M.D." never match each other.
-- Free-text drug names would silently destroy matching, which makes the
-- catalogue a trust safeguard rather than a convenience.
-- ---------------------------------------------------------------------------
create table if not exists public.drugs (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  form                text not null check (form in ('vial','ampoule','bottle','sachet')),
  unit                text not null default 'vial',
  requires_cold_chain boolean not null default false,
  category            text not null check (category in
                        ('vaccine','antivenom','antibiotic','antiparasitic','supportive')),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- batches
--
-- NOTE: there is deliberately no qty_on_hand column. On-hand is SUM(delta) over
-- stock_movements. See 0001 notes on the ledger below.
--
-- qty_reserved IS a stored running total, which is the exact thing this schema
-- otherwise forbids. It is safe only because it is written in exactly one place:
-- inside accept_transfer's row-locked transaction. Never by a client, never
-- offline, never merged. `reconcile_reserved()` proves it against the derived
-- truth.
-- ---------------------------------------------------------------------------
create table if not exists public.batches (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references public.clinics(id),
  drug_id       uuid not null references public.drugs(id),
  batch_no      text not null,
  expiry_date   date not null,
  cold_chain_ok boolean not null default true,
  qty_reserved  int not null default 0 check (qty_reserved >= 0),
  status        text not null default 'active'
                  check (status in ('active','quarantined','depleted','expired')),
  created_at    timestamptz not null default now(),
  unique (clinic_id, drug_id, batch_no)
);

create index if not exists batches_clinic_idx on public.batches(clinic_id);
create index if not exists batches_drug_expiry_idx on public.batches(drug_id, expiry_date);

-- ---------------------------------------------------------------------------
-- stock_movements — THE LEDGER. Append-only. Never updated, never deleted.
--
-- Two devices offline at once both recording "dispensed 5 vials" must merge to
-- -10, not to whichever number synced last. Deltas commute; absolute totals do
-- not. An app that stores qty=12 and overwrites it cannot be made correct
-- offline no matter how good its sync code is, because the information needed
-- to merge was destroyed at write time.
--
-- client_id is UNIQUE. That constraint — not application logic, which races
-- against itself — is what makes replay safe on a flaky 2G connection.
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references public.batches(id),
  delta           int not null check (delta <> 0),
  reason          text not null check (reason in
                    ('received','dispensed','wasted','expired',
                     'transferred_out','transferred_in','correction')),
  actor_clinic_id uuid not null references public.clinics(id),
  transfer_id     uuid,
  client_id       uuid not null unique,
  -- Device clock. Display and within-device sequencing only. NEVER orders
  -- across devices: cheap handsets drift by hours and reset on a battery pull.
  client_ts       timestamptz,
  -- The only ordering authority in the system.
  server_ts       timestamptz not null default now()
);

create index if not exists movements_batch_idx on public.stock_movements(batch_id);
create index if not exists movements_server_ts_idx on public.stock_movements(server_ts);

-- ---------------------------------------------------------------------------
-- requests
-- ---------------------------------------------------------------------------
create table if not exists public.requests (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id),
  drug_id    uuid not null references public.drugs(id),
  qty_needed int not null check (qty_needed > 0),
  urgency    text not null check (urgency in ('routine','urgent','outbreak')),
  radius_km  int not null default 40 check (radius_km > 0),
  needed_by  date not null,
  note       text not null default '',
  status     text not null default 'open'
               check (status in ('open','partially_filled','filled','cancelled','expired')),
  client_id  uuid unique,
  created_at timestamptz not null default now()
);

create index if not exists requests_open_idx on public.requests(status, drug_id);

-- ---------------------------------------------------------------------------
-- transfers
--
-- Both codes are issued at ACCEPT, not at dispatch. The physical handoff happens
-- on a road with no signal, so both devices must already hold their code before
-- either leaves. Each side reads the OTHER side's code back; the two halves
-- reconcile whenever either device reconnects.
-- ---------------------------------------------------------------------------
create table if not exists public.transfers (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid references public.requests(id),
  batch_id       uuid not null references public.batches(id),
  from_clinic_id uuid not null references public.clinics(id),
  to_clinic_id   uuid not null references public.clinics(id),
  qty            int not null check (qty > 0),
  sender_code    text,
  receiver_code  text,
  status         text not null default 'proposed'
                   check (status in ('proposed','accepted','in_transit','completed',
                                     'declined','cancelled','expired','disputed')),
  -- Without a TTL a clinic can freeze scarce anti-venom indefinitely by
  -- accepting and going quiet.
  reserved_until timestamptz,
  -- What each side reported the OTHER side read out at the roadside.
  sender_confirmed_code   text,
  receiver_confirmed_code text,
  dispute_note   text,
  client_id      uuid unique,
  created_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  dispatched_at  timestamptz,
  completed_at   timestamptz,
  check (from_clinic_id <> to_clinic_id)
);

create index if not exists transfers_batch_live_idx
  on public.transfers(batch_id) where status in ('accepted','in_transit');
create index if not exists transfers_clinics_idx
  on public.transfers(from_clinic_id, to_clinic_id);

-- ---------------------------------------------------------------------------
-- events — append-only audit log. The trail a disputed handoff is judged on.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  entity_type     text not null check (entity_type in ('transfer','batch','request','clinic')),
  entity_id       uuid not null,
  type            text not null,
  actor_clinic_id uuid references public.clinics(id),
  payload         jsonb not null default '{}'::jsonb,
  client_ts       timestamptz,
  server_ts       timestamptz not null default now()
);

create index if not exists events_entity_idx on public.events(entity_type, entity_id, server_ts);

-- ---------------------------------------------------------------------------
-- clinic_sessions — opaque bearer token, no OAuth, no SMS, no email.
-- ---------------------------------------------------------------------------
create table if not exists public.clinic_sessions (
  token      uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  last_seen  timestamptz not null default now()
);

create index if not exists sessions_clinic_idx on public.clinic_sessions(clinic_id);

-- ---------------------------------------------------------------------------
-- rpc_results — idempotency ledger shared by every mutating RPC.
--
-- The offline queue replays. A drain interrupted mid-flight retries the same
-- action, and the second attempt must return the FIRST attempt's answer, not
-- re-run it. Storing the result (not just a "seen" marker) is what lets a
-- retried claim return the same success or the same rejection.
-- ---------------------------------------------------------------------------
create table if not exists public.rpc_results (
  client_id  uuid primary key,
  operation  text not null,
  result     jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- views — on-hand is DERIVED. Read it here; never store it.
-- ---------------------------------------------------------------------------
create or replace view public.batch_stock as
select
  b.id                                        as batch_id,
  b.clinic_id,
  b.drug_id,
  b.batch_no,
  b.expiry_date,
  b.cold_chain_ok,
  b.status,
  coalesce(sum(m.delta), 0)::int              as on_hand,
  b.qty_reserved,
  greatest(coalesce(sum(m.delta), 0)::int - b.qty_reserved, 0) as available
from public.batches b
left join public.stock_movements m on m.batch_id = b.id
group by b.id;

-- Clinics without pin_hash. The hash must never reach a browser bundle.
create or replace view public.clinics_public as
select id, code, name, village, district, lat, lng, phone, created_at
from public.clinics;
