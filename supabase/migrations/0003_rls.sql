-- ============================================================================
-- 0003 — row-level security and grants
--
-- Threat model: the anon key ships inside the JavaScript bundle. Anyone who can
-- open the app can read it and talk to PostgREST directly with curl. So the
-- browser is assumed hostile and gets exactly two things:
--
--   READ   the shared board. This is not a leak — a board every clinic can see
--          IS the product. Nothing here is private between clinics.
--   WRITE  nothing. Not one table. Every mutation goes through a SECURITY
--          DEFINER function that takes a session token.
--
-- Three things are never readable by the browser at all: pin_hash (column-level
-- grant), clinic_sessions (other clinics' bearer tokens), and rpc_results.
-- ============================================================================

alter table public.clinics          enable row level security;
alter table public.drugs            enable row level security;
alter table public.batches          enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.requests         enable row level security;
alter table public.transfers        enable row level security;
alter table public.events           enable row level security;
alter table public.clinic_sessions  enable row level security;
alter table public.rpc_results      enable row level security;

-- ---------------------------------------------------------------------------
-- Readable board. SELECT only — there is deliberately no INSERT, UPDATE or
-- DELETE policy anywhere in this file, so those are denied by default.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['clinics','drugs','batches','stock_movements',
                           'requests','transfers','events']
  loop
    execute format('drop policy if exists board_readable on public.%I', t);
    execute format('create policy board_readable on public.%I for select using (true)', t);
  end loop;
end $$;

-- clinic_sessions and rpc_results get NO policy at all: RLS on with zero
-- policies denies everything. They are reachable only from inside the
-- SECURITY DEFINER functions, which run as the owner and bypass RLS.

-- ---------------------------------------------------------------------------
-- Grants. RLS decides which ROWS; grants decide which COLUMNS.
--
-- pin_hash, failed_attempts and locked_until are simply not granted, so
-- `select * from clinics` fails for anon rather than quietly returning hashes.
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and every role
-- inherits that. Revoking from `anon` alone is therefore a no-op — verified the
-- hard way: _sweep_batch stayed callable by anon until this line existed.
-- Close the whole schema, then open exactly the API surface.
revoke execute on all functions in schema public from public;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant usage on schema public to %I', r);
      execute format(
        'grant select (id, code, name, village, district, lat, lng, phone, created_at)
         on public.clinics to %I', r);
      execute format('grant select on public.drugs, public.batches,
        public.stock_movements, public.requests, public.transfers, public.events to %I', r);
      execute format('grant select on public.batch_stock, public.clinics_public to %I', r);

      -- Writes: functions only.
      execute format('grant execute on function
        public.clinic_login(text, text),
        public.accept_transfer(uuid, uuid, uuid),
        public.decline_transfer(uuid, uuid, uuid, text),
        public.cancel_transfer(uuid, uuid, uuid, text),
        public.dispatch_transfer(uuid, uuid, uuid, timestamptz),
        public.confirm_handoff(uuid, uuid, text, text, uuid, timestamptz),
        public.sweep_expired_reservations()
        to %I', r);

    end if;
  end loop;
end $$;

-- Views run with the caller's privileges so the grants above actually apply,
-- rather than the view silently bypassing them as its owner.
alter view public.batch_stock     set (security_invoker = true);
alter view public.clinics_public  set (security_invoker = true);
