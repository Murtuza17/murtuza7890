import { useState } from 'react'
import { humanizeAge } from '../domain/expiry'
import type { OutboxItem } from '../domain/outbox'
import type { Transfer } from '../domain/types'
import { enqueue } from '../data/sync'
import type { Session } from '../data/session'
import type { BoardModel } from './useBoard'
import { Empty, Note, Sheet } from './bits'

/**
 * Every transfer this clinic is part of, in either direction.
 *
 * Status is colour AND icon AND words, and the words are the ones the worker
 * saw on the button that got them here: Claim produces Claimed.
 */
const STATUS: Record<Transfer['status'], { label: string; icon: string; cls: string }> = {
  proposed:   { label: 'Offered — not claimed yet', icon: '·',  cls: 'band-watch' },
  accepted:   { label: 'Claimed — not sent yet',    icon: '◐',  cls: 'band-soon' },
  in_transit: { label: 'On the way',                icon: '→',  cls: 'band-critical' },
  completed:  { label: 'Handed over',               icon: '✓',  cls: 'band-ok' },
  declined:   { label: 'Declined',                  icon: '✕',  cls: 'band-watch' },
  cancelled:  { label: 'Cancelled',                 icon: '✕',  cls: 'band-watch' },
  expired:    { label: 'Expired — stock released',  icon: '⏱',  cls: 'band-watch' },
  disputed:   { label: 'Codes did not match',       icon: '!!', cls: 'band-expired' },
}

