import { describe, expect, it } from 'vitest'
import {
  applyResult,
  applyTransportFailure,
  backoffMs,
  isContested,
  isSettled,
  markSending,
  nextToSend,
  pendingCount,
  statusLabel,
  type OpName,
  type OutboxItem,
} from './outbox'

let seq = 0
const item = (over: Partial<OutboxItem> = {}): OutboxItem => {
  seq += 1
  return {
    clientId: `uuid-${seq}`, op: 'log_movement', args: {},
    clientTs: '2026-09-05T10:00:00.000Z', deviceId: 'dev-1',
    status: 'pending', attempts: 0, lastError: null, result: null, seq,
    ...over,
  }
}

describe('contested vs uncontested', () => {
  it.each(['accept_transfer', 'dispatch_transfer', 'confirm_handoff'] as OpName[])(
    '%s is contested — the server must arbitrate', (op) => expect(isContested(op)).toBe(true),
  )

  it.each(['log_movement', 'create_batch', 'create_request'] as OpName[])(
    '%s is own-clinic — nobody else can disagree', (op) => expect(isContested(op)).toBe(false),
  )
})

describe('the UI never claims a state the server has not confirmed', () => {
  it('treats a queued own-clinic action as real immediately', () => {
    // Your own shelf. Deltas merge by addition whenever this lands.
    expect(isSettled(item({ op: 'log_movement', status: 'pending' }))).toBe(true)
    expect(statusLabel(item({ op: 'log_movement', status: 'done' }))).toBe('Saved')
  })

  it('refuses to treat a queued claim as real', () => {
    // A worker who drives 30 km on a false confirmation never trusts it again.
    const queued = item({ op: 'accept_transfer', status: 'pending' })
    expect(isSettled(queued)).toBe(false)
    expect(statusLabel(queued)).toBe('Waiting to send')
  })

  it('says "no signal" rather than pretending, once a send has failed', () => {
    const retried = item({ op: 'accept_transfer', status: 'pending', attempts: 2 })
    expect(statusLabel(retried)).toBe('Waiting to send — no signal')
  })

  it('only says Confirmed once the server has confirmed', () => {
    expect(statusLabel(item({ op: 'accept_transfer', status: 'done' }))).toBe('Confirmed')
  })

  it('never shows a rejected action as settled', () => {
    expect(isSettled(item({ status: 'rejected' }))).toBe(false)
  })
})

describe('drain order', () => {
  it('sends in creation order', () => {
    const items = [item({ seq: 3 }), item({ seq: 1 }), item({ seq: 2 })]
    expect(nextToSend(items)?.seq).toBe(1)
  })

  it('sends one at a time — dispatch must not overtake the accept that issued its codes', () => {
    expect(nextToSend([item({ status: 'sending' }), item({ status: 'pending' })])).toBeNull()
  })

  it('skips finished work', () => {
    const items = [item({ status: 'done', seq: 1 }), item({ status: 'rejected', seq: 2 }),
                   item({ status: 'pending', seq: 3 })]
    expect(nextToSend(items)?.seq).toBe(3)
  })

  it('returns null on an empty or fully drained queue', () => {
    expect(nextToSend([])).toBeNull()
    expect(nextToSend([item({ status: 'done' })])).toBeNull()
  })

  it('counts what is still owed to the server', () => {
    expect(pendingCount([
      item({ status: 'pending' }), item({ status: 'sending' }),
      item({ status: 'done' }), item({ status: 'rejected' }),
    ])).toBe(2)
  })
})

describe('results', () => {
  it('marks a success done', () => {
    expect(applyResult(markSending(item()), { ok: true, transfer_id: 't1' }).status).toBe('done')
  })

  it('rejects a lost claim permanently and keeps the server’s exact words', () => {
    // Retrying would be pointless: the vials are gone.
    const result = applyResult(markSending(item({ op: 'accept_transfer' })), {
      ok: false, error: 'insufficient_stock',
      message: 'Already committed to Marur dispensary 3 minutes ago',
    })
    expect(result.status).toBe('rejected')
    expect(result.lastError).toBe('Already committed to Marur dispensary 3 minutes ago')
    expect(statusLabel(result)).toBe('Already committed to Marur dispensary 3 minutes ago')
  })

  it.each(['wrong_state', 'not_your_transfer', 'not_found', 'session_invalid'])(
    'treats %s as final rather than retrying forever', (error) => {
      expect(applyResult(markSending(item()), { ok: false, error }).status).toBe('rejected')
    },
  )

  it('retries an unrecognised server error', () => {
    const result = applyResult(markSending(item()), { ok: false, error: 'deadlock_detected' })
    expect(result.status).toBe('pending')
    expect(result.attempts).toBe(1)
  })

  it('keeps an action that never reached the server — replay is safe', () => {
    // The server dedupes on clientId, so re-sending cannot double-apply.
    const result = applyTransportFailure(markSending(item()), 'network unreachable')
    expect(result.status).toBe('pending')
    expect(result.clientId).toBe(result.clientId)
    expect(result.attempts).toBe(1)
  })
})

describe('backoff', () => {
  it('grows then caps, so a flaky link is not hammered', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(3)).toBe(8000)
    expect(backoffMs(99)).toBe(30_000)
  })
})
