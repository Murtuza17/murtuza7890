-- ============================================================================
-- RLS probes.
--
-- The anon key ships in the JavaScript bundle, so anyone who can open the app
-- can talk to PostgREST directly with curl. Every probe below is something a
-- hostile client would try. All of them must fail.
-- ============================================================================

create or replace function public._denied(p_sql text, p_what text)
returns void language plpgsql as $$
begin
  begin
    execute 'set local role anon';
    execute p_sql;
    execute 'reset role';
    raise exception 'FAILED (was ALLOWED): %', p_what;
  exception
    when insufficient_privilege then
      execute 'reset role';
      raise notice '  blocked  %', p_what;
    when others then
      execute 'reset role';
      if sqlstate = 'P0001' and sqlerrm like 'FAILED%' then raise; end if;
      raise notice '  blocked  % (%)', p_what, sqlstate;
  end;
end $$;

create or replace function public._allowed(p_sql text, p_what text)
returns void language plpgsql as $$
begin
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  raise notice '  allowed  %', p_what;
exception when others then
  execute 'reset role';
  raise exception 'FAILED (should be allowed): % — %', p_what, sqlerrm;
end $$;

do $$
begin
  -- secrets
  perform _denied('select pin_hash from clinics limit 1', 'read a clinic PIN hash');
  perform _denied('select * from clinics limit 1', 'select * from clinics (would expose the hash)');
  perform _denied('select token from clinic_sessions limit 1', 'steal another clinic''s session token');
  perform _denied('select * from rpc_results limit 1', 'read the idempotency ledger');

  -- forging stock
  perform _denied($q$insert into stock_movements (batch_id, delta, reason, actor_clinic_id, client_id)
                     select id, 9999, 'received', clinic_id, gen_random_uuid() from batches limit 1$q$,
                  'invent 9999 vials out of nothing');
  perform _denied('update batches set qty_reserved = 0', 'silently release everyone''s reservations');
  perform _denied('update transfers set status = ''completed''', 'mark a transfer complete without a handoff');

  -- destroying evidence
  perform _denied('delete from stock_movements', 'delete an inconvenient ledger row');
  perform _denied('delete from events', 'erase the audit trail');
  perform _denied('delete from transfers', 'delete a disputed transfer');

  -- internal machinery
  perform _denied('select _sweep_batch((select id from batches limit 1))', 'call the internal sweep helper');
  perform _denied('select _clinic_for_session(gen_random_uuid())', 'call the session resolver directly');
  perform _denied('select _six_digit_code()', 'generate a handoff code client-side');

  -- and what the app legitimately needs
  perform _allowed('select count(*) from batch_stock', 'read the shared board');
  perform _allowed('select code, name from clinics_public', 'read the public clinic list');
  perform _allowed('select clinic_login(''MBNR'', ''1234'')', 'log in');
end $$;
