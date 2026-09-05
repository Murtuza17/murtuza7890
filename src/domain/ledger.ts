/**
 * Ledger arithmetic. Pure — no I/O.
 *
 * ## Why there is no `qty_on_hand` column
 *
 * On-hand is derived: `SUM(delta)` over an append-only movement log.
 *
 * Consider two clinics' devices, both offline, both recording "dispensed 5 vials"
 * against the same batch:
 *
 *   Stored total:  device A writes qty=7, device B writes qty=7. Last write wins.
 *                  Result 7. Five vials vanish silently.
 *   Delta ledger:  device A writes -5, device B writes -5. Both rows survive.
 *                  Result 12-5-5 = 2. Correct.
 *
 * Deltas are commutative and associative, so merge order cannot change the answer.
 * Absolute totals are neither. An app that stores and overwrites a running total
 * cannot be made correct offline regardless of how good its sync code is — the
 * information needed to merge was destroyed at write time.
 *
 * Everything else in this file follows from that.
 */

import type { Batch, BatchId, StockMovement, Transfer } from './types'

/** Movements that count toward stock. Unsynced local rows count too — they are real. */
export function onHand(movements: readonly StockMovement[]): number {
  return movements.reduce((sum, m) => sum + m.delta, 0)
}

export function onHandForBatch(batchId: BatchId, movements: readonly StockMovement[]): number {
  return onHand(movements.filter((m) => m.batchId === batchId))
}

/**
 * What can actually be promised to another clinic right now.
 *
 * Reserved vials are physically present but already committed to an accepted
 * transfer. Showing them as available is how you get a worker riding 30 km for
 * stock that left an hour earlier.
 */
export function available(batch: Batch, movements: readonly StockMovement[]): number {
  return Math.max(0, onHandForBatch(batch.id, movements) - batch.qtyReserved)
}

/** Transfer states that hold a physical claim on stock. */
const RESERVING_STATES = new Set<Transfer['status']>(['accepted', 'in_transit'])

/**
 * Reserved quantity derived from transfers — the ground truth that
 * `batches.qty_reserved` is a lock-protected cache of.
 */
export function deriveReserved(batchId: BatchId, transfers: readonly Transfer[]): number {
  return transfers
    .filter((t) => t.batchId === batchId && RESERVING_STATES.has(t.status))
    .reduce((sum, t) => sum + t.qty, 0)
}

/**
 * Drift between the cached column and the derived truth. Must always be 0.
 *
 * `qty_reserved` is a stored running total, which is exactly what this module
 * exists to forbid. It is tolerated because it is written in one place only —
 * inside the row-locked server transaction — but "tolerated" needs a proof, and
 * this is it. Asserted in tests and checked by the reconciliation sweep.
 */
export function reservedDrift(batch: Batch, transfers: readonly Transfer[]): number {
  return batch.qtyReserved - deriveReserved(batch.id, transfers)
}

/**
 * Idempotent merge of incoming movements into a known set.
 *
 * A flaky 2G connection retrying the same write three times must produce one
 * movement, not three. The server enforces this with a UNIQUE constraint on
 * `client_id`; this mirrors it client-side so optimistic local state matches
 * what the server will conclude.
 *
 * Server-confirmed rows always win over local echoes of the same `clientId`.
 */
export function mergeMovements(
  known: readonly StockMovement[],
  incoming: readonly StockMovement[],
): StockMovement[] {
  const byClientId = new Map<string, StockMovement>()
  for (const m of [...known, ...incoming]) {
    const existing = byClientId.get(m.clientId)
    if (!existing || (existing.serverTs === null && m.serverTs !== null)) {
      byClientId.set(m.clientId, m)
    }
  }
  return [...byClientId.values()]
}

/**
 * Chronological order for display.
 *
 * Server time orders. Client clocks on cheap Android handsets drift by hours and
 * are trivially wrong after a battery pull — ordering the shared ledger by them
 * would let one bad clock silently reshuffle another clinic's history. Rows not
 * yet confirmed by the server sort last: they haven't happened yet, as far as
 * anyone but this device knows.
 */
export function sortByServerTime(movements: readonly StockMovement[]): StockMovement[] {
  return [...movements].sort((a, b) => {
    if (a.serverTs === null && b.serverTs === null) return a.clientTs.localeCompare(b.clientTs)
    if (a.serverTs === null) return 1
    if (b.serverTs === null) return -1
    return a.serverTs.localeCompare(b.serverTs)
  })
}

export type MovementRejection =
  | { ok: true }
  | { ok: false; reason: 'would_go_negative'; onHand: number; requested: number }
  | { ok: false; reason: 'zero_delta' }
  | { ok: false; reason: 'reserved_stock'; available: number; requested: number }

/**
 * Can this clinic apply this movement to its own batch?
 *
 * Own-clinic movements are uncontested and apply locally and immediately — nobody
 * else can disagree about your own shelf. They still have to be arithmetically
 * possible: you cannot dispense vials you do not have, and you cannot dispense
 * vials already promised to a neighbour.
 */
export function validateMovement(
  batch: Batch,
  movements: readonly StockMovement[],
  delta: number,
  reason: StockMovement['reason'],
): MovementRejection {
  if (delta === 0) return { ok: false, reason: 'zero_delta' }
  if (delta > 0) return { ok: true }

  const current = onHandForBatch(batch.id, movements)
  const requested = Math.abs(delta)
  if (current + delta < 0) {
    return { ok: false, reason: 'would_go_negative', onHand: current, requested }
  }

  // Corrections and transfer-outs are allowed to eat into reserved stock: a
  // correction is reconciling reality, and a transfer-out IS the reservation
  // being fulfilled. Everything else must respect the promise.
  if (reason !== 'correction' && reason !== 'transferred_out') {
    const free = available(batch, movements)
    if (requested > free) return { ok: false, reason: 'reserved_stock', available: free, requested }
  }
  return { ok: true }
}
