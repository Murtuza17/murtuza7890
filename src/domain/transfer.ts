/**
 * Transfer state machine. Pure `(state, event) -> state`, zero I/O.
 *
 *   proposed ──accept──> accepted ──dispatch──> in_transit ──confirm──> completed
 *       │                    │                       │
 *    decline            cancel / TTL              dispute
 *       ▼                    ▼                       ▼
 *    declined            cancelled                disputed
 *
 * Every terminal state is reachable and every transition is total: an event that
 * does not apply returns a typed refusal rather than throwing or silently no-oping.
 * Callers must handle the refusal, which is what makes the offline queue safe to
 * replay — a stale queued event meets a moved-on state and is rejected explicitly.
 */

import type { Iso, Transfer, TransferStatus } from './types'

export type TransferEvent =
  | { type: 'accept'; at: Iso; senderCode: string; receiverCode: string; reservedUntil: Iso }
  | { type: 'decline'; at: Iso; byClinicId: string; note?: string }
  | { type: 'dispatch'; at: Iso }
  /** One party reports the code the other party read out at the roadside handoff. */
  | { type: 'confirm'; at: Iso; side: 'sender' | 'receiver'; code: string }
  | { type: 'cancel'; at: Iso; byClinicId: string; note?: string }
  | { type: 'expire'; at: Iso }
  | { type: 'dispute'; at: Iso; note: string }

export type TransferRefusal =
  | { kind: 'wrong_state'; from: TransferStatus; event: TransferEvent['type'] }
  | { kind: 'already_terminal'; state: TransferStatus }
  | { kind: 'code_mismatch'; side: 'sender' | 'receiver' }
  | { kind: 'not_yet_expired'; reservedUntil: Iso; at: Iso }

export type TransferResult =
  | { ok: true; state: TransferState; emits: readonly TransferEmission[] }
  | { ok: false; refusal: TransferRefusal }

/** Side-effects the caller must perform. The reducer itself performs none. */
export type TransferEmission =
  | { kind: 'reserve'; batchId: string; qty: number }
  | { kind: 'release'; batchId: string; qty: number }
  | { kind: 'ship'; batchId: string; qty: number; fromClinicId: string; toClinicId: string }
  | { kind: 'event'; type: string; payload: Readonly<Record<string, unknown>> }

/**
 * Confirmations arrive independently and possibly hours apart — the sender may
 * regain signal in the next village while the receiver's phone is dead.
 */
export interface TransferState {
  readonly status: TransferStatus
  readonly senderCode: string | null
  readonly receiverCode: string | null
  readonly reservedUntil: Iso | null
  readonly acceptedAt: Iso | null
  readonly dispatchedAt: Iso | null
  readonly completedAt: Iso | null
  /** What the SENDER's device reported the receiver read out. */
  readonly senderConfirmedCode: string | null
  /** What the RECEIVER's device reported the sender read out. */
  readonly receiverConfirmedCode: string | null
  readonly disputeNote: string | null
}

const TERMINAL: ReadonlySet<TransferStatus> = new Set<TransferStatus>([
  'completed',
  'declined',
  'cancelled',
  'expired',
  'disputed',
])

export function isTerminal(status: TransferStatus): boolean {
  return TERMINAL.has(status)
}

export function initialState(): TransferState {
  return {
    status: 'proposed',
    senderCode: null,
    receiverCode: null,
    reservedUntil: null,
    acceptedAt: null,
    dispatchedAt: null,
    completedAt: null,
    senderConfirmedCode: null,
    receiverConfirmedCode: null,
    disputeNote: null,
  }
}

export function stateOf(t: Transfer): TransferState {
  return {
    status: t.status,
    senderCode: t.senderCode,
    receiverCode: t.receiverCode,
    reservedUntil: t.reservedUntil,
    acceptedAt: t.acceptedAt,
    dispatchedAt: t.dispatchedAt,
    completedAt: t.completedAt,
    senderConfirmedCode: null,
    receiverConfirmedCode: null,
    disputeNote: null,
  }
}

export interface TransferContext {
  readonly batchId: string
  readonly qty: number
  readonly fromClinicId: string
  readonly toClinicId: string
}

