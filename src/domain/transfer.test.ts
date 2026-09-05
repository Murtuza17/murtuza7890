import { describe, expect, it } from 'vitest'
import {
  initialState,
  isTerminal,
  reduce,
  replay,
  type TransferContext,
  type TransferEvent,
  type TransferState,
} from './transfer'

const ctx: TransferContext = {
  batchId: 'b1',
  qty: 4,
  fromClinicId: 'clinic-marur',
  toClinicId: 'clinic-kadthal',
}

const ACCEPT: TransferEvent = {
  type: 'accept',
  at: '2026-09-05T10:00:00.000Z',
  senderCode: '418239',
  receiverCode: '907114',
  reservedUntil: '2026-09-06T10:00:00.000Z',
}

/** Drive to a state via the happy path so each test starts where it means to. */
function at(...events: TransferEvent[]): TransferState {
  const { state, refusals } = replay(events, ctx)
  expect(refusals).toEqual([])
  return state
}

const accepted = () => at(ACCEPT)
const inTransit = () => at(ACCEPT, { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' })

describe('happy path', () => {
  it('proposed -> accepted -> in_transit -> completed', () => {
    const state = at(
      ACCEPT,
      { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' },
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
      { type: 'confirm', at: '2026-09-05T12:30:00.000Z', side: 'receiver', code: '418239' },
    )
    expect(state.status).toBe('completed')
    expect(state.completedAt).toBe('2026-09-05T12:30:00.000Z')
  })

  it('issues both codes at accept, not at dispatch', () => {
    // The handoff happens on a road with no signal — codes must already be in
    // hand on both devices before either leaves.
    const state = accepted()
    expect(state.senderCode).toBe('418239')
    expect(state.receiverCode).toBe('907114')
    expect(state.reservedUntil).toBe('2026-09-06T10:00:00.000Z')
  })

  it('reserves on accept and releases on completion', () => {
    const acceptRes = reduce(initialState(), ACCEPT, ctx)
    expect(acceptRes.ok && acceptRes.emits).toContainEqual({ kind: 'reserve', batchId: 'b1', qty: 4 })

    const state = at(
      ACCEPT,
      { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' },
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
    )
    const final = reduce(
      state,
      { type: 'confirm', at: '2026-09-05T12:30:00.000Z', side: 'receiver', code: '418239' },
      ctx,
    )
    expect(final.ok && final.emits).toContainEqual({ kind: 'release', batchId: 'b1', qty: 4 })
  })

  it('emits the shipping movement on dispatch', () => {
    const res = reduce(accepted(), { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' }, ctx)
    expect(res.ok && res.emits).toContainEqual({
      kind: 'ship',
      batchId: 'b1',
      qty: 4,
      fromClinicId: 'clinic-marur',
      toClinicId: 'clinic-kadthal',
    })
  })
})

describe('roadside handoff reconciliation', () => {
  it('stays in_transit when only one side has confirmed', () => {
    // The receiver's phone died on the road. Not complete, not failed — pending.
    const res = reduce(
      inTransit(),
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
      ctx,
    )
    expect(res.ok && res.state.status).toBe('in_transit')
    expect(res.ok && res.state.senderConfirmedCode).toBe('907114')
    expect(res.ok && res.state.receiverConfirmedCode).toBeNull()
  })

  it('does not release the reservation on a one-sided confirm', () => {
    const res = reduce(
      inTransit(),
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
      ctx,
    )
    expect(res.ok && res.emits.some((e) => e.kind === 'release')).toBe(false)
  })

  it('completes regardless of which side reconnects first', () => {
    const senderFirst = at(
      ACCEPT,
      { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' },
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
      { type: 'confirm', at: '2026-09-05T13:00:00.000Z', side: 'receiver', code: '418239' },
    )
    const receiverFirst = at(
      ACCEPT,
      { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' },
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'receiver', code: '418239' },
      { type: 'confirm', at: '2026-09-05T13:00:00.000Z', side: 'sender', code: '907114' },
    )
    expect(senderFirst.status).toBe('completed')
    expect(receiverFirst.status).toBe('completed')
  })

  it('disputes on a code mismatch rather than guessing', () => {
    const res = reduce(
      inTransit(),
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '000000' },
      ctx,
    )
    expect(res.ok && res.state.status).toBe('disputed')
    expect(res.ok && res.state.disputeNote).toContain('000000')
  })

  it('requires each side to report the OTHER side’s code', () => {
    // Echoing your own code proves only that you can read your own screen.
    const res = reduce(
      inTransit(),
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '418239' },
      ctx,
    )
    expect(res.ok && res.state.status).toBe('disputed')
  })

  it('refuses confirmation before dispatch', () => {
    const res = reduce(
      accepted(),
      { type: 'confirm', at: '2026-09-05T12:00:00.000Z', side: 'sender', code: '907114' },
      ctx,
    )
    expect(res).toEqual({
      ok: false,
      refusal: { kind: 'wrong_state', from: 'accepted', event: 'confirm' },
    })
  })
})

describe('reservation TTL', () => {
  it('expires an accepted-but-never-dispatched transfer and releases the stock', () => {
    // Without this, a clinic locks scarce anti-venom indefinitely by accepting
    // and going quiet.
    const res = reduce(accepted(), { type: 'expire', at: '2026-09-06T10:00:01.000Z' }, ctx)
    expect(res.ok && res.state.status).toBe('expired')
    expect(res.ok && res.emits).toContainEqual({ kind: 'release', batchId: 'b1', qty: 4 })
  })

  it('refuses to expire before the TTL elapses', () => {
    const res = reduce(accepted(), { type: 'expire', at: '2026-09-05T18:00:00.000Z' }, ctx)
    expect(res).toEqual({
      ok: false,
      refusal: {
        kind: 'not_yet_expired',
        reservedUntil: '2026-09-06T10:00:00.000Z',
        at: '2026-09-05T18:00:00.000Z',
      },
    })
  })

  it('never expires stock already on a motorbike', () => {
    const res = reduce(inTransit(), { type: 'expire', at: '2026-09-09T00:00:00.000Z' }, ctx)
    expect(res).toEqual({
      ok: false,
      refusal: { kind: 'wrong_state', from: 'in_transit', event: 'expire' },
    })
  })
})

describe('refusals are total and typed', () => {
  it('declines only from proposed', () => {
    const res = reduce(
      accepted(),
      { type: 'decline', at: '2026-09-05T11:00:00.000Z', byClinicId: 'c2' },
      ctx,
    )
    expect(res.ok).toBe(false)
  })

  it('cancels only from accepted, and releases', () => {
    const res = reduce(
      accepted(),
      { type: 'cancel', at: '2026-09-05T11:00:00.000Z', byClinicId: 'c1' },
      ctx,
    )
    expect(res.ok && res.state.status).toBe('cancelled')
    expect(res.ok && res.emits).toContainEqual({ kind: 'release', batchId: 'b1', qty: 4 })
  })

  it('cannot double-accept', () => {
    expect(reduce(accepted(), ACCEPT, ctx)).toEqual({
      ok: false,
      refusal: { kind: 'wrong_state', from: 'accepted', event: 'accept' },
    })
  })

  it.each(['completed', 'declined', 'cancelled', 'expired', 'disputed'] as const)(
    'refuses every event from terminal state %s',
    (status) => {
      const terminal: TransferState = { ...initialState(), status }
      expect(isTerminal(status)).toBe(true)
      const res = reduce(terminal, { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' }, ctx)
      expect(res).toEqual({ ok: false, refusal: { kind: 'already_terminal', state: status } })
    },
  )

  /**
   * The offline replay case. A worker taps Dispatch with no signal; by the time
   * the queue drains the transfer has been cancelled by the other clinic. The
   * stale event must be refused explicitly, never silently applied.
   */
  it('refuses a stale queued event against a moved-on state without mutating', () => {
    const cancelled = at(ACCEPT, { type: 'cancel', at: '2026-09-05T11:00:00.000Z', byClinicId: 'c1' })
    const res = reduce(cancelled, { type: 'dispatch', at: '2026-09-05T10:30:00.000Z' }, ctx)
    expect(res).toEqual({ ok: false, refusal: { kind: 'already_terminal', state: 'cancelled' } })
  })
})

describe('replay', () => {
  it('is deterministic — same events, same state', () => {
    const events: TransferEvent[] = [ACCEPT, { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' }]
    expect(replay(events, ctx).state).toEqual(replay(events, ctx).state)
  })

  it('collects refusals without aborting the fold', () => {
    const { state, refusals } = replay(
      [
        ACCEPT,
        ACCEPT,
        { type: 'dispatch', at: '2026-09-05T11:00:00.000Z' },
      ],
      ctx,
    )
    expect(state.status).toBe('in_transit')
    expect(refusals).toHaveLength(1)
  })
})