export function Transfers({
  model, session, now, outbox,
}: {
  model: BoardModel; session: Session; now: Date; outbox: readonly OutboxItem[]
}) {
  const [open, setOpen] = useState<string | null>(null)

  const mine = model.transfers.filter(
    (t) => t.fromClinicId === session.clinic.id || t.toClinicId === session.clinic.id,
  )
  const live = mine.filter((t) => !['completed', 'declined', 'cancelled', 'expired'].includes(t.status))
  const done = mine.filter((t) => ['completed', 'declined', 'cancelled', 'expired'].includes(t.status))

  if (mine.length === 0) {
    return (
      <Empty title="No transfers yet">
        When you claim medicine from another dispensary, the handoff codes appear here.
      </Empty>
    )
  }

  const transfer = open ? mine.find((tr) => tr.id === open) : undefined

  return (
    <>
      {live.length > 0 ? <div className="section-title">Needs attention</div> : null}
      {live.map((tr) => (
        <TransferCard key={tr.id} transfer={tr} model={model} session={session} now={now}
                      onOpen={() => setOpen(tr.id)} />
      ))}

      {done.length > 0 ? <div className="section-title">Finished</div> : null}
      {done.map((tr) => (
        <TransferCard key={tr.id} transfer={tr} model={model} session={session} now={now}
                      onOpen={() => setOpen(tr.id)} />
      ))}

      {transfer ? (
        <TransferSheet transfer={transfer} model={model} session={session}
                       outbox={outbox} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}

function TransferCard({
  transfer, model, session, now, onOpen,
}: {
  transfer: Transfer; model: BoardModel; session: Session; now: Date; onOpen: () => void
}) {
  const s = STATUS[transfer.status]
  const batch = model.batchesById.get(transfer.batchId)
  const drug = batch ? model.drugsById.get(batch.drugId) : undefined
  const outgoing = transfer.fromClinicId === session.clinic.id
  const other = model.clinicsById.get(outgoing ? transfer.toClinicId : transfer.fromClinicId)

  return (
    <div className="card">
      <div className="card-title">
        {/* Plain language: "Send 10 vials to Marur", not "Initiate transfer". */}
        {outgoing ? 'Send' : 'Collect'} {transfer.qty} {drug?.unit ?? 'vial'}s{' '}
        {outgoing ? 'to' : 'from'} {other?.village ?? 'another clinic'}
      </div>
      <div className="card-sub">{drug?.name ?? 'Medicine'} · {other?.name ?? ''}</div>

      <div style={{ marginTop: 10 }}>
        <span className={`pill ${s.cls}`}>
          <span className="pill-icon" aria-hidden="true">{s.icon}</span>{s.label}
        </span>
      </div>

      {transfer.status === 'accepted' && transfer.reservedUntil ? (
        <div className="card-meta">
          Held until {new Date(transfer.reservedUntil).toLocaleString()} — after that the
          stock goes back to {model.clinicsById.get(transfer.fromClinicId)?.village ?? 'the holder'}.
        </div>
      ) : null}

      {transfer.completedAt ? (
        <div className="card-meta">Handed over {humanizeAge(new Date(transfer.completedAt), now)}</div>
      ) : null}

      <button
        className={
          transfer.status === 'proposed' && transfer.toClinicId === session.clinic.id
            ? 'btn'
            : 'btn btn-quiet'
        }
        onClick={onOpen}
      >
        {transfer.status === 'proposed' && transfer.toClinicId === session.clinic.id
          ? `Claim ${transfer.qty} ${drug?.unit ?? 'vial'}s`
          : 'Open'}
      </button>
    </div>
  )
}

/**
 * The dual-party transfer pass.
 *
 * Both codes exist from the moment the claim is accepted, because the handoff
 * happens on a road with no signal and both phones must already hold their code
 * before either sets off. Each side reads the OTHER side's code back — echoing
 * your own proves only that you can read your own screen.
 */
function TransferSheet({
  transfer, model, session, outbox, onClose,
}: {
  transfer: Transfer; model: BoardModel; session: Session
  outbox: readonly OutboxItem[]; onClose: () => void
}) {
  const [entered, setEntered] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const outgoing = transfer.fromClinicId === session.clinic.id
  const side = outgoing ? 'sender' : 'receiver'
  const myCode = outgoing ? transfer.senderCode : transfer.receiverCode
  const other = model.clinicsById.get(outgoing ? transfer.toClinicId : transfer.fromClinicId)
  const batch = model.batchesById.get(transfer.batchId)
  const drug = batch ? model.drugsById.get(batch.drugId) : undefined

  const queued = outbox.find((i) => i.args['p_transfer_id'] === transfer.id && i.status !== 'done')
  const rejected = outbox.find(
    (i) => i.args['p_transfer_id'] === transfer.id && i.status === 'rejected',
  )

  const title = `${outgoing ? 'Send' : 'Collect'} ${transfer.qty} ${drug?.unit ?? 'vial'}s`

  return (
    <Sheet title={title} subtitle={`${drug?.name ?? ''} · ${other?.name ?? ''}`} onClose={onClose}>
      {rejected ? (
        <Note kind="error">
          <b>{rejected.lastError}</b>
          <div style={{ marginTop: 6, fontWeight: 400 }}>
            Nothing was reserved for you. Look for another dispensary on the Requests
            tab, or call {other?.phone ?? 'the holding clinic'}.
          </div>
        </Note>
      ) : null}
      {queued && !rejected ? (
        <Note kind="warn">Waiting to send — not confirmed yet.</Note>
      ) : null}

      {transfer.status === 'disputed' ? (
        <Note kind="error">
          The two codes did not match, so nothing was recorded as handed over.
          Both dispensaries can see the full record. Call {other?.phone ?? 'the other clinic'}.
        </Note>
      ) : null}

      {myCode ? (
        <>
          <div className="codebox">
            <div className="codebox-label">Read this number aloud</div>
            <div className="codebox-code">{myCode}</div>
          </div>
          <div className="card-meta">
            Say your number to the other person. Type <b>their</b> number below.
            Works with no signal — both phones remember, and they match up later.
          </div>
        </>
      ) : rejected ? null : (
        <Note kind="info">
          Codes appear once this is claimed. Nothing has been reserved yet.
        </Note>
      )}

      {/* An offer made TO this clinic. Claiming is contested — two clinics can
          be looking at this same screen for the same four vials — so the server
          arbitrates and the loser gets told who won. */}
      {!outgoing && transfer.status === 'proposed' && !rejected ? (
        <>
          <button
            className="btn" disabled={busy || Boolean(queued)}
            onClick={async () => {
              setBusy(true)
              await enqueue('accept_transfer', { p_transfer_id: transfer.id })
              setBusy(false)
            }}
          >
            {busy ? 'Claiming…' : `Claim ${transfer.qty} ${drug?.unit ?? 'vial'}s`}
          </button>
          <button
            className="btn btn-quiet" disabled={busy || Boolean(queued)}
            onClick={async () => {
              setBusy(true)
              await enqueue('decline_transfer', { p_transfer_id: transfer.id, p_note: '' })
              setBusy(false)
            }}
          >
            We do not need this
          </button>
        </>
      ) : null}

      {/* Sender dispatches. Confirmation first: the vials leave the shelf now. */}
      {outgoing && transfer.status === 'accepted' ? (
        confirming ? (
          <>
            <Note kind="warn">
              This records {transfer.qty} {drug?.unit ?? 'vial'}s as leaving your shelf now.
            </Note>
            {/* Guarded by `queued`, not just `busy`: `busy` clears the instant
                the action is written to IndexedDB, well before it syncs. Without
                this a worker who reopens the sheet while offline can queue a
                second dispatch_transfer for the same transfer — the first
                succeeds on drain, the second then hits the server's own
                wrong_state check and surfaces as a spurious "not accepted"
                error over an action that in fact already worked. */}
            <button className="btn" disabled={busy || Boolean(queued)}
                    onClick={async () => {
                      setBusy(true)
                      await enqueue('dispatch_transfer', {
                        p_transfer_id: transfer.id, p_client_ts: new Date().toISOString(),
                      })
                      setBusy(false); setConfirming(false)
                    }}>
              {busy ? 'Recording…' : 'Yes, they have left'}
            </button>
            <button className="btn btn-quiet" onClick={() => setConfirming(false)}>Not yet</button>
          </>
        ) : (
          <button className="btn" onClick={() => setConfirming(true)}>
            Hand over {transfer.qty} {drug?.unit ?? 'vial'}s
          </button>
        )
      ) : null}

      {transfer.status === 'in_transit' ? (
        <>
          <div className="field">
            <label htmlFor="code">
              Their number <span className="hint">6 digits</span>
            </label>
            <input id="code" className="input pin" inputMode="numeric" maxLength={6}
                   value={entered}
                   onChange={(e) => setEntered(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button
            className="btn" disabled={entered.length !== 6 || busy || Boolean(queued)}
            onClick={async () => {
              setBusy(true)
              await enqueue('confirm_handoff', {
                p_transfer_id: transfer.id, p_side: side, p_code: entered,
                p_client_ts: new Date().toISOString(),
              })
              setBusy(false); setEntered('')
            }}
          >
            {busy ? 'Recording…' : 'Confirm the handover'}
          </button>
          <div className="card-meta">
            If only one side confirms, this stays “On the way” on both boards until
            the other phone gets signal. Nothing is marked handed over until both agree.
          </div>
        </>
      ) : null}

      {/* Only the claiming clinic can give the stock back. */}
      {!outgoing && transfer.status === 'accepted' ? (
        <button
          className="btn btn-danger" disabled={busy || Boolean(queued)}
          onClick={async () => {
            setBusy(true)
            await enqueue('cancel_transfer', { p_transfer_id: transfer.id, p_note: '' })
            setBusy(false)
          }}
        >
          Give this back — we do not need it
        </button>
      ) : null}

      <TransferTrail transfer={transfer} model={model} />

      <button className="btn btn-quiet" onClick={onClose}>Close</button>
    </Sheet>
  )
}

/**
 * The record both clinics point at when a handoff goes wrong.
 *
 * Read from the append-only `events` log rather than reconstructed from the
 * transfer's own timestamps. That difference matters for a dispute: the log
 * holds the things the row cannot — which clinic was refused and why, which
 * side reported which code, when a reservation lapsed. Spec §4 asks for a
 * dispute to be surfaced with the FULL trail, and a row that has been updated
 * in place is not a trail.
 *
 * Nothing here is ever deleted, so shrinkage stays visible between parties who
 * do not report to each other.
 */
const EVENT_TEXT: Record<string, (p: Record<string, unknown>) => string> = {
  transfer_accepted: () => 'Claimed — stock reserved, codes issued',
  transfer_declined: () => 'Declined',
  transfer_dispatched: (p) => `Left the shelf${p['qty'] ? ` — ${String(p['qty'])} vials` : ''}`,
  transfer_confirmed: (p) => `${p['side'] === 'sender' ? 'Sender' : 'Receiver'} confirmed the handover`,
  transfer_completed: () => 'Both clinics confirmed — handed over',
  transfer_disputed: (p) =>
    p['reported']
      ? `Codes did not match — ${String(p['side'])} read ${String(p['reported'])}, expected ${String(p['expected'])}`
      : 'Codes did not match',
  transfer_cancelled: () => 'Given back',
  transfer_expired: () => 'Not collected in 24 hours — stock released',
  claim_rejected: (p) => `Claim refused — ${String(p['message'] ?? 'stock already committed')}`,
}

function TransferTrail({ transfer, model }: { transfer: Transfer; model: BoardModel }) {
  const from = model.clinicsById.get(transfer.fromClinicId)
  const events = model.eventsByEntity.get(transfer.id) ?? []

  return (
    <>
      <div className="section-title">What happened</div>
      <ul className="trail">
        <li>
          <b>Offered by {from?.village ?? 'the holding clinic'}</b>
          {` — ${new Date(transfer.createdAt).toLocaleString()}`}
        </li>
        {events.map((e) => {
          const actor = e.actorClinicId ? model.clinicsById.get(e.actorClinicId) : undefined
          const describe = EVENT_TEXT[e.type]
          return (
            <li key={e.id}>
              <b>{describe ? describe(e.payload as Record<string, unknown>) : e.type}</b>
              {actor ? ` · ${actor.village}` : ''}
              {` — ${new Date(e.serverTs).toLocaleString()}`}
            </li>
          )
        })}
        {events.length === 0 ? <li>Nothing has happened yet.</li> : null}
      </ul>
    </>
  )
}
