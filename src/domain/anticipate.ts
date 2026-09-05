/**
 * Anticipated transfers — the board proposing moves nobody asked for yet.
 *
 * ## The gap this closes
 *
 * Everything else in this app is reactive: a worker must notice stock is
 * expiring, then post a request, and only then does matching run. But the
 * brief's own sentence is "spoil unused ... because staff cannot easily see
 * what neighbouring centres have or need BEFORE batches expire." The failure
 * is inattention. Nobody browses an inventory list mid-outbreak, so the
 * expensive vial quietly dies on the shelf and no request is ever posted for a
 * shortage twelve kilometres away.
 *
 * This pairs a forecast of waste at one clinic against a forecast of stockout
 * at another and proposes the transfer with no human trigger anywhere in the
 * loop. It is the difference between a noticeboard and something that works
 * while everyone is busy.
 *
 * ## Two guards that decide whether this helps or harms
 *
 * 1. It must never create the problem it is solving. Quantity is capped at the
 *    sender's PROJECTED WASTE — the vials their own consumption will not reach
 *    before expiry — so a suggestion can never cause a stockout at the sender.
 *    The forecast makes that safety property automatic rather than a rule to
 *    remember.
 *
 * 2. It must not simply relocate the bin. Sending 25 vials that expire in five
 *    days to a clinic using one a day moves the waste 12 km and calls it a
 *    save. Quantity is therefore also capped at what the RECEIVER can actually
 *    get through before that same expiry date.
 *
 * Ranked in tiers, never by an opaque weighted score, for the same reason §6
 * gives: a worker deciding whether to send someone on a motorbike has to be
 * able to check the reasoning.
 */

import { haversineKm, formatKm, COLD_BOX_THRESHOLD_KM } from './matching'
import { daysUntilExpiry, humanizeExpiry, isExpired } from './expiry'
import { batchOutlook, type Confidence, type DemandSignal } from './forecast'
import type { Clinic, Drug } from './types'

export interface PositionBatch {
  readonly id: string
  readonly batchNo: string
  readonly expiryDate: string
  readonly coldChainOk: boolean
  readonly status: string
  readonly available: number
}

/** What one clinic holds, and how fast it moves, for one drug. */
export interface ClinicDrugPosition {
  readonly clinicId: string
  readonly drugId: string
  readonly onHand: number
  readonly signal: DemandSignal
  readonly batches: readonly PositionBatch[]
}

export interface AnticipatedTransfer {
  readonly fromClinicId: string
  readonly toClinicId: string
  readonly fromClinicName: string
  readonly toClinicName: string
  readonly toVillage: string
  readonly batchId: string
  readonly batchNo: string
  readonly drugId: string
  readonly drugName: string
  readonly qty: number
  readonly distanceKm: number
  /** Vials that would otherwise have been binned. The point of the whole thing. */
  readonly vialsSaved: number
  /** Days until the receiving clinic hits zero at its current rate. */
  readonly receiverRunsOutInDays: number
  readonly expiryDate: string
  readonly needsColdBox: boolean
  /** The weaker of the two forecasts — a chain is only as good as its weakest link. */
  readonly confidence: Confidence
  readonly why: string
}

export interface AnticipateInput {
  readonly positions: readonly ClinicDrugPosition[]
  readonly clinicsById: ReadonlyMap<string, Clinic>
  readonly drugsById: ReadonlyMap<string, Drug>
  /** How far a suggestion may reach. Suggestions are unsolicited, so keep them local. */
  readonly radiusKm: number
  readonly now: Date
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 }

function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b
}

/**
 * Suggestions are unsolicited, so the bar is deliberately higher than for a
 * match a human went looking for: both sides must be at least `low` confidence
 * before anything is proposed at all.
 */
