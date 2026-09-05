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
}: { model: BoardModel; session: Session; now: Date; outbox: readonly OutboxItem[] }) {
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

  const transfer = open ? mine.find((t) => t.id === open) : undefined

  return (
    <>
      {live.length > 0 ? <div className="section-title">Needs attention</div> : null}
      {live.map((t) => (
        <TransferCard key={t.id} transfer={t} model={model} session={session} now={now}
                      onOpen={() => setOpen(t.id)} />
      ))}

      {done.length > 0 ? <div className="section-title">Finished</div> : null}
      {done.map((t) => (
        <TransferCard key={t.id} transfer={t} model={model} session={session} now={now}
                      onOpen={() => setOpen(t.id)} />
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
            <button className="btn" disabled={busy}
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
            className="btn" disabled={entered.length !== 6 || busy}
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
          className="btn btn-danger" disabled={busy}
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

/** The record both clinics can point at when a handoff goes wrong. */
function TransferTrail({ transfer, model }: { transfer: Transfer; model: BoardModel }) {
  const from = model.clinicsById.get(transfer.fromClinicId)
  const to = model.clinicsById.get(transfer.toClinicId)

  const steps: Array<[string, string | null]> = [
    ['Offered by ' + (from?.village ?? 'holder'), transfer.createdAt],
    ['Claimed by ' + (to?.village ?? 'clinic'), transfer.acceptedAt],
    ['Left ' + (from?.village ?? 'the clinic'), transfer.dispatchedAt],
    ['Handed over', transfer.completedAt],
  ]

  return (
    <>
      <div className="section-title">What happened</div>
      <ul className="trail">
        {steps.map(([label, at]) => (
          <li key={label}>
            <b>{label}</b>
            {at ? ` — ${new Date(at).toLocaleString()}` : ' — not yet'}
          </li>
        ))}
      </ul>
    </>
  )
}
