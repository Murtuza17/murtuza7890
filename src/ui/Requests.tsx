import { useState } from 'react'
import { findMatches, formatKm, planFulfilment, type Match } from '../domain/matching'
import { humanizeExpiry } from '../domain/expiry'
import { enqueue } from '../data/sync'
import type { OutboxItem } from '../domain/outbox'
import type { StockRequest } from '../domain/types'
import type { Session } from '../data/session'
import type { BoardModel } from './useBoard'
import { Empty, Note, Sheet } from './bits'

const URGENCY: Record<StockRequest['urgency'], { label: string; icon: string; cls: string }> = {
  outbreak: { label: 'Outbreak', icon: '!!', cls: 'band-expired' },
  urgent: { label: 'Urgent', icon: '!', cls: 'band-critical' },
  routine: { label: 'Routine', icon: '•', cls: 'band-watch' },
}

/**
 * Open shortages across the district, and — for your own requests — who nearby
 * can fill them.
 */
export function Requests({
  model, session, now, outbox,
}: { model: BoardModel; session: Session; now: Date; outbox: readonly OutboxItem[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  const live = model.requests.filter((r) => r.status === 'open' || r.status === 'partially_filled')
  const mine = live.filter((r) => r.clinicId === session.clinic.id)
  const others = live.filter((r) => r.clinicId !== session.clinic.id)

  const request = open ? model.requests.find((r) => r.id === open) : undefined

  return (
    <>
      <button className="btn" onClick={() => setPosting(true)} style={{ marginTop: 0 }}>
        Ask for medicine
      </button>

      <div className="section-title">Your requests</div>
      {mine.length === 0 ? (
        <Empty title="You have not asked for anything">
          Post a shortage and nearby dispensaries holding that medicine will appear here.
        </Empty>
      ) : (
        mine.map((r) => (
          <RequestCard key={r.id} request={r} model={model} mine onOpen={() => setOpen(r.id)} />
        ))
      )}

      <div className="section-title">Other villages need</div>
      {others.length === 0 ? (
        <Empty title="No open shortages nearby">
          Nothing is being asked for right now across the district.
        </Empty>
      ) : (
        others.map((r) => (
          <RequestCard key={r.id} request={r} model={model} onOpen={() => setOpen(r.id)} />
        ))
      )}

      {request ? (
        <MatchSheet request={request} model={model} session={session} now={now}
                    outbox={outbox} onClose={() => setOpen(null)} />
      ) : null}

      {posting ? (
        <PostSheet model={model} onClose={() => setPosting(false)} />
      ) : null}
    </>
  )
}

function RequestCard({
  request, model, mine, onOpen,
}: {
  request: StockRequest; model: BoardModel; mine?: boolean; onOpen: () => void
}) {
  const drug = model.drugsById.get(request.drugId)
  const clinic = model.clinicsById.get(request.clinicId)
  const u = URGENCY[request.urgency]

  return (
    <div className="card">
      <div className="card-head">
        <div style={{ flex: 1 }}>
          <div className="card-title">
            {request.qtyNeeded} {drug?.unit ?? 'vial'}s — {drug?.name ?? 'medicine'}
          </div>
          <div className="card-sub">
            {mine ? 'Your request' : `${clinic?.name ?? 'A clinic'} · ${clinic?.village ?? ''}`}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className={`pill ${u.cls}`}>
          <span className="pill-icon" aria-hidden="true">{u.icon}</span>{u.label}
        </span>
        <span className="pill band-watch">
          <span className="pill-icon" aria-hidden="true">◎</span>within {request.radiusKm} km
        </span>
      </div>

      {request.note ? <div className="card-meta">“{request.note}”</div> : null}

      <button className="btn btn-quiet" onClick={onOpen}>
        {mine ? 'See who can help' : 'See this request'}
      </button>
    </div>
  )
}

/**
 * Matches, each carrying the reason it surfaced.
 *
 * An opaque ranking is useless to someone deciding whether to send a colleague
 * 30 km on a motorbike, so every row says distance, expiry and quantity.
 */
function MatchSheet({
  request, model, session, now, outbox, onClose,
}: {
  request: StockRequest; model: BoardModel; session: Session; now: Date
  outbox: readonly OutboxItem[]; onClose: () => void
}) {
  const [claiming, setClaiming] = useState<string | null>(null)
  const drug = model.drugsById.get(request.drugId)
  const requestingClinic = model.clinicsById.get(request.clinicId)

  if (!drug || !requestingClinic) return null

  // availableByBatch is the server's own SUM(delta) view, not a possibly-
  // truncated local movement list — see matching.ts's MatchInput doc. Passed
  // straight in, rather than corrected after the fact: a batch this excludes
  // for lacking stock must never have been considered available in the first
  // place, which a post-hoc correction here could not undo once findMatches
  // had already dropped it.
  const { matches, excluded } = findMatches({
    request, requestingClinic, drug,
    batches: model.batches, clinicsById: model.clinicsById,
    availableByBatch: model.availableByBatch, now,
  })

  const plan = planFulfilment(request, matches)
  const isMine = request.clinicId === session.clinic.id
  const coldChainDropped = excluded.filter((e) => e.reason === 'cold_chain_broken').length

  return (
    <Sheet
      title={`${request.qtyNeeded} ${drug.unit}s of ${drug.name}`}
      subtitle={`Needed by ${request.neededBy} · within ${request.radiusKm} km`}
      onClose={onClose}
    >
      {matches.length === 0 ? (
        <Empty title="Nothing available within that distance">
          Try again with a wider radius, or ask the district office.
        </Empty>
      ) : (
        <>
          {plan.complete ? (
            <Note kind="info">
              {plan.allocations.length === 1
                ? 'One dispensary can fill this in full.'
                : `${plan.allocations.length} dispensaries together can fill this in full.`}
            </Note>
          ) : (
            <Note kind="warn">
              Nearby clinics can supply {plan.qtyPlanned} of {request.qtyNeeded}.
              {' '}Still short {plan.qtyShort}.
            </Note>
          )}

          {matches.map((m) => (
            <div key={m.batchId} className="card" style={{ marginTop: 12 }}>
              <div className="card-title">{m.clinicName}</div>
              <div className="card-sub">{m.village} · batch {m.batchNo}</div>

              {/* The "why" — spec §6. Never surface a match without it. */}
              <div className="card-meta" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                {formatKm(m.distanceKm)} · {humanizeExpiry(m.expiryDate, now)} ·{' '}
                {m.availableQty} {drug.unit}s free
              </div>

              {m.solvesBoth ? (
                <div className="flag">
                  <span aria-hidden="true">★</span>
                  Helps both — would be wasted here, and arrives before you need it
                </div>
              ) : null}

              {!m.arrivesInTime ? (
                <div className="flag">
                  <span aria-hidden="true">!</span>
                  Expires before {request.neededBy} — use it straight away
                </div>
              ) : null}

              {m.needsColdBox ? (
                <div className="flag">
                  <span aria-hidden="true">❄</span>
                  Send a cold box — {formatKm(m.distanceKm)} is too far unrefrigerated
                </div>
              ) : null}

              {isMine ? (
                <ClaimButton
                  match={m} request={request} unit={drug.unit} outbox={outbox}
                  busy={claiming === m.batchId}
                  onClaim={async (qty) => {
                    setClaiming(m.batchId)
                    // Contested: the server arbitrates. The UI will say
                    // "Waiting to send" until it answers.
                    await enqueue('claim_from_match', {
                      p_batch_id: m.batchId, p_qty: qty, p_request_id: request.id,
                    })
                    setClaiming(null)
                  }}
                />
              ) : null}
            </div>
          ))}
        </>
      )}

      {coldChainDropped > 0 ? (
        <div className="flag flag-quiet">
          <span aria-hidden="true">❄</span>
          {coldChainDropped} nearby {coldChainDropped === 1 ? 'batch was' : 'batches were'} hidden —
          cold chain broken, so they would arrive useless
        </div>
      ) : null}

      <button className="btn btn-quiet" onClick={onClose}>Close</button>
    </Sheet>
  )
}

/**
 * The button says Claim and the state it produces says Claimed. The same action
 * keeps the same name the whole way through — spec §7.
 */
function ClaimButton({
  match, request, unit, outbox, busy, onClaim,
}: {
  match: Match; request: StockRequest; unit: string
  outbox: readonly OutboxItem[]; busy: boolean; onClaim: (qty: number) => Promise<void>
}) {
  const queued = outbox.find(
    (i) => i.op === 'claim_from_match' && i.args['p_batch_id'] === match.batchId,
  )

  if (queued && queued.status === 'rejected') {
    return <Note kind="error">{queued.lastError}</Note>
  }
  if (queued && queued.status !== 'done') {
    // Never "Claimed" before the server has said so.
    return <Note kind="warn">Waiting to send — this is not confirmed yet.</Note>
  }
  if (queued?.status === 'done') {
    return <Note kind="info">Claimed. See the Transfers tab for the handoff codes.</Note>
  }

  const qty = Math.min(match.availableQty, request.qtyNeeded)
  return (
    <button className="btn" disabled={busy} onClick={() => void onClaim(qty)}>
      {busy ? 'Claiming…' : `Claim ${qty} ${unit}s`}
    </button>
  )
}

function PostSheet({ model, onClose }: { model: BoardModel; onClose: () => void }) {
  const [drugId, setDrugId] = useState('')
  const [qty, setQty] = useState('')
  const [urgency, setUrgency] = useState<StockRequest['urgency']>('urgent')
  const [radius, setRadius] = useState('40')
  const [days, setDays] = useState('3')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const n = Number(qty)
  const valid = drugId !== '' && Number.isInteger(n) && n > 0

  return (
    <Sheet title="Ask for medicine" onClose={onClose}>
      <div className="field">
        <label htmlFor="drug">Which medicine?</label>
        {/* A controlled list, never free text: "FMD vaccine" and "Foot & Mouth
            vaccine" would never match each other, and a shortage that fails to
            match is the whole problem. */}
        <select id="drug" className="input" value={drugId}
                onChange={(e) => setDrugId(e.target.value)}>
          <option value="">Choose from the list…</option>
          {model.drugs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="need">How many?</label>
        <input id="need" className="input" inputMode="numeric" value={qty}
               onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
      </div>

      <div className="field">
        <label htmlFor="urg">How urgent?</label>
        <select id="urg" className="input" value={urgency}
                onChange={(e) => setUrgency(e.target.value as StockRequest['urgency'])}>
          <option value="outbreak">Outbreak — animals are sick now</option>
          <option value="urgent">Urgent — needed in a day or two</option>
          <option value="routine">Routine — planned camp or top-up</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="rad">How far can someone travel? <span className="hint">km</span></label>
        <select id="rad" className="input" value={radius} onChange={(e) => setRadius(e.target.value)}>
          {['10', '20', '40', '60'].map((r) => <option key={r} value={r}>{r} km</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="by">Needed within</label>
        <select id="by" className="input" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="1">Today or tomorrow</option>
          <option value="3">3 days</option>
          <option value="7">A week</option>
          <option value="14">Two weeks</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="note">Anything else? <span className="hint">optional</span></label>
        <input id="note" className="input" value={note} maxLength={140}
               placeholder="Suspected FMD in two herds at Peddapur"
               onChange={(e) => setNote(e.target.value)} />
      </div>

      <button
        className="btn" disabled={!valid || busy}
        onClick={async () => {
          setBusy(true)
          const by = new Date(Date.now() + Number(days) * 86_400_000)
          await enqueue('create_request', {
            p_drug_id: drugId, p_qty_needed: n, p_urgency: urgency,
            p_radius_km: Number(radius), p_needed_by: by.toISOString().slice(0, 10),
            p_note: note,
          })
          onClose()
        }}
      >
        {busy ? 'Posting…' : 'Post this request'}
      </button>
      <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
    </Sheet>
  )
}
