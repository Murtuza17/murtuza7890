-- ============================================================================
-- Server-side regression tests.
--
-- These cover what the TypeScript unit tests cannot: row locking, idempotent
-- replay, the TTL sweep, and the reserved-quantity invariant. Run against a
-- throwaway Postgres with ./scripts/test-db.sh — no Supabase account needed.
--
-- Failure raises. Silence is success.
-- ============================================================================

create or replace function public._assert(p_cond boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_cond then raise exception 'FAILED: %', p_what; end if;
  raise notice '  ok  %', p_what;
end $$;

create or replace function public._token(p_code text, p_pin text)
returns uuid language sql as $$
  select (clinic_login(p_code, p_pin)->>'token')::uuid;
$$;

create or replace function public._batch(p_no text)
returns uuid language sql as $$ select id from batches where batch_no = p_no; $$;

-- ---------------------------------------------------------------------------
\echo '== idempotent replay =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_token uuid; v_transfer uuid; v_client uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; r3 jsonb; v_reserved int;
begin
  v_token := _token('MDJL','6789');
  select t.id into v_transfer from transfers t join clinics c on c.id=t.to_clinic_id
   where c.code='MDJL' and t.status='proposed' limit 1;

  -- A flaky 2G connection retrying the same claim three times.
  r1 := accept_transfer(v_token, v_transfer, v_client);
  r2 := accept_transfer(v_token, v_transfer, v_client);
  r3 := accept_transfer(v_token, v_transfer, v_client);

  perform _assert((r1->>'ok')::boolean, 'first claim succeeds');
  perform _assert(r1 = r2 and r2 = r3, 'replay returns the identical result, byte for byte');
  perform _assert(r1->>'sender_code' = r3->>'sender_code', 'replay does not reissue codes');

  select qty_reserved into v_reserved from batches where id = _batch('ASV-1204');
  perform _assert(v_reserved = 4, 'three retries reserve 4 vials, not 12');
end $$;

-- ---------------------------------------------------------------------------
\echo '== ledger is append-only and derived =='
-- ---------------------------------------------------------------------------
do $$
declare v_batch uuid; v_on_hand int; v_rows int;
begin
  v_batch := _batch('OXY-7741');
  select on_hand into v_on_hand from batch_stock where batch_id = v_batch;
  select count(*) into v_rows from stock_movements where batch_id = v_batch;

  perform _assert(v_on_hand = 116, 'on-hand is SUM(delta): 120 received - 4 dispensed = 116');
  perform _assert(v_rows = 2, 'both movements survive; neither was overwritten');
  perform _assert(
    not exists (select 1 from information_schema.columns
                where table_name='batches' and column_name='qty_on_hand'),
    'there is no qty_on_hand column to overwrite'
  );
end $$;

-- ---------------------------------------------------------------------------
\echo '== qty_reserved invariant =='
-- ---------------------------------------------------------------------------
do $$
declare v_drift int;
begin
  -- qty_reserved is the one stored running total in the schema. It is only safe
  -- if it always equals the derived truth. Prove it.
  select count(*) into v_drift from (
    select b.id
    from batches b
    left join transfers t on t.batch_id = b.id and t.status in ('accepted','in_transit')
    group by b.id, b.qty_reserved
    having b.qty_reserved <> coalesce(sum(t.qty), 0)
  ) drifted;
  perform _assert(v_drift = 0, 'qty_reserved equals SUM(qty) over live transfers on every batch');
end $$;

-- ---------------------------------------------------------------------------
\echo '== reservation TTL — lazy sweep, no cron =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_token uuid; v_transfer uuid; v_client uuid := gen_random_uuid();
  v_reserved int; v_status text; v_swept int; v_avail int;
begin
  -- Backdate the reservation: a clinic accepted scarce antivenom and went quiet.
  update transfers set reserved_until = now() - interval '1 minute'
   where batch_id = _batch('ASV-1204') and status = 'accepted';

  select available into v_avail from batch_stock where batch_id = _batch('ASV-1204');
  perform _assert(v_avail = 0, 'before the sweep the stock is still locked away');

  v_swept := sweep_expired_reservations();
  perform _assert(v_swept = 1, 'sweep releases exactly one lapsed reservation');

  select qty_reserved into v_reserved from batches where id = _batch('ASV-1204');
  perform _assert(v_reserved = 0, 'the vials are free again');

  select status into v_status from transfers
   where batch_id = _batch('ASV-1204') and status = 'expired' limit 1;
  perform _assert(v_status = 'expired', 'the abandoned transfer is marked expired, not deleted');

  perform _assert(
    exists (select 1 from events where type='transfer_expired'),
    'the expiry is on the audit trail'
  );

  -- And the freed stock is immediately claimable by somebody else.
  v_token := _token('BLNG','5678');
  select t.id into v_transfer from transfers t join clinics c on c.id=t.to_clinic_id
   where c.code='BLNG' and t.status='proposed' limit 1;
  perform _assert(
    (accept_transfer(v_token, v_transfer, v_client)->>'ok')::boolean,
    'a waiting clinic can now claim what the TTL released'
  );
end $$;

-- ---------------------------------------------------------------------------
\echo '== TTL sweep runs before the availability check, inside the lock =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid; v_token uuid; v_transfer uuid; r jsonb;
begin
  -- The ordering bug this guards against: a lapsed reservation that has not been
  -- swept yet makes free stock look committed and rejects a legitimate claim.
  v_batch := _batch('ASV-1199');  -- Balanagar, 9 vials
  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status, reserved_until,
                         accepted_at)
  select v_batch, b.clinic_id, (select id from clinics where code='DVKD'), 9, 'accepted',
         now() - interval '1 hour', now() - interval '25 hours'
  from batches b where b.id = v_batch;
  update batches set qty_reserved = 9 where id = v_batch;

  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
  select v_batch, b.clinic_id, (select id from clinics where code='MBNR'), 9, 'proposed'
  from batches b where b.id = v_batch
  returning id into v_transfer;

  v_token := _token('MBNR','1234');
  r := accept_transfer(v_token, v_transfer, gen_random_uuid());

  perform _assert((r->>'ok')::boolean,
    'a claim succeeds against stock whose stale reservation the same call swept');
