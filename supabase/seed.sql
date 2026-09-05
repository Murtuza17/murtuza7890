-- ============================================================================
-- seed — six real dispensaries in Mahabubnagar / Nagarkurnool, Telangana.
--
-- Coordinates are real and were chosen from a computed distance matrix so that
-- radius filtering actually does something. Distances from the Mahabubnagar hub:
--
--     Addakal      13 km      Balanagar    23 km
--     Jadcherla    18 km      Midjil       34 km
--     Devarakadra  18 km
--
-- All expiry dates are relative to current_date, so the demo reads correctly
-- whenever a judge opens it instead of rotting into a wall of expired stock.
--
-- Demo PINs are in README.md. They are demo credentials for seeded fixtures,
-- not secrets.
-- ============================================================================

truncate table rpc_results, events, stock_movements, transfers, requests,
               batches, clinic_sessions, drugs, clinics restart identity cascade;

-- ---------------------------------------------------------------------------
-- clinics
-- ---------------------------------------------------------------------------
insert into clinics (code, name, village, district, lat, lng, phone, pin_hash) values
  ('MBNR', 'Mahabubnagar Veterinary Dispensary', 'Mahabubnagar', 'Mahabubnagar',
   16.7488, 77.9854, '+91 90000 10001', extensions.crypt('1234', extensions.gen_salt('bf'))),
  ('ADKL', 'Addakal Rural Dispensary', 'Addakal', 'Mahabubnagar',
   16.6500, 78.0500, '+91 90000 10002', extensions.crypt('2345', extensions.gen_salt('bf'))),
  ('JDCL', 'Jadcherla Veterinary Centre', 'Jadcherla', 'Mahabubnagar',
   16.7667, 78.1500, '+91 90000 10003', extensions.crypt('3456', extensions.gen_salt('bf'))),
  ('DVKD', 'Devarakadra Dispensary', 'Devarakadra', 'Mahabubnagar',
   16.6167, 77.8833, '+91 90000 10004', extensions.crypt('4567', extensions.gen_salt('bf'))),
  ('BLNG', 'Balanagar Livestock Centre', 'Balanagar', 'Mahabubnagar',
   16.8833, 78.1500, '+91 90000 10005', extensions.crypt('5678', extensions.gen_salt('bf'))),
  ('MDJL', 'Midjil Veterinary Sub-Centre', 'Midjil', 'Nagarkurnool',
   16.7167, 78.3000, '+91 90000 10006', extensions.crypt('6789', extensions.gen_salt('bf')));

-- ---------------------------------------------------------------------------
-- drugs — the controlled catalogue. Field workers pick from this list; they
-- never type a drug name. "FMD vaccine" and "Foot & Mouth vaccine" would never
-- match each other, and a shortage that fails to match is the whole problem.
-- ---------------------------------------------------------------------------
insert into drugs (name, form, unit, requires_cold_chain, category) values
  ('Foot & Mouth Disease vaccine',      'vial',    'vial',    true,  'vaccine'),
  ('Haemorrhagic Septicaemia vaccine',  'vial',    'vial',    true,  'vaccine'),
  ('Black Quarter vaccine',             'vial',    'vial',    true,  'vaccine'),
  ('Brucella S19 vaccine',              'vial',    'vial',    true,  'vaccine'),
  ('Polyvalent Snake Antivenom',        'vial',    'vial',    true,  'antivenom'),
  ('Oxytetracycline 10% injection',     'vial',    'vial',    false, 'antibiotic'),
  ('Enrofloxacin 10% injection',        'vial',    'vial',    false, 'antibiotic'),
  ('Ivermectin 1% injection',           'vial',    'vial',    false, 'antiparasitic'),
  ('Meloxicam injection',               'vial',    'vial',    false, 'supportive'),
  ('Calcium borogluconate',             'bottle',  'bottle',  false, 'supportive');

-- ---------------------------------------------------------------------------
-- batches + opening stock
--
-- Expiries are staggered across every band so the inventory view demonstrates
-- its own visual spine on first load: expired, this week, this month, later.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid;
  r record;
