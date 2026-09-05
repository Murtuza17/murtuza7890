import { useState } from 'react'
import { bandFor } from '../domain/expiry'
import { validateMovement } from '../domain/ledger'
import { enqueue } from '../data/sync'
import type { Session } from '../data/session'
import type { Batch, MovementReason, StockMovement } from '../domain/types'
import type { BoardModel } from './useBoard'
import { Empty, ExpiryPill, Note, Qty, Sheet } from './bits'

/**
 * The clinic's own shelf.
 *
 * Sorted by expiry, soonest first — the whole product exists because things
 * expire unnoticed, so the thing about to be wasted is the thing that must be
 * at the top of the screen.
 */
export function Inventory({
  model, session, now,
}: { model: BoardModel; session: Session; now: Date }) {
  const [logging, setLogging] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const mine = model.batches
    .filter((b) => b.clinicId === session.clinic.id)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))

  const batch = logging ? model.batchesById.get(logging) : undefined
  const drug = batch ? model.drugsById.get(batch.drugId) : undefined

  if (mine.length === 0) {
    return (
      <>
        <Empty title="No stock logged yet">
          Add your first batch so nearby dispensaries can see what you could spare.
        </Empty>
        <button className="btn" onClick={() => setAdding(true)}>Add a batch</button>
        {adding ? <AddSheet model={model} onClose={() => setAdding(false)} /> : null}
      </>
    )
  }

  return (
    <>
      <button className="btn" style={{ marginTop: 0 }} onClick={() => setAdding(true)}>
        Add a batch
      </button>

      <div className="section-title">Your stock · {mine.length} batches</div>

      {mine.map((b) => {
        const d = model.drugsById.get(b.drugId)
        const onHand = model.onHandByBatch.get(b.id) ?? 0
        const available = model.availableByBatch.get(b.id) ?? 0
        const reserved = onHand - available
        const band = bandFor(b.expiryDate, now)

        return (
          <div key={b.id} className={`card left-rule band-${band}`}>
            <div className="card-head">
              <div style={{ flex: 1 }}>
                <div className="card-title">{d?.name ?? 'Unknown medicine'}</div>
                <div className="card-sub">Batch {b.batchNo}</div>
              </div>
              <Qty n={onHand} unit={d?.unit ?? 'vial'} />
            </div>

            <div style={{ marginTop: 10 }}>
              <ExpiryPill date={b.expiryDate} now={now} />
            </div>

            {reserved > 0 ? (
              <div className="flag">
                <span aria-hidden="true">→</span>
                {reserved} promised to another clinic · {available} free
              </div>
            ) : null}

            {b.status === 'quarantined' ? (
              <div className="flag">
                <span aria-hidden="true">!</span>
                Cold chain broken — quarantined, not offered to other clinics
              </div>
            ) : null}

            <button className="btn btn-quiet" onClick={() => setLogging(b.id)}>
              Record use of this batch
            </button>
          </div>
        )
      })}

      {adding ? <AddSheet model={model} onClose={() => setAdding(false)} /> : null}

      {batch && drug ? (
        <LogSheet
          batch={batch}
          drugName={drug.name}
          unit={drug.unit}
          available={model.availableByBatch.get(batch.id) ?? 0}
          movements={model.movementsByBatch.get(batch.id) ?? []}
          onClose={() => setLogging(null)}
          onSubmit={async (delta, reason) => {
            // Own-clinic action: uncontested, so it applies immediately and
            // syncs whenever there is signal.
            await enqueue('log_movement', {
              p_batch_id: batch.id, p_delta: delta, p_reason: reason,
              p_client_ts: new Date().toISOString(),
            })
            setLogging(null)
          }}
        />
      ) : null}
    </>
  )
}

const REASONS = [
  { value: 'dispensed', label: 'Given to animals' },
  { value: 'wasted', label: 'Spoiled or broken' },
  { value: 'expired', label: 'Past expiry, discarded' },
  { value: 'correction', label: 'Correcting a count' },
] as const satisfies readonly { value: MovementReason; label: string }[]

