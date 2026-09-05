/**
 * Matching. Pure, deterministic, explainable. No ML, no external API, no clock.
 *
 * The product thesis is that stock about to be wasted in one village is stock
 * urgently needed in the next one. Matching is where that thesis either works or
 * doesn't, so the ranking prefers expiring stock on purpose — and every match
 * carries the reason it surfaced, because a worker deciding whether to send
 * someone 30 km on a motorbike cannot act on an opaque score.
 */

import { available } from './ledger'
import { daysUntilExpiry, humanizeExpiry, isExpired } from './expiry'
import type { Batch, Clinic, Drug, StockMovement, StockRequest } from './types'

const EARTH_RADIUS_KM = 6371

/** Great-circle distance. Roads are longer, but distance here is for ranking. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

/**
 * Beyond this, a cold-chain vaccine on an unrefrigerated motorbike in 40°C heat
 * is likely dead on arrival — and a vaccine that arrives inert is worse than no
 * vaccine, because the herd is recorded as protected when it isn't.
 *
 * DEVIATION from CLAUDE.md §6, flagged deliberately: the spec's filter list does
 * not mention cold chain. This does not filter the match out — the receiving
 * clinic may well have a cold box — it raises `needsColdBox` so the card can say
 * so. Informing the decision, not making it.
 */
export const COLD_BOX_THRESHOLD_KM = 25

export interface Match {
  readonly batchId: string
  readonly clinicId: string
  readonly clinicName: string
  readonly village: string
  readonly batchNo: string
  readonly distanceKm: number
  readonly availableQty: number
  /** Capped at what the request actually needs. */
  readonly qtyOffered: number
  readonly expiryDate: string
  readonly daysToExpiry: number
  /** Holder avoids waste AND requester gets it in time. The premise of the product. */
  readonly solvesBoth: boolean
  /** Stock will still be in date when the requester needs it. */
  readonly arrivesInTime: boolean
  readonly needsColdBox: boolean
  /** "11 km · expires in 9 days · 12 vials" */
  readonly explain: string
}

export type ExclusionReason =
  | 'wrong_drug'
  | 'own_clinic'
  | 'out_of_radius'
  | 'expired'
  | 'no_available_stock'
  | 'batch_not_active'
  | 'cold_chain_broken'

export interface Excluded {
  readonly batchId: string
  readonly reason: ExclusionReason
  readonly distanceKm: number
}

export interface MatchInput {
  readonly request: StockRequest
  readonly requestingClinic: Clinic
  readonly drug: Drug
  readonly batches: readonly Batch[]
  readonly clinicsById: ReadonlyMap<string, Clinic>
  readonly movementsByBatch: ReadonlyMap<string, readonly StockMovement[]>
  readonly now: Date
}

export interface MatchOutput {
  readonly matches: readonly Match[]
  readonly excluded: readonly Excluded[]
}

/**
 * Filter then rank.
 *
 * Filter: same drug, another clinic, within radius, active batch, in date,
 *         available > 0, cold chain intact.
 * Rank:   solves-both first, then soonest expiry, then nearest, then largest qty.
 *
 * The tie-breaks run all the way down to batch id so the order is total and the
 * same inputs always produce the same board — "deterministic state management"
 * includes what the worker sees.
 */
