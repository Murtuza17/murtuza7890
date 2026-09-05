#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The double-claim race, run for real: five clinics claim the same four vials
# at the same instant. Exactly one must win; the rest must be told who won.
# ---------------------------------------------------------------------------
set -euo pipefail
DB=${1:-vetswap_test}
export PGHOST=${PGHOST:-/tmp} PGPORT=${PGPORT:-55432} PGUSER=postgres

psql -q -d "$DB" -c "
delete from transfers;
update batches set qty_reserved = 0;
insert into transfers (batch_id, from_clinic_id, to_clinic_id, qty, status)
select b.id, b.clinic_id, c.id, 4, 'proposed'
from batches b, clinics c
where b.batch_no='ASV-1204' and c.code in ('MBNR','JDCL','DVKD','BLNG','MDJL');
update clinics set failed_attempts = 0, locked_until = null;"

psql -q -d "$DB" -t -A -c "
select c.code || ' ' || (clinic_login(c.code, p.pin)->>'token') || ' ' || t.id
from clinics c
join (values ('MBNR','1234'),('JDCL','3456'),('DVKD','4567'),('BLNG','5678'),('MDJL','6789'))
     as p(code,pin) on p.code=c.code
join transfers t on t.to_clinic_id=c.id and t.status='proposed';" > /tmp/claimants.txt

START=$(( $(date +%s) + 3 ))
while read -r CODE TOKEN TID; do
  (
    while [ "$(date +%s)" -lt "$START" ]; do :; done
    R=$(psql -q -d "$DB" -t -A -c "select accept_transfer('$TOKEN'::uuid,'$TID'::uuid,gen_random_uuid());")
    if [ "$(echo "$R" | grep -c '"ok": true')" -eq 1 ]; then
      echo "  WON   $CODE"
    else
      echo "  lost  $CODE — $(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["message"])' 2>/dev/null || echo "$R")"
    fi
  ) &
done < /tmp/claimants.txt
wait 2>/dev/null

psql -q -d "$DB" -t -A -c "
do \$\$
declare v_accepted int; v_reserved int;
begin
  select count(*) into v_accepted from transfers t join batches b on b.id=t.batch_id
   where b.batch_no='ASV-1204' and t.status='accepted';
  select qty_reserved into v_reserved from batches where batch_no='ASV-1204';
  if v_accepted <> 1 then raise exception 'FAILED: % transfers accepted, expected exactly 1', v_accepted; end if;
  if v_reserved <> 4 then raise exception 'FAILED: qty_reserved=%, expected 4', v_reserved; end if;
  raise notice '  exactly 1 winner, qty_reserved=4, no over-reservation, no deadlock';
end \$\$;" 2>&1 | sed 's/^psql:.*NOTICE:  //'