end $$;

-- ---------------------------------------------------------------------------
\echo '== dual-party handoff =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid; v_from uuid; v_to uuid; v_transfer uuid;
  v_tok_from uuid; v_tok_to uuid;
  v_send text; v_recv text; r jsonb; v_status text; v_landed int;
begin
  v_batch := _batch('FMD-2411-C');                  -- Jadcherla, 54 on hand
  select clinic_id into v_from from batches where id = v_batch;
  select id into v_to from clinics where code = 'BLNG';

  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
  values (v_batch, v_from, v_to, 12, 'proposed') returning id into v_transfer;

  v_tok_from := _token('JDCL','3456');
  v_tok_to   := _token('BLNG','5678');

  r := accept_transfer(v_tok_to, v_transfer, gen_random_uuid());
  perform _assert((r->>'ok')::boolean, 'receiver accepts');
  v_send := r->>'sender_code';
  v_recv := r->>'receiver_code';
  perform _assert(v_send is not null and v_recv is not null,
    'both codes are issued at ACCEPT, before anyone sets off');
  perform _assert(v_send <> v_recv, 'the two codes differ');
  perform _assert(length(v_send) = 6 and v_send ~ '^[0-9]{6}$', 'codes are 6 digits, readable over a phone call');

  r := dispatch_transfer(v_tok_from, v_transfer, gen_random_uuid());
  perform _assert((r->>'ok')::boolean, 'sender dispatches');
  perform _assert(
    (select sum(delta) from stock_movements where transfer_id = v_transfer and reason='transferred_out') = -12,
    'dispatch writes the transferred_out delta: the vials left the shelf'
  );

  -- Sender reports the code the RECEIVER read out at the roadside.
  r := confirm_handoff(v_tok_from, v_transfer, 'sender', v_recv, gen_random_uuid());
  perform _assert(r->>'status' = 'in_transit', 'one-sided confirm stays in_transit');
  perform _assert((r->>'awaiting_other_side')::boolean,
    'and says plainly that it is waiting for the other clinic');

  r := confirm_handoff(v_tok_to, v_transfer, 'receiver', v_send, gen_random_uuid());
  perform _assert(r->>'status' = 'completed', 'both halves in -> completed');

  select status into v_status from transfers where id = v_transfer;
  perform _assert(v_status = 'completed', 'transfer is completed');

  select sum(delta)::int into v_landed from stock_movements
   where transfer_id = v_transfer and reason = 'transferred_in';
  perform _assert(v_landed = 12, 'the stock landed on the receiving clinic''s shelf');

  perform _assert(
    (select qty_reserved from batches where id = v_batch) = 0,
    'the reservation is released on completion'
  );
