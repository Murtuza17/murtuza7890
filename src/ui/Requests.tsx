import { useState } from 'react'
import { findMatches, formatKm, planFulfilment, type Match } from '../domain/matching'
import { anticipateTransfers, bestPerNeed, type AnticipatedTransfer } from '../domain/anticipate'
import { humanizeExpiry } from '../domain/expiry'
import { t, type Lang } from '../domain/i18n'
import { enqueue } from '../data/sync'
import { parseRequestText } from '../data/intake'
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
  model, session, now, outbox, lang = 'en',
}: {
  model: BoardModel; session: Session; now: Date; outbox: readonly OutboxItem[]; lang?: Lang
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  const live = model.requests.filter((r) => r.status === 'open' || r.status === 'partially_filled')
  const mine = live.filter((r) => r.clinicId === session.clinic.id)
  const others = live.filter((r) => r.clinicId !== session.clinic.id)

  const request = open ? model.requests.find((r) => r.id === open) : undefined

  // Suggestions nobody asked for: a forecast of waste here paired against a
  // forecast of stockout there. This is the only part of the board that acts
  // before a human has noticed anything.
  const suggestions = bestPerNeed(anticipateTransfers({
    positions: model.positions,
    clinicsById: model.clinicsById,
    drugsById: model.drugsById,
    radiusKm: 40,
    now,
  })).filter((s) => s.fromClinicId === session.clinic.id || s.toClinicId === session.clinic.id)

  // Real-world outbreak detection: surface any clinic whose 14-day consumption
  // is surging at 2x+ baseline so nearby staff can prepare before shortages hit.
  const surges = model.positions.filter(
    (p) => p.signal.trend === 'surging' && p.signal.confidence !== 'none',
  )

  return (
    <>
      {surges.length > 0 ? (
        <div className="card left-rule band-expired" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="pill band-expired" style={{ padding: '2px 8px' }}>
              <span className="pill-icon" aria-hidden="true">!!</span>{t('outbreakAlert', lang)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              Usage surge detected in district
            </span>
          </div>
          {surges.map((s) => {
            const clinic = model.clinicsById.get(s.clinicId)
            const drug = model.drugsById.get(s.drugId)
            const unit = drug?.unit ?? 'vial'
            const rate7d = Math.round(s.signal.recentRate * 7 * 10) / 10
            const baseline7d = Math.round(s.signal.dailyRate * 7 * 10) / 10
            const ratio = baseline7d > 0 ? Math.round((rate7d / baseline7d) * 10) / 10 : 2
            const isMine = s.clinicId === session.clinic.id

            return (
              <div key={`${s.clinicId}:${s.drugId}`} style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 650, fontSize: 14.5 }}>
                  {isMine ? 'Your clinic' : clinic?.name ?? clinic?.village} is using {drug?.name} at {ratio}× normal rate
                </div>
                <div className="card-meta">
                  Using ~{rate7d} {unit}s/week over last 14 days (baseline: ~{baseline7d} {unit}s/week).
                  {isMine
                    ? ' Consider posting an urgent shortage request below.'
                    : ` Expect emergency requests from ${clinic?.village ?? 'this village'}.`}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      <button className="btn" onClick={() => setPosting(true)} style={{ marginTop: 0 }}>
        {t('askForMedicine', lang)}
      </button>

      {suggestions.length > 0 ? (
        <>
          <div className="section-title">
            {t('worthDoingNow', lang)}
          </div>
          {suggestions.map((s) => (
            <SuggestionCard
              key={`${s.batchId}:${s.toClinicId}`}
              suggestion={s}
              outgoing={s.fromClinicId === session.clinic.id}
              model={model}
              outbox={outbox}
              now={now}
            />
          ))}
        </>
      ) : null}

      <div className="section-title">{t('yourRequests', lang)}</div>
      {mine.length === 0 ? (
        <Empty title="You have not asked for anything">
          Post a shortage and nearby dispensaries holding that medicine will appear here.
        </Empty>
      ) : (
        mine.map((r) => (
          <RequestCard key={r.id} request={r} model={model} mine onOpen={() => setOpen(r.id)} />
        ))
      )}

      <div className="section-title">{t('otherVillagesNeed', lang)}</div>
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
        <PostSheet model={model} lang={lang} onClose={() => setPosting(false)} />
      ) : null}
    </>
  )
}

/**
 * A transfer the board worked out on its own.
 *
 * Everything about how this reads is deliberate. It leads with the action in
 * plain language, states the forecast it rests on in the next line so a worker
 * can disagree with the reasoning rather than just the conclusion, and marks
 * itself a prediction — never a fact. A forecast dressed up as a certainty is
 * how someone ends up riding 30 km on a guess.
 */
function SuggestionCard({
  suggestion, outgoing, model, outbox, now,
}: {
  suggestion: AnticipatedTransfer; outgoing: boolean; model: BoardModel
  outbox: readonly OutboxItem[]; now: Date
}) {
  const [busy, setBusy] = useState(false)
  const unit = model.drugsById.get(suggestion.drugId)?.unit ?? 'vial'

  // Check if a request was already queued from this suggestion (by matching
  // drug + qty — good enough to dedupe within a session).
  const queued = outbox.find(
    (i) =>
      i.op === 'create_request' &&
      i.args['p_drug_id'] === suggestion.drugId &&
      i.args['p_qty_needed'] === suggestion.qty &&
      (i.args as Record<string, unknown>)['_from_suggestion'] === suggestion.batchId,
  )

  async function askForThis() {
    setBusy(true)
    const neededBy = new Date(now.getTime() + 7 * 86_400_000)
    await enqueue('create_request', {
      p_drug_id: suggestion.drugId,
      p_qty_needed: suggestion.qty,
      p_urgency: 'urgent',
      p_radius_km: Math.ceil(suggestion.distanceKm + 5),
      p_needed_by: neededBy.toISOString().slice(0, 10),
      p_note: `Suggested: ${suggestion.fromClinicName} has ${suggestion.qty} ${unit}s expiring soon`,
      _from_suggestion: suggestion.batchId,
    })
    setBusy(false)
  }

  const otherClinic = outgoing
    ? model.clinicsById.get(suggestion.toClinicId)
    : model.clinicsById.get(suggestion.fromClinicId)

  return (
    <div className="card left-rule band-soon">
      <div className="card-title">
        {outgoing
          ? `Send ${suggestion.qty} ${unit}s to ${suggestion.toVillage}`
          : `Ask ${suggestion.fromClinicName} for ${suggestion.qty} ${unit}s`}
      </div>
      <div className="card-sub">{suggestion.drugName} · batch {suggestion.batchNo}</div>

      {/* The reasoning, not a score. */}
      <div className="card-meta" style={{ fontWeight: 600, color: 'var(--ink)' }}>
        {suggestion.why}
      </div>

      <div className="flag">
        <span aria-hidden="true">◔</span>
        Predicted from usage so far, not a certainty
        {suggestion.confidence === 'low' ? ' — based on limited history' : ''}
      </div>

      {suggestion.needsColdBox ? (
        <div className="flag">
          <span aria-hidden="true">❄</span>
          Send a cold box — {formatKm(suggestion.distanceKm)} is too far unrefrigerated
        </div>
      ) : null}

      {/* Action buttons — the whole point of this change. */}
      {!outgoing ? (
        queued && queued.status === 'done' ? (
          <Note kind="info">Request posted. See it above under "Your requests."</Note>
        ) : queued && queued.status === 'rejected' ? (
          <Note kind="error">{queued.lastError}</Note>
        ) : queued ? (
          <Note kind="warn">Waiting to send — not posted yet.</Note>
        ) : (
          <button className="btn" disabled={busy} onClick={() => void askForThis()}>
            {busy ? 'Posting…' : `Ask for ${suggestion.qty} ${unit}s`}
          </button>
        )
      ) : (
        <div className="card-meta">
          <strong>Call {otherClinic?.name ?? 'them'}</strong>
          {otherClinic?.phone ? ` at ${otherClinic.phone}` : ''} to arrange this.
        </div>
      )}
    </div>
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

function PostSheet({ model, lang = 'en', onClose }: { model: BoardModel; lang?: Lang; onClose: () => void }) {
  const [drugId, setDrugId] = useState('')
  const [qty, setQty] = useState('')
  const [urgency, setUrgency] = useState<StockRequest['urgency']>('urgent')
  const [radius, setRadius] = useState('40')
  const [days, setDays] = useState('3')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Natural-language intake. Everything below it is the form it fills in, which
  // stays fully usable on its own — offline, unconfigured, or when the parse
  // simply fails. See src/data/intake.ts.
  const [sentence, setSentence] = useState('')
  const [parsing, setParsing] = useState(false)
  const [listening, setListening] = useState(false)
  const [intakeNote, setIntakeNote] = useState<
    { kind: 'error' | 'warn' | 'info'; text: string } | null
  >(null)

  function startListening() {
    const SpeechAPI =
      typeof window !== 'undefined'
        ? (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any })
            .SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition
        : undefined

    if (!SpeechAPI) {
      setIntakeNote({
        kind: 'warn',
        text: 'Voice dictation is supported in Chrome, Edge, and Safari. On Firefox, please type your request.',
      })
      return
    }

    try {
      const recognition = new SpeechAPI()
      recognition.lang = lang === 'te' ? 'te-IN' : lang === 'hi' ? 'hi-IN' : 'en-IN'
      recognition.interimResults = false
      recognition.maxAlternatives = 1

      recognition.onstart = () => {
        setListening(true)
        setIntakeNote({ kind: 'info', text: 'Listening… speak your medicine need.' })
      }
      recognition.onend = () => setListening(false)
      recognition.onerror = (e: { error?: string }) => {
        setListening(false)
        if (e.error === 'not-allowed') {
          setIntakeNote({ kind: 'error', text: 'Microphone permission denied. Allow microphone access to dictate.' })
        }
      }

      recognition.onresult = (event: { results?: { [index: number]: { [index: number]: { transcript: string } } } }) => {
        const transcript = event.results?.[0]?.[0]?.transcript
        if (transcript) {
          setSentence(transcript)
          setIntakeNote({ kind: 'info', text: `Heard: “${transcript}” — tap Fill this in for me.` })
        }
        setListening(false)
      }

      recognition.start()
    } catch {
      setListening(false)
    }
  }

  const n = Number(qty)
  const valid = drugId !== '' && Number.isInteger(n) && n > 0

  async function parseSentence() {
    setParsing(true)
    setIntakeNote(null)
    const outcome = await parseRequestText(sentence, model.drugs)
    setParsing(false)

    if (outcome.kind === 'unavailable') {
      setIntakeNote({ kind: 'error', text: outcome.message })
      return
    }
    if (!outcome.result.ok) {
      const guess = outcome.result.drugNameGuess
      setIntakeNote({
        kind: 'error',
        text: outcome.result.reason === 'no_drug_match'
          ? guess
            ? `Not sure which medicine “${guess}” is — pick it below.`
            : 'Could not tell which medicine — pick it below.'
          : 'Could not tell how many — fill it in below.',
      })
      return
    }

    // A DRAFT, never a submission. The fields fill in and the worker checks
    // them — the same discipline as never showing a claim as confirmed before
    // the server has said so.
    const f = outcome.result.fields
    setDrugId(f.drugId)
    setQty(String(f.qtyNeeded))
    setUrgency(f.urgency)
    setRadius(String(f.radiusKm))
    setDays(String(f.neededByDays))
    setNote(f.note)
    setIntakeNote({
      kind: outcome.result.warnings.length > 0 ? 'warn' : 'info',
      text: outcome.result.warnings[0] ?? 'Filled in below — check it, then post.',
    })
  }

  return (
    <Sheet title={t('askForMedicine', lang)} onClose={onClose}>
      <div className="field">
        <label htmlFor="say">
          Say what you need <span className="hint">English or Telugu · optional</span>
        </label>
        <input
          id="say" className="input" value={sentence}
          placeholder="20 vials FMD vaccine, two herds down at Peddapur"
          onChange={(e) => setSentence(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-quiet" disabled={parsing || sentence.trim() === ''}
            style={{ flex: 1 }}
            onClick={() => void parseSentence()}
          >
            {parsing ? 'Reading…' : t('fillInForMe', lang)}
          </button>
          <button
            type="button"
            className={`btn btn-quiet ${listening ? 'band-critical' : ''}`}
            style={{ minWidth: 110, flexShrink: 0 }}
            onClick={startListening}
          >
            {listening ? t('listening', lang) : `🎙️ ${t('dictate', lang)}`}
          </button>
        </div>
        {intakeNote ? (
          <Note kind={intakeNote.kind === 'error' ? 'error' : intakeNote.kind === 'warn' ? 'warn' : 'info'}>
            {intakeNote.text}
          </Note>
        ) : null}
      </div>

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
