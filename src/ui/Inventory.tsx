import { useState } from 'react'
import { bandFor } from '../domain/expiry'
import { enqueue } from '../data/sync'
import type { Session } from '../data/session'
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

  const mine = model.batches
    .filter((b) => b.clinicId === session.clinic.id)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))

  if (mine.length === 0) {
    return (
      <Empty title="No stock logged yet">
        Add your first batch to let nearby dispensaries see what you can spare.
      </Empty>
    )
  }

  const batch = logging ? model.batchesById.get(logging) : undefined
  const drug = batch ? model.drugsById.get(batch.drugId) : undefined

  return (
    <>
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

      {batch && drug ? (
        <LogSheet
          batchNo={batch.batchNo}
          drugName={drug.name}
          unit={drug.unit}
          available={model.availableByBatch.get(batch.id) ?? 0}
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
] as const

function LogSheet({
  batchNo, drugName, unit, available, onClose, onSubmit,
}: {
  batchNo: string; drugName: string; unit: string; available: number
  onClose: () => void; onSubmit: (delta: number, reason: string) => Promise<void>
}) {
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState<string>('dispensed')
  const [busy, setBusy] = useState(false)

  const n = Number(qty)
  const valid = Number.isInteger(n) && n > 0
  const tooMany = valid && reason !== 'correction' && n > available

  return (
    <Sheet title={`Record use — ${drugName}`} subtitle={`Batch ${batchNo}`} onClose={onClose}>
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
                onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>

      {tooMany ? (
        <Note kind="error">
          Only {available} {unit}s are free — the rest are promised to another clinic.
          Choose “Correcting a count” if the shelf really is short.
        </Note>
      ) : null}

      <button
        className="btn"
        disabled={!valid || tooMany || busy}
        onClick={async () => {
          setBusy(true)
          // Corrections can go either way; every other reason removes stock.
          await onSubmit(reason === 'correction' ? -n : -n, reason)
        }}
      >
        {busy ? 'Saving…' : `Record ${qty || '0'} ${unit}s`}
      </button>
      <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
    </Sheet>
  )
}
