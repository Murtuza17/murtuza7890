/**
 * Demand forecasting. Pure — no I/O, no clock, no network, no model weights.
 *
 * ## Why this is not an LLM call
 *
 * The brief bans paid APIs, which rules out a hosted model. That constraint
 * points at the right design rather than away from it: the user is on 2G during
 * an outbreak and may have no signal at all, so anything that needs a round trip
 * is unavailable exactly when the stakes are highest. What this file does runs
 * in well under a millisecond, on-device, with the connection cut.
 *
 * ## What it is instead
 *
 * The ledger is already a complete time series of demand — every `dispensed`
 * row is one observation of how fast a clinic actually uses a drug. Nothing was
 * reading it. This infers a consumption rate per clinic per drug, then projects
 * each batch forward to answer the two questions the whole product exists for:
 *
 *     will this expire before it is used?      (waste, the brief's premise)
 *     will this run out before it is resupplied? (stockout, the other half)
 *
 * Both answers are arithmetic on observed history — deterministic, reproducible,
 * and explainable in one sentence, which §6 demands of anything that ranks
 * stock. A forecast a worker cannot interrogate is worse than no forecast: it
 * moves scarce antivenom on a number nobody can check.
 *
 * ## The honesty rule
 *
 * A prediction shown as a fact will eventually send someone 30 km on a guess.
 * Every outlook here carries a confidence, and `unknown` is a first-class
 * answer — the same discipline as "Waiting to send" never reading "Confirmed".
 */

import type { IsoDate } from './types'
import { daysUntilExpiry } from './expiry'

/**
 * How much we trust the rate — driven by how long we have been WATCHING, not
 * by how much happened.
 *
 * This distinction matters and is easy to get backwards. A clinic holding 25
 * vials for 60 days having dispensed exactly none is not "no data" — it is a
 * strong, high-information observation that the rate is approximately zero, and
 * therefore that the entire batch is heading for the bin. Ranking that as
 * low-confidence would hide the single most actionable case in the system.
 * Events refine the precision of a rate; the observation window is what earns
 * the right to state one at all.
 */
export type Confidence = 'none' | 'low' | 'medium' | 'high'

/** Aggregates the server computes over the full ledger (never a truncated page). */
export interface ConsumptionStats {
  /** Vials dispensed in the trailing windows. `dispensed` rows ONLY — see below. */
  readonly dispensed14d: number
  readonly dispensed30d: number
  readonly dispensed90d: number
  /** Number of distinct dispensing events, for rate precision. */
  readonly events: number
  /**
   * How long this clinic has held this drug at all — the honest denominator.
   * A clinic three days old must not have its three days extrapolated to ninety.
   */
  readonly observedDays: number
}

export interface DemandSignal {
  /** Vials per day, from the longest window we can justify. */
  readonly dailyRate: number
  /** Vials per day over the last 14 days — the outbreak-detecting half. */
  readonly recentRate: number
  readonly observedDays: number
  readonly events: number
  readonly confidence: Confidence
  /**
   * `surging` is the outbreak signature: this clinic is burning stock several
   * times faster than its own baseline. It fires before any human has thought
   * to declare an outbreak or post a request, which is the entire point.
   */
  readonly trend: 'surging' | 'steady' | 'quiet'
}

const DAY = 1

/**
 * Only `dispensed` counts as demand.
 *
 * `wasted` and `expired` are the failure this product exists to prevent —
 * counting them as demand would let a clinic that routinely bins stock look
 * like a clinic that needs more of it, and the system would keep feeding it.
 * `transferred_out` is another clinic's demand, not this one's. `correction` is
 * bookkeeping. Getting this wrong would quietly invert the product.
 */
export function demandSignal(stats: ConsumptionStats): DemandSignal {
  const window90 = Math.max(DAY, Math.min(90, stats.observedDays))
  const window14 = Math.max(DAY, Math.min(14, stats.observedDays))

  const dailyRate = stats.dispensed90d / window90
  const recentRate = stats.dispensed14d / window14

  return {
    dailyRate,
    recentRate,
    observedDays: stats.observedDays,
    events: stats.events,
    confidence: confidenceFor(stats),
    trend: trendFor(dailyRate, recentRate, stats),
  }
}

