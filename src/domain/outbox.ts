/**
 * Offline outbox logic — must-build #5, judging criterion #2. Pure, no I/O.
 *
 * ## The rule that shapes this whole module
 *
 * Every action is one of two kinds, and they get different consistency models:
 *
 *   UNCONTESTED (own-clinic)  logging dispensed vials, adding a batch, a
 *                             correction. Nobody else can disagree about your
 *                             own shelf, deltas merge by addition, so these
 *                             apply locally and immediately. The UI may show
 *                             them as done.
 *
 *   CONTESTED (cross-clinic)  claiming stock. Two clinics can want the same
 *                             four vials. This CANNOT be resolved on-device at
 *                             any price, so it queues, the server arbitrates,
 *                             and the UI says "Waiting to send" until an answer
 *                             comes back.
 *
 * A worker who drives 30 km on a confirmation the server never gave stops
 * trusting the system permanently, and rightly. Honest pending states are a
 * trust safeguard, not a UX nicety.
 */

import type { Iso } from './types'

export type OpName =
  | 'log_movement'
  | 'create_batch'
  | 'create_request'
  | 'propose_transfer'
  | 'claim_from_match'
  | 'accept_transfer'
  | 'decline_transfer'
  | 'cancel_transfer'
  | 'dispatch_transfer'
  | 'confirm_handoff'

/**
 * Which operations can race another clinic.
 *
 * Getting an entry here wrong is the difference between a worker seeing
 * "Claimed" and a worker seeing the truth, so it is data, not scattered ifs.
 */
export const CONTESTED: ReadonlySet<OpName> = new Set<OpName>([
  'claim_from_match',
  'accept_transfer',
  'dispatch_transfer',
  'confirm_handoff',
])

export function isContested(op: OpName): boolean {
  return CONTESTED.has(op)
}

export type OutboxStatus = 'pending' | 'sending' | 'done' | 'rejected'

export interface OutboxItem {
  /** Client-generated UUID. The idempotency key the server dedupes on. */
  readonly clientId: string
  readonly op: OpName
  readonly args: Readonly<Record<string, unknown>>
  /** Device clock — display and within-device ordering only. Never cross-device. */
  readonly clientTs: Iso
  readonly deviceId: string
  readonly status: OutboxStatus
  readonly attempts: number
  readonly lastError: string | null
  readonly result: Readonly<Record<string, unknown>> | null
  /** Monotonic per-device sequence. Survives a wrong clock; clientTs does not. */
  readonly seq: number
}

export interface ServerResult {
  readonly ok: boolean
  readonly error?: string
  readonly message?: string
  readonly [key: string]: unknown
}

/**
 * Errors that mean "this will never succeed". Retrying them forever would pin a
 * 2G connection open re-sending an action the server has already refused on its
 * merits.
 */
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  'insufficient_stock',
  'wrong_state',
  'not_your_transfer',
  'not_your_side',
  'not_found',
  'bad_side',
  'own_stock',
  'bad_qty',
  'not_your_batch',
  'would_go_negative',
  'reserved_stock',
  'session_invalid',
  // propose_transfer's own refusals-on-the-merits. Retrying any of these
  // hits the exact same answer every time — the batch does not become less
  // quarantined, the clinic does not stop being itself — so treating them as
  // "maybe next time" would jam the serial queue behind a request that can
  // never succeed, the same failure mode the _from_suggestion bug caused via
  // a different path (a malformed call instead of a real rejection).
  'own_clinic',
  'unknown_clinic',
  'batch_not_active',
])

export function isPermanent(error: string | undefined): boolean {
  return error !== undefined && PERMANENT_ERRORS.has(error)
}

/**
 * Send strictly in creation order, one at a time.
 *
 * Parallel draining looks faster and is wrong: dispatch must not overtake the
 * accept that issued its codes. On a 2G link the win would be imperceptible
 * anyway.
 */
export function nextToSend(items: readonly OutboxItem[]): OutboxItem | null {
  if (items.some((i) => i.status === 'sending')) return null
  const pending = items.filter((i) => i.status === 'pending').sort((a, b) => a.seq - b.seq)
  return pending[0] ?? null
}

export function pendingCount(items: readonly OutboxItem[]): number {
  return items.filter((i) => i.status === 'pending' || i.status === 'sending').length
}

export function rejected(items: readonly OutboxItem[]): OutboxItem[] {
  return items.filter((i) => i.status === 'rejected')
}

/** Transition for a result that actually came back from the server. */
export function applyResult(item: OutboxItem, result: ServerResult): OutboxItem {
  if (result.ok) {
    return { ...item, status: 'done', result, lastError: null }
  }
  if (isPermanent(result.error)) {
    // A refusal on the merits. Surface it to the worker; never retry it.
    return {
      ...item,
      status: 'rejected',
      result,
      lastError: result.message ?? result.error ?? 'rejected',
    }
  }
  return {
    ...item,
    status: 'pending',
    attempts: item.attempts + 1,
    lastError: result.message ?? result.error ?? 'failed',
  }
}

/**
 * Transition for a send that never reached the server — no signal, timeout, a
 * 500. Stays pending: the action is not lost, and replaying it is safe because
 * the server dedupes on clientId.
 */
export function applyTransportFailure(item: OutboxItem, error: string): OutboxItem {
  return { ...item, status: 'pending', attempts: item.attempts + 1, lastError: error }
}

export function markSending(item: OutboxItem): OutboxItem {
  return { ...item, status: 'sending' }
}

/** Exponential backoff, capped. Cheap handsets on 2G retry a lot. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
}

/**
 * What the worker is told about a queued action.
 *
 * "Waiting to send" is never "Confirmed", and the wording is deliberately plain.
 * A contested action that has not been answered has NOT happened.
 */
export function statusLabel(item: OutboxItem): string {
  switch (item.status) {
    case 'pending':
      return item.attempts > 0 ? 'Waiting to send — no signal' : 'Waiting to send'
    case 'sending':
      return 'Sending…'
    case 'done':
      return isContested(item.op) ? 'Confirmed' : 'Saved'
    case 'rejected':
      return item.lastError ?? 'Not accepted'
  }
}

/**
 * Whether the UI may show this action's effect as real yet.
 *
 * Own-clinic actions are true from the moment they are queued — they cannot be
 * contested and the ledger merges them by addition whenever they land.
 * Contested actions are true only once the server has said so.
 */
export function isSettled(item: OutboxItem): boolean {
  if (item.status === 'done') return true
  if (item.status === 'rejected') return false
  return !isContested(item.op)
}