begin
  for r in
    select * from (values
      -- clinic, drug,                              batch_no,     days_to_expiry, qty, cold_ok
      ('MBNR', 'Foot & Mouth Disease vaccine',      'FMD-2411-A',   9,  40, true),
      ('MBNR', 'Polyvalent Snake Antivenom',        'ASV-1180',    56,   6, true),
      ('MBNR', 'Oxytetracycline 10% injection',     'OXY-7741',   240, 120, true),
      ('MBNR', 'Ivermectin 1% injection',           'IVM-3320',   180,  60, true),
      ('MBNR', 'Haemorrhagic Septicaemia vaccine',  'HS-9021',     -3,  25, true),

      -- The scarce batch the double-claim demo runs on. 4 vials, two clinics
      -- want them. See the contested block below.
      ('ADKL', 'Polyvalent Snake Antivenom',        'ASV-1204',    21,   4, true),
      ('ADKL', 'Foot & Mouth Disease vaccine',      'FMD-2390-B',   5,  18, true),
      ('ADKL', 'Black Quarter vaccine',             'BQ-5510',    120,  30, true),
      ('ADKL', 'Meloxicam injection',               'MLX-2201',   300,  45, true),

      ('JDCL', 'Foot & Mouth Disease vaccine',      'FMD-2411-C',  27,  60, true),
      ('JDCL', 'Brucella S19 vaccine',              'BRU-8830',    75,  20, true),
      ('JDCL', 'Enrofloxacin 10% injection',        'ENR-4412',   210,  80, true),
      -- Cold chain broken in transit: quarantined, and never offered for
      -- transfer. A vaccine that arrives inert is worse than none, because the
      -- herd goes on the register as protected.
      ('JDCL', 'Haemorrhagic Septicaemia vaccine',  'HS-9044',     90,  15, false),

      ('DVKD', 'Calcium borogluconate',             'CAL-1102',   150,  24, true),
      ('DVKD', 'Oxytetracycline 10% injection',     'OXY-7756',    18,  35, true),
      ('DVKD', 'Foot & Mouth Disease vaccine',      'FMD-2402-D',   3,  22, true),

      ('BLNG', 'Black Quarter vaccine',             'BQ-5533',     14,  50, true),
      ('BLNG', 'Polyvalent Snake Antivenom',        'ASV-1199',   110,   9, true),
      ('BLNG', 'Ivermectin 1% injection',           'IVM-3345',   260,  40, true),

      ('MDJL', 'Foot & Mouth Disease vaccine',      'FMD-2388-E',  11,  16, true),
      ('MDJL', 'Meloxicam injection',               'MLX-2240',   190,  30, true),
      ('MDJL', 'Haemorrhagic Septicaemia vaccine',  'HS-9077',     42,  28, true)
    ) as t(clinic_code, drug_name, batch_no, days_to_expiry, qty, cold_ok)
  loop
    insert into batches (clinic_id, drug_id, batch_no, expiry_date, cold_chain_ok, status)
    select c.id, d.id, r.batch_no, current_date + r.days_to_expiry, r.cold_ok,
           case when not r.cold_ok then 'quarantined'
                when current_date + r.days_to_expiry < current_date then 'expired'
                else 'active' end
    from clinics c, drugs d
    where c.code = r.clinic_code and d.name = r.drug_name
    returning id into v_batch;

    insert into stock_movements (batch_id, delta, reason, actor_clinic_id, client_id, client_ts, server_ts)
    select v_batch, r.qty, 'received', b.clinic_id, gen_random_uuid(),
           now() - interval '30 days', now() - interval '30 days'
    from batches b where b.id = v_batch;
  end loop;
end $$;

-- A little dispensing history, so on-hand is visibly a running sum of the
-- ledger rather than a number somebody typed in.
insert into stock_movements (batch_id, delta, reason, actor_clinic_id, client_id, client_ts, server_ts)
select b.id, -4, 'dispensed', b.clinic_id, gen_random_uuid(),
       now() - interval '6 days', now() - interval '6 days'
from batches b join drugs d on d.id = b.drug_id
where b.batch_no = 'OXY-7741';

insert into stock_movements (batch_id, delta, reason, actor_clinic_id, client_id, client_ts, server_ts)
select b.id, -6, 'dispensed', b.clinic_id, gen_random_uuid(),
       now() - interval '2 days', now() - interval '2 days'
from batches b where b.batch_no = 'FMD-2411-C';

insert into stock_movements (batch_id, delta, reason, actor_clinic_id, client_id, client_ts, server_ts)
select b.id, -2, 'wasted', b.clinic_id, gen_random_uuid(),
       now() - interval '1 day', now() - interval '1 day'
from batches b where b.batch_no = 'BQ-5533';

-- ---------------------------------------------------------------------------
-- open requests
-- ---------------------------------------------------------------------------
insert into requests (clinic_id, drug_id, qty_needed, urgency, radius_km, needed_by, note, status)
select c.id, d.id, 12, 'outbreak', 40, current_date + 3,
       'Suspected FMD in two herds at Peddapur. Need doses today or tomorrow.', 'open'
from clinics c, drugs d
where c.code = 'BLNG' and d.name = 'Foot & Mouth Disease vaccine';

insert into requests (clinic_id, drug_id, qty_needed, urgency, radius_km, needed_by, note, status)
select c.id, d.id, 3, 'urgent', 40, current_date + 1,
       'Snakebite case, buffalo. Two vials left on shelf.', 'open'
from clinics c, drugs d
where c.code = 'MDJL' and d.name = 'Polyvalent Snake Antivenom';

insert into requests (clinic_id, drug_id, qty_needed, urgency, radius_km, needed_by, note, status)
select c.id, d.id, 20, 'routine', 25, current_date + 14,
       'Routine deworming camp scheduled at Kothapally.', 'open'
from clinics c, drugs d
where c.code = 'DVKD' and d.name = 'Ivermectin 1% injection';

-- ---------------------------------------------------------------------------
-- THE CONTESTED BATCH — spec §8 item 2, "one already-contested batch".
--
-- Addakal holds 4 vials of antivenom. Midjil and Balanagar have each been
-- offered all 4. Whichever taps Claim first gets them; the other must receive a
-- named rejection, not a silent failure. A judge can reproduce the race in two
-- browser tabs in about fifteen seconds.
-- ---------------------------------------------------------------------------
insert into transfers (request_id, batch_id, from_clinic_id, to_clinic_id, qty, status)
select null, b.id, b.clinic_id, c.id, 4, 'proposed'
from batches b, clinics c
where b.batch_no = 'ASV-1204' and c.code = 'MDJL';

insert into transfers (request_id, batch_id, from_clinic_id, to_clinic_id, qty, status)
select null, b.id, b.clinic_id, c.id, 4, 'proposed'
from batches b, clinics c
where b.batch_no = 'ASV-1204' and c.code = 'BLNG';

insert into events (entity_type, entity_id, type, actor_clinic_id, payload)
select 'batch', b.id, 'batch_created', b.clinic_id,
       jsonb_build_object('note', 'Seeded contested batch for the double-claim demo')
from batches b where b.batch_no = 'ASV-1204';