function LogSheet({
  batch, drugName, unit, available, movements, onClose, onSubmit,
}: {
  batch: Batch; drugName: string; unit: string; available: number
  movements: readonly StockMovement[]
  onClose: () => void; onSubmit: (delta: number, reason: MovementReason) => Promise<void>
}) {
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState<MovementReason>('dispensed')
  // Only a correction can go either direction — dispensed/wasted/expired
  // always remove stock. A correction defaults to "fewer": undercounting from
  // shrinkage is the far more common real-world case than finding extra
  // vials, but this is a genuine choice, never silently assumed.
  const [direction, setDirection] = useState<'fewer' | 'more'>('fewer')
  const [busy, setBusy] = useState(false)

  const n = Number(qty)
  const validQty = Number.isInteger(n) && n > 0
  const delta = !validQty ? 0 : reason === 'correction' && direction === 'more' ? n : -n

  // The same rule the server enforces (log_movement in
  // supabase/migrations/0002_functions.sql), checked here first so a worker
  // sees the problem before tapping Save rather than after a round trip on a
  // bad connection. The server re-checks against its own fresh data
  // regardless — this is a UX courtesy, not the actual guarantee.
  const check = validQty ? validateMovement(batch, movements, delta, reason) : null
  const blocked = check !== null && !check.ok

  return (
    <Sheet title={`Record use — ${drugName}`} subtitle={`Batch ${batch.batchNo}`} onClose={onClose}>
      <div className="field">
        <label htmlFor="qty">
          How many {unit}s? <span className="hint">{available} free to use</span>
        </label>
        <input
          id="qty" className="input" inputMode="numeric" value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
        />
      </div>

      <div className="field">
        <label htmlFor="reason">What happened?</label>
        <select id="reason" className="input" value={reason}
                onChange={(e) => setReason(e.target.value as MovementReason)}>
          {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>

      {reason === 'correction' ? (
        <div className="field">
          <label>Which way is the count wrong?</label>
          <div className="btn-row">
            <button
              type="button" className={direction === 'fewer' ? 'btn' : 'btn btn-quiet'}
              onClick={() => setDirection('fewer')}
            >
              Shelf has fewer
            </button>
            <button
              type="button" className={direction === 'more' ? 'btn' : 'btn btn-quiet'}
              onClick={() => setDirection('more')}
            >
              Shelf has more
            </button>
          </div>
        </div>
      ) : null}

      {blocked && check.reason === 'would_go_negative' ? (
        <Note kind="error">
          Only {check.onHand} {unit}s are on this shelf — cannot remove {check.requested}.
        </Note>
      ) : blocked && check.reason === 'reserved_stock' ? (
        <Note kind="error">
          Only {check.available} {unit}s are free — the rest are promised to another clinic.
          Choose “Correcting a count” if the shelf really is short.
        </Note>
      ) : null}

      <button
        className="btn"
        disabled={!validQty || blocked || busy}
        onClick={async () => {
          setBusy(true)
          await onSubmit(delta, reason)
        }}
      >
        {busy ? 'Saving…' : `Record ${qty || '0'} ${unit}s`}
      </button>
      <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

/**
 * Must-build #1: log inventory with vial count, batch number, cold-storage
 * status and expiry date.
 *
 * The medicine comes from the controlled catalogue, never free text — see
 * supabase/migrations/0001_schema.sql for why that is a trust safeguard rather
 * than a convenience.
 */
function AddSheet({ model, onClose }: { model: BoardModel; onClose: () => void }) {
  const [drugId, setDrugId] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [qty, setQty] = useState('')
  const [expiry, setExpiry] = useState('')
  const [coldOk, setColdOk] = useState(true)
  const [busy, setBusy] = useState(false)

  const drug = model.drugsById.get(drugId)
  const n = Number(qty)
  const valid = drugId !== '' && batchNo.trim() !== '' && Number.isInteger(n) && n > 0 && expiry !== ''
  const past = expiry !== '' && expiry < new Date().toISOString().slice(0, 10)

  return (
    <Sheet title="Add a batch" subtitle="What arrived, and when does it expire?" onClose={onClose}>
      <div className="field">
        <label htmlFor="a-drug">Which medicine?</label>
        <select id="a-drug" className="input" value={drugId}
                onChange={(e) => setDrugId(e.target.value)}>
          <option value="">Choose from the list…</option>
          {model.drugs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="a-no">Batch number <span className="hint">printed on the vial</span></label>
        <input id="a-no" className="input" value={batchNo} autoCapitalize="characters"
               placeholder="FMD-2411-A"
               onChange={(e) => setBatchNo(e.target.value.toUpperCase())} />
      </div>

      <div className="field">
        <label htmlFor="a-qty">How many {drug?.unit ?? 'vial'}s?</label>
        <input id="a-qty" className="input" inputMode="numeric" value={qty}
               onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
      </div>

      <div className="field">
        <label htmlFor="a-exp">Expiry date</label>
        <input id="a-exp" className="input" type="date" value={expiry}
               onChange={(e) => setExpiry(e.target.value)} />
      </div>

      {past ? (
        <Note kind="warn">
          That date has already passed. This batch will be logged as expired and will
          not be offered to other clinics.
        </Note>
      ) : null}

      {drug?.requiresColdChain ? (
        <div className="field">
          <label htmlFor="a-cold">
            Cold storage <span className="hint">this medicine must stay 2–8°C</span>
          </label>
          <select id="a-cold" className="input" value={coldOk ? 'yes' : 'no'}
                  onChange={(e) => setColdOk(e.target.value === 'yes')}>
            <option value="yes">Kept cold the whole time</option>
            <option value="no">Cold chain was broken</option>
          </select>
          {!coldOk ? (
            <Note kind="warn">
              This batch will be quarantined and never offered to another clinic.
              A vaccine that arrives inert is worse than none — the herd goes on
              the register as protected.
            </Note>
          ) : null}
        </div>
      ) : null}

      <button
        className="btn" disabled={!valid || busy}
        onClick={async () => {
          setBusy(true)
          await enqueue('create_batch', {
            p_drug_id: drugId, p_batch_no: batchNo.trim(), p_expiry_date: expiry,
            p_cold_chain_ok: drug?.requiresColdChain ? coldOk : true,
            p_qty: n, p_client_ts: new Date().toISOString(),
          })
          onClose()
        }}
      >
        {busy ? 'Saving…' : `Add ${qty || '0'} ${drug?.unit ?? 'vial'}s`}
      </button>
      <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
    </Sheet>
  )
}