end $$;

-- ---------------------------------------------------------------------------
\echo '== mismatched codes dispute rather than guess =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid; v_from uuid; v_to uuid; v_transfer uuid;
  v_tok_from uuid; v_tok_to uuid; r jsonb; v_note text;
begin
  v_batch := _batch('BQ-5510');
  select clinic_id into v_from from batches where id = v_batch;
  select id into v_to from clinics where code = 'MBNR';

  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
  values (v_batch, v_from, v_to, 5, 'proposed') returning id into v_transfer;

  v_tok_from := _token('ADKL','2345');
  v_tok_to   := _token('MBNR','1234');

  perform accept_transfer(v_tok_to, v_transfer, gen_random_uuid());
  perform dispatch_transfer(v_tok_from, v_transfer, gen_random_uuid());

  r := confirm_handoff(v_tok_from, v_transfer, 'sender', '000000', gen_random_uuid());
  perform _assert(r->>'status' = 'disputed', 'a wrong code disputes instead of completing');

  select dispute_note into v_note from transfers where id = v_transfer;
  perform _assert(v_note like '%000000%', 'the trail records what was actually reported');
end $$;

-- ---------------------------------------------------------------------------
\echo '== echoing your own code is not proof of a handoff =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid; v_from uuid; v_to uuid; v_transfer uuid;
  v_tok_from uuid; v_tok_to uuid; r jsonb; v_own text;
begin
  v_batch := _batch('MLX-2201');
  select clinic_id into v_from from batches where id = v_batch;
  select id into v_to from clinics where code = 'MBNR';

  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
  values (v_batch, v_from, v_to, 5, 'proposed') returning id into v_transfer;

  v_tok_from := _token('ADKL','2345');
  v_tok_to   := _token('MBNR','1234');

  r := accept_transfer(v_tok_to, v_transfer, gen_random_uuid());
  v_own := r->>'sender_code';
  perform dispatch_transfer(v_tok_from, v_transfer, gen_random_uuid());

  -- The sender reads back its OWN code: proves only that it can read its screen.
  r := confirm_handoff(v_tok_from, v_transfer, 'sender', v_own, gen_random_uuid());
  perform _assert(r->>'status' = 'disputed', 'reading back your own code disputes');
end $$;

-- ---------------------------------------------------------------------------
\echo '== authorisation =='
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid; v_transfer uuid; v_wrong uuid; r jsonb;
begin
  -- Own fixture: relying on whatever an earlier test left behind makes this
  -- assert whatever happens to be lying around.
  v_batch := _batch('IVM-3345');
  insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
  select v_batch, b.clinic_id, (select id from clinics where code='MBNR'), 5, 'proposed'
  from batches b where b.id = v_batch
  returning id into v_transfer;

  -- Devarakadra was never offered these vials.
  v_wrong := _token('DVKD','4567');
  r := accept_transfer(v_wrong, v_transfer, gen_random_uuid());
  perform _assert(r->>'error' = 'not_your_transfer', 'a clinic cannot accept another clinic''s offer');
  perform _assert(
    (select qty_reserved from batches where id = v_batch) = 0,
    'and the refused claim reserved nothing'
  );
end $$;

do $$
declare r jsonb; ok boolean := false;
begin
  begin
    r := accept_transfer(gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
  exception when others then
    ok := (sqlerrm = 'session_invalid');
  end;
  perform _assert(ok, 'a forged session token is refused');
end $$;

-- ---------------------------------------------------------------------------
\echo '== PIN brute-force lockout =='
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; i int;
begin
  update clinics set failed_attempts = 0, locked_until = null where code = 'DVKD';
  for i in 1..5 loop
    r := clinic_login('DVKD','0000');
  end loop;
  r := clinic_login('DVKD','0000');
  perform _assert(r->>'error' = 'locked', 'a 4-digit PIN locks out after 5 wrong tries');

  -- Correct PIN is still refused while locked, so the lockout cannot be walked past.
  r := clinic_login('DVKD','4567');
  perform _assert(r->>'error' = 'locked', 'the lockout holds even for the right PIN');
  update clinics set failed_attempts = 0, locked_until = null where code = 'DVKD';
end $$;

\echo ''
\echo 'all server-side tests passed'