function confidenceFor(stats: ConsumptionStats): Confidence {
  // Below a week we genuinely cannot tell a quiet clinic from a new one.
  if (stats.observedDays < 7) return 'none'
  if (stats.observedDays >= 45) return stats.events >= 3 || stats.dispensed90d === 0 ? 'high' : 'medium'
  if (stats.observedDays >= 21) return 'medium'
  return 'low'
}

function trendFor(
  dailyRate: number,
  recentRate: number,
  stats: ConsumptionStats,
): DemandSignal['trend'] {
  // A single event inside 14 days is noise, not a surge — demanding two guards
  // against one vaccination camp reading as an outbreak.
  const enoughRecentActivity = stats.dispensed14d > 0 && stats.events >= 2
  if (enoughRecentActivity && recentRate >= dailyRate * 2 && stats.observedDays >= 14) {
    return 'surging'
  }
  if (dailyRate <= 0) return 'quiet'
  return 'steady'
}

export type BatchRisk =
  | 'unknown'
  | 'will_expire_unused'
  | 'will_run_out'
  | 'balanced'

export interface BatchOutlook {
  readonly batchId: string
  readonly onHand: number
  readonly daysToExpiry: number
  /** Vials this clinic is projected to actually use before the expiry date. */
  readonly projectedUse: number
  /** Vials projected to be binned. The number this whole product exists to reduce. */
  readonly projectedWaste: number
  /** Days until the shelf hits zero at the current rate. null = not at this rate. */
  readonly daysToStockout: number | null
  readonly risk: BatchRisk
  readonly confidence: Confidence
  /** One sentence a worker can check the maths on. Never an opaque score. */
  readonly why: string
}

/** Beyond this horizon a stockout is too far out to act on today. */
export const STOCKOUT_HORIZON_DAYS = 21

export function batchOutlook(
  batch: { id: string; expiryDate: IsoDate },
  onHand: number,
  signal: DemandSignal,
  now: Date,
  unit = 'vial',
): BatchOutlook {
  const daysToExpiry = daysUntilExpiry(batch.expiryDate, now)
  const usableDays = Math.max(0, daysToExpiry)
  const projectedUse = Math.round(signal.dailyRate * usableDays)
  const projectedWaste = Math.max(0, onHand - projectedUse)
  const daysToStockout =
    signal.dailyRate > 0 ? Math.floor(onHand / signal.dailyRate) : null

  const base = {
    batchId: batch.id,
    onHand,
    daysToExpiry,
    projectedUse,
    projectedWaste,
    daysToStockout,
    confidence: signal.confidence,
  }

  // Never state an outlook we cannot stand behind. "We do not know yet" is a
  // real answer and a safe one; a confident-looking guess is neither.
  if (signal.confidence === 'none') {
    return {
      ...base,
      risk: 'unknown',
      why: `Not enough history yet — watching since ${signal.observedDays} ${plural(signal.observedDays, 'day')}`,
    }
  }

  if (daysToExpiry < 0) {
    return { ...base, risk: 'balanced', why: 'Already expired' }
  }

  if (projectedWaste > 0) {
    const rateText =
      signal.dailyRate === 0
        ? `none used in ${signal.observedDays} days`
        : `about ${round1(signal.dailyRate * 7)} ${unit}s a week here`
    return {
      ...base,
      risk: 'will_expire_unused',
      why: `${rateText} — ${projectedWaste} of ${onHand} likely to expire unused in ${daysToExpiry} ${plural(daysToExpiry, 'day')}`,
    }
  }

  if (daysToStockout !== null && daysToStockout <= STOCKOUT_HORIZON_DAYS) {
    return {
      ...base,
      risk: 'will_run_out',
      why: `about ${round1(signal.dailyRate * 7)} ${unit}s a week here — ${onHand} left runs out in ${daysToStockout} ${plural(daysToStockout, 'day')}`,
    }
  }

  return {
    ...base,
    risk: 'balanced',
    why: `about ${round1(signal.dailyRate * 7)} ${unit}s a week here — enough to last`,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