export function anticipateTransfers(input: AnticipateInput): AnticipatedTransfer[] {
  const { positions, clinicsById, drugsById, radiusKm, now } = input
  const out: AnticipatedTransfer[] = []

  const byDrug = new Map<string, ClinicDrugPosition[]>()
  for (const p of positions) {
    const list = byDrug.get(p.drugId)
    if (list) list.push(p)
    else byDrug.set(p.drugId, [p])
  }

  for (const [drugId, group] of byDrug) {
    const drug = drugsById.get(drugId)
    if (!drug) continue

    for (const sender of group) {
      if (sender.signal.confidence === 'none') continue
      const from = clinicsById.get(sender.clinicId)
      if (!from) continue

      for (const batch of sender.batches) {
        if (batch.status !== 'active') continue
        if (batch.available <= 0) continue
        if (isExpired(batch.expiryDate, now)) continue
        // A broken cold chain arrives inert and gets recorded as a successful
        // vaccination. Never propose moving one.
        if (drug.requiresColdChain && !batch.coldChainOk) continue

        const outlook = batchOutlook(batch, batch.available, sender.signal, now, drug.unit)
        if (outlook.risk !== 'will_expire_unused' || outlook.projectedWaste < 1) continue

        const daysToExpiry = daysUntilExpiry(batch.expiryDate, now)

        for (const receiver of group) {
          if (receiver.clinicId === sender.clinicId) continue
          if (receiver.signal.confidence === 'none') continue
          if (receiver.signal.dailyRate <= 0) continue

          const to = clinicsById.get(receiver.clinicId)
          if (!to) continue

          const distanceKm = haversineKm(from, to)
          if (distanceKm > radiusKm) continue

          // Does the receiver actually run short inside a horizon worth acting on?
          const runsOutInDays = Math.floor(receiver.onHand / receiver.signal.dailyRate)
          if (runsOutInDays > daysToExpiry) continue

          // Guard 1: never take more than the sender was going to waste anyway,
          // so a suggestion cannot cause the stockout it exists to prevent.
          const senderCanSpare = Math.min(outlook.projectedWaste, batch.available)

          // Guard 2: never relocate the bin. Cap at what the receiver can get
          // through before this same expiry date.
          const receiverCanUse = Math.floor(receiver.signal.dailyRate * daysToExpiry)
          const receiverShortfall = Math.max(0, receiverCanUse - receiver.onHand)

          const qty = Math.min(senderCanSpare, receiverShortfall)
          if (qty < 1) continue

          const confidence = weaker(sender.signal.confidence, receiver.signal.confidence)

          out.push({
            fromClinicId: sender.clinicId,
            toClinicId: receiver.clinicId,
            fromClinicName: from.name,
            toClinicName: to.name,
            toVillage: to.village,
            batchId: batch.id,
            batchNo: batch.batchNo,
            drugId,
            drugName: drug.name,
            qty,
            distanceKm,
            vialsSaved: qty,
            receiverRunsOutInDays: runsOutInDays,
            expiryDate: batch.expiryDate,
            needsColdBox: drug.requiresColdChain && distanceKm > COLD_BOX_THRESHOLD_KM,
            confidence,
            why:
              `${from.village} is not using these — ${outlook.projectedWaste} of ${batch.available} ` +
              `${humanizeExpiry(batch.expiryDate, now)}. ${to.village} runs out in ` +
              `${runsOutInDays} ${runsOutInDays === 1 ? 'day' : 'days'} · ${formatKm(distanceKm)}`,
          })
        }
      }
    }
  }

  return out.sort(rank)
}

/**
 * Tiers, not a weighted score.
 *
 * Soonest stockout first: the clinic about to run out is the one with animals
 * waiting. Then most vials saved, then nearest, then batch id so the ordering
 * is total and the board never reshuffles itself between reads.
 */
function rank(a: AnticipatedTransfer, b: AnticipatedTransfer): number {
  if (a.receiverRunsOutInDays !== b.receiverRunsOutInDays) {
    return a.receiverRunsOutInDays - b.receiverRunsOutInDays
  }
  if (a.vialsSaved !== b.vialsSaved) return b.vialsSaved - a.vialsSaved
  if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm
  return a.batchId.localeCompare(b.batchId)
}

/**
 * One suggestion per receiving clinic per drug — the best one.
 *
 * Without this a single stockout generates a suggestion against every expiring
 * batch in the district, and the worker sees a wall instead of a decision.
 */
export function bestPerNeed(transfers: readonly AnticipatedTransfer[]): AnticipatedTransfer[] {
  const seen = new Set<string>()
  const best: AnticipatedTransfer[] = []
  for (const t of transfers) {
    const key = `${t.toClinicId}:${t.drugId}`
    if (seen.has(key)) continue
    seen.add(key)
    best.push(t)
  }
  return best
}