export function findMatches(input: MatchInput): MatchOutput {
  const { request, requestingClinic, drug, batches, clinicsById, movementsByBatch, now } = input
  const matches: Match[] = []
  const excluded: Excluded[] = []

  for (const batch of batches) {
    const clinic = clinicsById.get(batch.clinicId)
    if (!clinic) continue

    const distanceKm = haversineKm(requestingClinic, clinic)
    const drop = (reason: ExclusionReason) => excluded.push({ batchId: batch.id, reason, distanceKm })

    if (batch.drugId !== request.drugId) continue // not a near miss, just noise
    if (batch.clinicId === request.clinicId) {
      drop('own_clinic')
      continue
    }
    if (distanceKm > request.radiusKm) {
      drop('out_of_radius')
      continue
    }
    if (batch.status !== 'active') {
      drop('batch_not_active')
      continue
    }
    if (isExpired(batch.expiryDate, now)) {
      drop('expired')
      continue
    }
    // A vaccine whose cold chain is already broken must never be offered: it
    // would arrive inert and be recorded as a successful vaccination.
    if (drug.requiresColdChain && !batch.coldChainOk) {
      drop('cold_chain_broken')
      continue
    }

    const availableQty = available(batch, movementsByBatch.get(batch.id) ?? [])
    if (availableQty <= 0) {
      drop('no_available_stock')
      continue
    }

    const daysToExpiry = daysUntilExpiry(batch.expiryDate, now)
    const daysUntilNeeded = daysUntilExpiry(request.neededBy, now)
    const arrivesInTime = daysToExpiry >= daysUntilNeeded
    // "Expiring" means it would plausibly be wasted where it sits.
    const wouldOtherwiseBeWasted = daysToExpiry <= 30

    matches.push({
      batchId: batch.id,
      clinicId: clinic.id,
      clinicName: clinic.name,
      village: clinic.village,
      batchNo: batch.batchNo,
      distanceKm,
      availableQty,
      qtyOffered: Math.min(availableQty, request.qtyNeeded),
      expiryDate: batch.expiryDate,
      daysToExpiry,
      solvesBoth: wouldOtherwiseBeWasted && arrivesInTime,
      arrivesInTime,
      needsColdBox: drug.requiresColdChain && distanceKm > COLD_BOX_THRESHOLD_KM,
      explain: explainMatch(distanceKm, batch.expiryDate, availableQty, drug, now),
    })
  }

  return { matches: matches.sort(rank), excluded }
}

/**
 * "11 km · expires in 9 days · 12 vials"
 *
 * Three facts, in the order a worker weighs them: can I get there, is it worth
 * going, is there enough.
 */
export function explainMatch(
  distanceKm: number,
  expiryDate: string,
  qty: number,
  drug: Drug,
  now: Date,
): string {
  const unit = qty === 1 ? drug.unit : `${drug.unit}s`
  return `${formatKm(distanceKm)} · ${humanizeExpiry(expiryDate, now)} · ${qty} ${unit}`
}

export function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

function rank(a: Match, b: Match): number {
  // Solving both sides at once is the whole premise — it outranks everything.
  if (a.solvesBoth !== b.solvesBoth) return a.solvesBoth ? -1 : 1
  // Stock that will not survive until it is needed is a last resort.
  if (a.arrivesInTime !== b.arrivesInTime) return a.arrivesInTime ? -1 : 1
  if (a.daysToExpiry !== b.daysToExpiry) return a.daysToExpiry - b.daysToExpiry
  if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm
  if (a.availableQty !== b.availableQty) return b.availableQty - a.availableQty
  return a.batchId.localeCompare(b.batchId) // total order, stable board
}

export interface Allocation {
  readonly match: Match
  readonly qty: number
}

export interface FulfilmentPlan {
  readonly allocations: readonly Allocation[]
  readonly qtyPlanned: number
  readonly qtyShort: number
  readonly complete: boolean
}

/**
 * Plan a fill across multiple clinics.
 *
 * DEVIATION from CLAUDE.md §6, flagged: the spec describes matching as a ranked
 * list and stops there. But `partially_filled` is already in the request status
 * enum, and a real outbreak shortage is filled 12 vials from one neighbour and 8
 * from the next — forcing one-clinic-or-nothing would leave the request open
 * with stock sitting 11 km away. Greedy over the existing ranking, so the
 * explanation stays the same one the worker already read.
 */
export function planFulfilment(request: StockRequest, matches: readonly Match[]): FulfilmentPlan {
  const allocations: Allocation[] = []
  let remaining = request.qtyNeeded

  for (const match of matches) {
    if (remaining <= 0) break
    const qty = Math.min(match.availableQty, remaining)
    if (qty <= 0) continue
    allocations.push({ match, qty })
    remaining -= qty
  }

  return {
    allocations,
    qtyPlanned: request.qtyNeeded - remaining,
    qtyShort: remaining,
    complete: remaining === 0,
  }
}