export function reduce(
  state: TransferState,
  event: TransferEvent,
  ctx: TransferContext,
): TransferResult {
  if (isTerminal(state.status)) {
    // A queued action that surfaces after the transfer already resolved. Refuse
    // loudly — this is the offline replay case and it must never mutate.
    return { ok: false, refusal: { kind: 'already_terminal', state: state.status } }
  }

  switch (event.type) {
    case 'accept': {
      if (state.status !== 'proposed') return wrongState(state, event)
      return {
        ok: true,
        state: {
          ...state,
          status: 'accepted',
          senderCode: event.senderCode,
          receiverCode: event.receiverCode,
          reservedUntil: event.reservedUntil,
          acceptedAt: event.at,
        },
        emits: [
          { kind: 'reserve', batchId: ctx.batchId, qty: ctx.qty },
          {
            kind: 'event',
            type: 'transfer_accepted',
            payload: { reservedUntil: event.reservedUntil },
          },
        ],
      }
    }

    case 'decline': {
      if (state.status !== 'proposed') return wrongState(state, event)
      return {
        ok: true,
        state: { ...state, status: 'declined' },
        emits: [
          {
            kind: 'event',
            type: 'transfer_declined',
            payload: { by: event.byClinicId, note: event.note ?? null },
          },
        ],
      }
    }

    case 'dispatch': {
      if (state.status !== 'accepted') return wrongState(state, event)
      return {
        ok: true,
        state: { ...state, status: 'in_transit', dispatchedAt: event.at },
        emits: [
          {
            kind: 'ship',
            batchId: ctx.batchId,
            qty: ctx.qty,
            fromClinicId: ctx.fromClinicId,
            toClinicId: ctx.toClinicId,
          },
          { kind: 'event', type: 'transfer_dispatched', payload: {} },
        ],
      }
    }

    case 'confirm':
      return confirm(state, event, ctx)

    case 'cancel': {
      if (state.status !== 'accepted') return wrongState(state, event)
      return {
        ok: true,
        state: { ...state, status: 'cancelled' },
        emits: [
          { kind: 'release', batchId: ctx.batchId, qty: ctx.qty },
          {
            kind: 'event',
            type: 'transfer_cancelled',
            payload: { by: event.byClinicId, note: event.note ?? null },
          },
        ],
      }
    }

    case 'expire': {
      // TTL only bites on accepted-but-never-dispatched. Stock already on a
      // motorbike is not released by a clock.
      if (state.status !== 'accepted') return wrongState(state, event)
      if (state.reservedUntil !== null && event.at < state.reservedUntil) {
        return {
          ok: false,
          refusal: { kind: 'not_yet_expired', reservedUntil: state.reservedUntil, at: event.at },
        }
      }
      return {
        ok: true,
        state: { ...state, status: 'expired' },
        emits: [
          { kind: 'release', batchId: ctx.batchId, qty: ctx.qty },
          { kind: 'event', type: 'transfer_expired', payload: { reservedUntil: state.reservedUntil } },
        ],
      }
    }

    case 'dispute': {
      if (state.status !== 'in_transit') return wrongState(state, event)
      return {
        ok: true,
        state: { ...state, status: 'disputed', disputeNote: event.note },
        // disputed is terminal (isTerminal), so this is the last chance to
        // release the reservation. Leaving it held forever after a dispute
        // that can never resolve itself is a stock leak: the vials become
        // permanently uncountable, understating this clinic's true stock to
        // every future match and claim with no way back.
        emits: [
          { kind: 'release', batchId: ctx.batchId, qty: ctx.qty },
          { kind: 'event', type: 'transfer_disputed', payload: { note: event.note } },
        ],
      }
    }
  }
}

/**
 * The dual-code reconciliation — must-build #4.
 *
 * Codes are issued at accept and exchanged verbally at the roadside, where there
 * is no signal. Each device records what it heard; the halves reconcile whenever
 * either side reconnects.
 *
 *   both halves present and correct  -> completed
 *   one half only                    -> stays in_transit, pending on both boards
 *   a half that does not match        -> disputed, with the full trail
 *
 * The one-sided case is the important one. The receiver's phone dying on the road
 * must not produce a false completion (stock reconciled that never arrived) or a
 * false failure (a real handoff marked lost). "Waiting for the other side" is the
 * honest answer and it is the one this returns.
 */
function confirm(
  state: TransferState,
  event: Extract<TransferEvent, { type: 'confirm' }>,
  ctx: TransferContext,
): TransferResult {
  if (state.status !== 'in_transit') return wrongState(state, event)

  // The sender reads out the RECEIVER's code and vice versa: each side proves it
  // met the other. A side echoing its own code proves only that it can read its
  // own screen.
  const expected = event.side === 'sender' ? state.receiverCode : state.senderCode

  if (expected !== null && event.code !== expected) {
    return {
      ok: true,
      state: {
        ...state,
        status: 'disputed',
        disputeNote: `${event.side} reported code ${event.code}, expected ${expected}`,
        ...(event.side === 'sender'
          ? { senderConfirmedCode: event.code }
          : { receiverConfirmedCode: event.code }),
      },
      // Release, don't hold. disputed is terminal — there is no later state
      // that will ever release this reservation otherwise. Which clinic
      // physically has the vials is genuinely unknown at this point (that is
      // what "disputed" means), so this does not attempt to move stock
      // between ledgers; it only frees the number so it stops being
      // double-counted as both "on this clinic's shelf" and "promised
      // elsewhere" forever. Reconciling where the vials actually ended up is
      // a phone call between the two clinics, recorded afterward as a
      // `correction` movement on whichever shelf turns out to hold them.
      emits: [
        { kind: 'release', batchId: ctx.batchId, qty: ctx.qty },
        {
          kind: 'event',
          type: 'transfer_disputed',
          payload: { side: event.side, reported: event.code, expected },
        },
      ],
    }
  }

  const next: TransferState = {
    ...state,
    ...(event.side === 'sender'
      ? { senderConfirmedCode: event.code }
      : { receiverConfirmedCode: event.code }),
  }

  const bothConfirmed = next.senderConfirmedCode !== null && next.receiverConfirmedCode !== null
  if (!bothConfirmed) {
    return {
      ok: true,
      state: next,
      emits: [{ kind: 'event', type: 'transfer_confirmed', payload: { side: event.side } }],
    }
  }

  return {
    ok: true,
    state: { ...next, status: 'completed', completedAt: event.at },
    emits: [
      { kind: 'release', batchId: ctx.batchId, qty: ctx.qty },
      { kind: 'event', type: 'transfer_completed', payload: {} },
    ],
  }
}

function wrongState(state: TransferState, event: TransferEvent): TransferResult {
  return { ok: false, refusal: { kind: 'wrong_state', from: state.status, event: event.type } }
}

/** Fold a whole event history. Used by tests and by the audit-trail view. */
export function replay(
  events: readonly TransferEvent[],
  ctx: TransferContext,
  from: TransferState = initialState(),
): { state: TransferState; refusals: TransferRefusal[] } {
  let state = from
  const refusals: TransferRefusal[] = []
  for (const event of events) {
    const result = reduce(state, event, ctx)
    if (result.ok) state = result.state
    else refusals.push(result.refusal)
  }
  return { state, refusals }
}
