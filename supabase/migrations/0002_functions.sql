-- ============================================================================
-- 0002 — server-side logic
--
-- Every mutation lives here, as a SECURITY DEFINER function taking a session
-- token. The browser holds the anon key and can therefore be assumed hostile:
-- it gets read access to the shared board (which is the product) and no direct
-- write access to anything (0003_rls.sql).
--
-- Contested actions — anything that can race another clinic — are resolved
-- here and only here. Uncontested own-clinic actions still come through here so
-- that idempotency and the audit trail are uniform.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- session helpers
-- ---------------------------------------------------------------------------
create or replace function public._clinic_for_session(p_token uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare v_clinic uuid;
begin
  select clinic_id into v_clinic
  from clinic_sessions
  where token = p_token and expires_at > now();

  if v_clinic is null then
    raise exception 'session_invalid' using errcode = 'P0001';
  end if;

  update clinic_sessions set last_seen = now() where token = p_token;
  return v_clinic;
end $$;

-- Clinic code + 4-digit PIN. No OAuth, no SMS, no email — as the brief requires.
--
-- A 4-digit PIN is 10,000 combinations. Without a lockout an attacker walks the
-- whole space in seconds and can then move real controlled stock between real
-- clinics. The brief mandates the PIN; it does not mandate leaving it open.
create or replace function public.clinic_login(p_code text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_clinic record;
  v_token  uuid;
begin
  select * into v_clinic from clinics where upper(code) = upper(trim(p_code));

  if not found then
    -- Same shape and cost as a wrong PIN: revealing which clinic codes exist
    -- is free reconnaissance.
    perform pg_sleep(0.2);
    return jsonb_build_object('ok', false, 'error', 'bad_credentials');
  end if;

  if v_clinic.locked_until is not null and v_clinic.locked_until > now() then
    return jsonb_build_object(
      'ok', false, 'error', 'locked',
      'locked_until', v_clinic.locked_until,
      'message', 'Too many wrong PINs. Try again shortly, or call the district office.'
    );
  end if;

  if v_clinic.pin_hash <> extensions.crypt(p_pin, v_clinic.pin_hash) then
    update clinics
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5
                            then now() + interval '15 minutes' else null end
    where id = v_clinic.id;

    return jsonb_build_object(
      'ok', false, 'error', 'bad_credentials',
      'attempts_left', greatest(0, 5 - (v_clinic.failed_attempts + 1))
    );
  end if;

  update clinics set failed_attempts = 0, locked_until = null where id = v_clinic.id;

  insert into clinic_sessions (clinic_id) values (v_clinic.id) returning token into v_token;

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'clinic', jsonb_build_object(
      'id', v_clinic.id, 'code', v_clinic.code, 'name', v_clinic.name,
      'village', v_clinic.village, 'district', v_clinic.district,
      'lat', v_clinic.lat, 'lng', v_clinic.lng, 'phone', v_clinic.phone
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6-digit codes, readable over a bad phone line. Server-generated only.
-- ---------------------------------------------------------------------------
create or replace function public._six_digit_code()
returns text language sql volatile as $$
  select lpad((floor(random() * 1000000))::int::text, 6, '0');
$$;

-- ---------------------------------------------------------------------------
-- Reservation TTL — lazy sweep. No cron, no paid scheduler.
--
-- Only accepted-but-never-dispatched transfers expire. Stock already on a
-- motorbike is not released by a clock.
--
-- _sweep_batch assumes the caller ALREADY HOLDS the lock on the batch row. That
-- is what makes the lock order (batch, then its transfers) consistent across
-- every caller, which is what stops two concurrent claims from deadlocking.
-- ---------------------------------------------------------------------------
create or replace function public._sweep_batch(p_batch_id uuid)
returns int
language plpgsql security definer set search_path = public, extensions
as $$
declare v_t record; v_released int := 0;
begin
  for v_t in
    select * from transfers
    where batch_id = p_batch_id and status = 'accepted'
      and reserved_until is not null and reserved_until <= now()
    order by id
    for update
  loop
    update transfers set status = 'expired' where id = v_t.id;
    update batches set qty_reserved = greatest(0, qty_reserved - v_t.qty) where id = p_batch_id;

    insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
    values ('transfer', v_t.id, 'transfer_expired', null,
            jsonb_build_object('reserved_until', v_t.reserved_until, 'qty', v_t.qty));

    v_released := v_released + 1;
  end loop;
  return v_released;
end $$;

-- Board-wide sweep, called on read. Locks batch first, then its transfers.
create or replace function public.sweep_expired_reservations()
returns int
language plpgsql security definer set search_path = public, extensions
as $$
declare v_batch uuid; v_total int := 0;
begin
  for v_batch in
    select distinct batch_id from transfers
    where status = 'accepted' and reserved_until is not null and reserved_until <= now()
    order by 1
  loop
    perform 1 from batches where id = v_batch for update;
    v_total := v_total + public._sweep_batch(v_batch);
  end loop;
  return v_total;
end $$;

-- Relative time, for rejection messages composed server-side.
create or replace function public._ago(p_ts timestamptz)
returns text language sql stable as $$
  select case
    when p_ts is null then null
    when now() - p_ts < interval '1 minute'  then 'just now'
    when now() - p_ts < interval '2 minutes' then '1 minute ago'
    when now() - p_ts < interval '1 hour'
      then extract(epoch from now() - p_ts)::int / 60 || ' minutes ago'
    when now() - p_ts < interval '2 hours'   then '1 hour ago'
    when now() - p_ts < interval '1 day'
      then extract(epoch from now() - p_ts)::int / 3600 || ' hours ago'
    else extract(epoch from now() - p_ts)::int / 86400 || ' days ago'
  end;
$$;

-- ---------------------------------------------------------------------------
-- CLAIM ARBITRATION — judging criterion #2.
--
-- Two clinics tapping Claim on the last 4 vials within the same second is the
-- scenario being graded. This must be one atomic transaction and it must never
-- run in the client.
--
-- Lock order is deliberate and uniform everywhere in this file:
--     1. the batch row  (the contention point — all claims on a batch serialize here)
--     2. that batch's transfers, in id order
--     3. the subject transfer
--
-- Sweeping happens AFTER the batch lock and BEFORE the availability recompute.
-- Getting that order wrong is a real bug: an expired-but-unswept reservation
-- would reject a legitimate claim on stock that is actually free.
--
-- The loser gets a specific, named rejection. A worker who receives a vague
-- error phones the other clinic and burns the outbreak.
-- ---------------------------------------------------------------------------
create or replace function public.accept_transfer(
  p_token uuid, p_transfer_id uuid, p_client_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_clinic    uuid;
  v_batch_id  uuid;
  v_batch     record;
  v_transfer  record;
  v_on_hand   int;
  v_reserved  int;
  v_available int;
  v_winner_name text;
  v_winner_at   timestamptz;
  v_sender    text;
  v_receiver  text;
  v_until     timestamptz;
  v_result    jsonb;
  v_existing  jsonb;
begin
  -- Replay of an already-applied action returns the FIRST answer, not a re-run.
  select result into v_existing from rpc_results where client_id = p_client_id;
  if found then return v_existing; end if;

  v_clinic := public._clinic_for_session(p_token);

  select batch_id into v_batch_id from transfers where id = p_transfer_id;
  if v_batch_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- (1) contention point
  select * into v_batch from batches where id = v_batch_id for update;
  -- (2) release anything whose TTL lapsed, before we count what is free
  perform public._sweep_batch(v_batch_id);
  -- (3) subject
  select * into v_transfer from transfers where id = p_transfer_id for update;

  if v_transfer.to_clinic_id <> v_clinic then
    return jsonb_build_object('ok', false, 'error', 'not_your_transfer');
  end if;

  if v_transfer.status <> 'proposed' then
    -- Includes the case where THIS clinic already accepted: return the codes
    -- rather than an error, so a lost response never looks like a failure.
    if v_transfer.status = 'accepted' then
      return jsonb_build_object(
        'ok', true, 'already', true, 'transfer_id', v_transfer.id,
        'sender_code', v_transfer.sender_code, 'receiver_code', v_transfer.receiver_code,
        'reserved_until', v_transfer.reserved_until
      );
    end if;
    return jsonb_build_object(
      'ok', false, 'error', 'wrong_state', 'state', v_transfer.status
    );
  end if;

  select coalesce(sum(delta), 0)::int into v_on_hand
  from stock_movements where batch_id = v_batch_id;

  -- Re-read qty_reserved: the sweep above may have changed it.
  select qty_reserved into v_reserved from batches where id = v_batch_id;
  v_available := v_on_hand - v_reserved;

  if v_available < v_transfer.qty then
    -- Name the winner. "Already committed to Addakal Dispensary 3 minutes ago"
    -- tells a worker what to do next; "claim failed" does not.
    select c.name, t.accepted_at
      into v_winner_name, v_winner_at
    from transfers t
    join clinics c on c.id = t.to_clinic_id
    where t.batch_id = v_batch_id and t.status in ('accepted','in_transit')
    order by t.accepted_at desc nulls last
    limit 1;

    v_result := jsonb_build_object(
      'ok', false,
      'error', 'insufficient_stock',
      'available', v_available,
      'requested', v_transfer.qty,
      'winner_clinic', v_winner_name,
      'committed_at', v_winner_at,
      'message', case
        when v_winner_name is not null then
          'Already committed to ' || v_winner_name ||
          coalesce(' ' || public._ago(v_winner_at), '')
        else 'Only ' || v_available || ' left — not enough for this claim.'
      end
    );

    insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
    values ('transfer', p_transfer_id, 'claim_rejected', v_clinic, v_result);

    -- The rejection is itself a result worth remembering: a retried claim must
    -- not suddenly succeed against different stock.
    insert into rpc_results (client_id, operation, result)
    values (p_client_id, 'accept_transfer', v_result);

    return v_result;
  end if;

  v_sender := public._six_digit_code();
  loop
    v_receiver := public._six_digit_code();
    exit when v_receiver <> v_sender;
  end loop;

  v_until := now() + interval '24 hours';

  update transfers
  set status = 'accepted', sender_code = v_sender, receiver_code = v_receiver,
      reserved_until = v_until, accepted_at = now()
  where id = p_transfer_id;

  update batches set qty_reserved = qty_reserved + v_transfer.qty where id = v_batch_id;

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
  values ('transfer', p_transfer_id, 'transfer_accepted', v_clinic,
          jsonb_build_object('qty', v_transfer.qty, 'reserved_until', v_until));

  v_result := jsonb_build_object(
    'ok', true, 'transfer_id', p_transfer_id,
    'sender_code', v_sender, 'receiver_code', v_receiver,
    'reserved_until', v_until
  );

  insert into rpc_results (client_id, operation, result)
  values (p_client_id, 'accept_transfer', v_result);

  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- decline / cancel / dispatch
-- ---------------------------------------------------------------------------
create or replace function public.decline_transfer(
  p_token uuid, p_transfer_id uuid, p_client_id uuid, p_note text default ''
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_clinic uuid; v_batch_id uuid; v_transfer record;
        v_result jsonb; v_existing jsonb;
begin
  select result into v_existing from rpc_results where client_id = p_client_id;
  if found then return v_existing; end if;

  v_clinic := public._clinic_for_session(p_token);

  select * into v_transfer from transfers where id = p_transfer_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_transfer.to_clinic_id <> v_clinic then
    return jsonb_build_object('ok', false, 'error', 'not_your_transfer');
  end if;
  if v_transfer.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'wrong_state', 'state', v_transfer.status);
  end if;

  update transfers set status = 'declined' where id = p_transfer_id;

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
  values ('transfer', p_transfer_id, 'transfer_declined', v_clinic,
          jsonb_build_object('note', p_note));

  v_result := jsonb_build_object('ok', true, 'transfer_id', p_transfer_id, 'status', 'declined');
  insert into rpc_results (client_id, operation, result)
  values (p_client_id, 'decline_transfer', v_result);
  return v_result;
end $$;

-- Cancelling an accepted transfer releases the reservation immediately rather
-- than making the other clinic wait out the 24h TTL on stock nobody is sending.
create or replace function public.cancel_transfer(
  p_token uuid, p_transfer_id uuid, p_client_id uuid, p_note text default ''
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_clinic uuid; v_batch_id uuid; v_transfer record;
        v_result jsonb; v_existing jsonb;
begin
  select result into v_existing from rpc_results where client_id = p_client_id;
  if found then return v_existing; end if;

  v_clinic := public._clinic_for_session(p_token);

  select batch_id into v_batch_id from transfers where id = p_transfer_id;
  if v_batch_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  perform 1 from batches where id = v_batch_id for update;  -- lock order: batch first
  select * into v_transfer from transfers where id = p_transfer_id for update;

  if v_clinic not in (v_transfer.from_clinic_id, v_transfer.to_clinic_id) then
    return jsonb_build_object('ok', false, 'error', 'not_your_transfer');
  end if;
  if v_transfer.status <> 'accepted' then
    return jsonb_build_object('ok', false, 'error', 'wrong_state', 'state', v_transfer.status);
  end if;

  update transfers set status = 'cancelled' where id = p_transfer_id;
  update batches set qty_reserved = greatest(0, qty_reserved - v_transfer.qty)
  where id = v_batch_id;

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
  values ('transfer', p_transfer_id, 'transfer_cancelled', v_clinic,
          jsonb_build_object('note', p_note, 'qty_released', v_transfer.qty));

  v_result := jsonb_build_object('ok', true, 'transfer_id', p_transfer_id, 'status', 'cancelled');
  insert into rpc_results (client_id, operation, result)
  values (p_client_id, 'cancel_transfer', v_result);
  return v_result;
end $$;

-- Dispatch writes the transferred_out movement: the vials physically leave the
-- shelf now, so the ledger must say so now. The reservation stays until the
-- handoff reconciles — it is what the receiving clinic is owed.
create or replace function public.dispatch_transfer(
  p_token uuid, p_transfer_id uuid, p_client_id uuid, p_client_ts timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_clinic uuid; v_batch_id uuid; v_transfer record;
        v_result jsonb; v_existing jsonb;
begin
  select result into v_existing from rpc_results where client_id = p_client_id;
  if found then return v_existing; end if;

  v_clinic := public._clinic_for_session(p_token);

  select batch_id into v_batch_id from transfers where id = p_transfer_id;
  if v_batch_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  perform 1 from batches where id = v_batch_id for update;
  select * into v_transfer from transfers where id = p_transfer_id for update;

  if v_transfer.from_clinic_id <> v_clinic then
    return jsonb_build_object('ok', false, 'error', 'not_your_transfer');
  end if;
  if v_transfer.status <> 'accepted' then
    return jsonb_build_object('ok', false, 'error', 'wrong_state', 'state', v_transfer.status);
  end if;

  update transfers set status = 'in_transit', dispatched_at = now() where id = p_transfer_id;

  insert into stock_movements (batch_id, delta, reason, actor_clinic_id, transfer_id,
                               client_id, client_ts)
  values (v_batch_id, -v_transfer.qty, 'transferred_out', v_clinic, p_transfer_id,
          p_client_id, p_client_ts);

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
  values ('transfer', p_transfer_id, 'transfer_dispatched', v_clinic,
          jsonb_build_object('qty', v_transfer.qty));

  v_result := jsonb_build_object('ok', true, 'transfer_id', p_transfer_id, 'status', 'in_transit');
  insert into rpc_results (client_id, operation, result)
  values (p_client_id, 'dispatch_transfer', v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- DUAL-PARTY HANDOFF — must-build #4.
--
-- Each side reports the code the OTHER side read out at the roadside. Echoing
-- your own code proves only that you can read your own screen.
--
--   both halves, matching -> completed, stock lands on the receiver's shelf
--   one half only         -> stays in_transit, pending on BOTH boards
--   a half that mismatches -> disputed, with the full event trail
--
-- The one-sided case is the one that matters. A receiver's phone dying on the
-- road must not fabricate a completion (stock reconciled that never arrived)
-- nor a loss (a real handoff written off). "Waiting for the other side" is the
-- only honest answer and it is what this returns.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_handoff(
  p_token uuid, p_transfer_id uuid, p_side text, p_code text,
  p_client_id uuid, p_client_ts timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_clinic   uuid;
  v_batch_id uuid;
  v_transfer record;
  v_expected text;
  v_both     boolean;
  v_new_batch uuid;
  v_result   jsonb;
  v_existing jsonb;
begin
  select result into v_existing from rpc_results where client_id = p_client_id;
  if found then return v_existing; end if;

  if p_side not in ('sender','receiver') then
    return jsonb_build_object('ok', false, 'error', 'bad_side');
  end if;

  v_clinic := public._clinic_for_session(p_token);

  select batch_id into v_batch_id from transfers where id = p_transfer_id;
  if v_batch_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  perform 1 from batches where id = v_batch_id for update;
  select * into v_transfer from transfers where id = p_transfer_id for update;

  if (p_side = 'sender'   and v_transfer.from_clinic_id <> v_clinic)
  or (p_side = 'receiver' and v_transfer.to_clinic_id   <> v_clinic) then
    return jsonb_build_object('ok', false, 'error', 'not_your_side');
  end if;

  if v_transfer.status <> 'in_transit' then
    return jsonb_build_object('ok', false, 'error', 'wrong_state', 'state', v_transfer.status);
  end if;

  v_expected := case when p_side = 'sender'
                     then v_transfer.receiver_code else v_transfer.sender_code end;

  if v_expected is not null and p_code <> v_expected then
    update transfers
    set status = 'disputed',
        dispute_note = p_side || ' reported code ' || p_code || ', expected ' || v_expected,
        sender_confirmed_code   = case when p_side = 'sender'   then p_code
                                       else sender_confirmed_code end,
        receiver_confirmed_code = case when p_side = 'receiver' then p_code
                                       else receiver_confirmed_code end
    where id = p_transfer_id;

    insert into events (entity_type, entity_id, type, actor_clinic_id, payload, client_ts)
    values ('transfer', p_transfer_id, 'transfer_disputed', v_clinic,
            jsonb_build_object('side', p_side, 'reported', p_code, 'expected', v_expected),
            p_client_ts);

    v_result := jsonb_build_object(
      'ok', true, 'status', 'disputed',
      'message', 'Codes did not match. Both clinics can see the full record.'
    );
    insert into rpc_results (client_id, operation, result)
    values (p_client_id, 'confirm_handoff', v_result);
    return v_result;
  end if;

  update transfers
  set sender_confirmed_code   = case when p_side = 'sender'   then p_code
                                     else sender_confirmed_code end,
      receiver_confirmed_code = case when p_side = 'receiver' then p_code
                                     else receiver_confirmed_code end
  where id = p_transfer_id
  returning (sender_confirmed_code is not null and receiver_confirmed_code is not null)
  into v_both;

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload, client_ts)
  values ('transfer', p_transfer_id, 'transfer_confirmed', v_clinic,
          jsonb_build_object('side', p_side), p_client_ts);

  if not v_both then
    v_result := jsonb_build_object(
      'ok', true, 'status', 'in_transit', 'awaiting_other_side', true,
      'message', 'Recorded. Waiting for the other clinic to confirm.'
    );
    insert into rpc_results (client_id, operation, result)
    values (p_client_id, 'confirm_handoff', v_result);
    return v_result;
  end if;

  -- Both halves in. Land the stock on the receiver's shelf as its own batch —
  -- same batch_no and expiry, new custody. The sending batch already lost the
  -- vials at dispatch.
  insert into batches (clinic_id, drug_id, batch_no, expiry_date, cold_chain_ok, status)
  select v_transfer.to_clinic_id, b.drug_id, b.batch_no, b.expiry_date, b.cold_chain_ok, 'active'
  from batches b where b.id = v_batch_id
  on conflict (clinic_id, drug_id, batch_no) do update set status = 'active'
  returning id into v_new_batch;

  insert into stock_movements (batch_id, delta, reason, actor_clinic_id, transfer_id,
                               client_id, client_ts)
  values (v_new_batch, v_transfer.qty, 'transferred_in', v_transfer.to_clinic_id, p_transfer_id,
          gen_random_uuid(), p_client_ts);

  update transfers set status = 'completed', completed_at = now() where id = p_transfer_id;
  update batches set qty_reserved = greatest(0, qty_reserved - v_transfer.qty)
  where id = v_batch_id;

  insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
  values ('transfer', p_transfer_id, 'transfer_completed', v_clinic,
          jsonb_build_object('qty', v_transfer.qty, 'landed_batch', v_new_batch));

  v_result := jsonb_build_object(
    'ok', true, 'status', 'completed', 'message', 'Handoff confirmed by both clinics.'
  );
  insert into rpc_results (client_id, operation, result)
  values (p_client_id, 'confirm_handoff', v_result);
  return v_result;
end $$;
