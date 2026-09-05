import { describe, expect, it } from 'vitest'
import {
  available,
  deriveReserved,
  mergeMovements,
  onHandForBatch,
  reservedDrift,
  sortByServerTime,
  validateMovement,
} from './ledger'
import type { Batch, StockMovement, Transfer } from './types'

const batch = (over: Partial<Batch> = {}): Batch => ({
  id: 'b1',
  clinicId: 'c1',
  drugId: 'd1',
  batchNo: 'FMD-2291',
  expiryDate: '2026-10-01',
  coldChainOk: true,
  qtyReserved: 0,
  status: 'active',
  ...over,
})

let n = 0
const mv = (delta: number, over: Partial<StockMovement> = {}): StockMovement => {
  n += 1
  return {
    id: `m${n}`,
    batchId: 'b1',
    delta,
    reason: delta > 0 ? 'received' : 'dispensed',
    actorClinicId: 'c1',
    clientId: `client-${n}`,
    clientTs: '2026-09-05T10:00:00.000Z',
    serverTs: '2026-09-05T10:00:01.000Z',
    ...over,
  }
}

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: 't1',
  requestId: null,
  batchId: 'b1',
  fromClinicId: 'c1',
  toClinicId: 'c2',
  qty: 4,
  senderCode: null,
  receiverCode: null,
  status: 'accepted',
  reservedUntil: null,
  createdAt: '2026-09-05T10:00:00.000Z',
  acceptedAt: null,
  dispatchedAt: null,
  completedAt: null,
  ...over,
})

describe('on-hand is derived, never stored', () => {
  it('sums signed deltas', () => {
    expect(onHandForBatch('b1', [mv(20), mv(-5), mv(-3)])).toBe(12)
  })

  it('ignores other batches', () => {
    expect(onHandForBatch('b1', [mv(20), mv(50, { batchId: 'b2' })])).toBe(20)
  })

  it('is empty-safe', () => {
    expect(onHandForBatch('b1', [])).toBe(0)
  })

  /**
   * The reason the whole system is built this way. Two field workers, both with
   * no signal, both dispense 5 vials from the same batch. Neither device can see
   * the other. When they sync, the answer must be 12 - 5 - 5 = 2.
   */
  it('merges concurrent offline dispenses additively, not last-write-wins', () => {
    const opening = [mv(12)]
    const deviceA = mv(-5, { clientId: 'device-a-uuid', actorClinicId: 'c1' })
    const deviceB = mv(-5, { clientId: 'device-b-uuid', actorClinicId: 'c1' })

    expect(onHandForBatch('b1', mergeMovements(opening, [deviceA, deviceB]))).toBe(2)
    // Order of arrival cannot change the result — deltas commute.
    expect(onHandForBatch('b1', mergeMovements(opening, [deviceB, deviceA]))).toBe(2)
  })
})

describe('idempotent replay', () => {
  it('collapses a write retried three times on a flaky connection', () => {
    const write = mv(-5, { clientId: 'same-uuid' })
    const merged = mergeMovements([mv(12)], [write, { ...write }, { ...write }])
    expect(merged).toHaveLength(2)
    expect(onHandForBatch('b1', merged)).toBe(7)
  })

  it('prefers the server-confirmed row over the local echo', () => {
    const local = mv(-5, { clientId: 'u1', serverTs: null })
    const confirmed = mv(-5, { clientId: 'u1', serverTs: '2026-09-05T11:00:00.000Z' })
    const merged = mergeMovements([local], [confirmed])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.serverTs).toBe('2026-09-05T11:00:00.000Z')
  })

  it('does not regress a confirmed row back to unconfirmed', () => {
    const confirmed = mv(-5, { clientId: 'u1', serverTs: '2026-09-05T11:00:00.000Z' })
    const local = mv(-5, { clientId: 'u1', serverTs: null })
    expect(mergeMovements([confirmed], [local])[0]?.serverTs).not.toBeNull()
  })
})

describe('ordering', () => {
  it('orders by server time, never client time', () => {
    // A handset with a badly wrong clock must not reshuffle the shared ledger.
    const skewed = mv(-1, {
      clientId: 'skewed',
      clientTs: '2020-01-01T00:00:00.000Z',
      serverTs: '2026-09-05T12:00:00.000Z',
    })
    const normal = mv(-1, {
      clientId: 'normal',
      clientTs: '2026-09-05T11:59:00.000Z',
      serverTs: '2026-09-05T11:00:00.000Z',
    })
    expect(sortByServerTime([skewed, normal]).map((m) => m.clientId)).toEqual(['normal', 'skewed'])
  })

  it('sorts unsynced rows last — they have not happened yet for anyone else', () => {
    const pending = mv(-1, { clientId: 'pending', serverTs: null })
    const synced = mv(-1, { clientId: 'synced', serverTs: '2026-09-05T11:00:00.000Z' })
    expect(sortByServerTime([pending, synced]).map((m) => m.clientId)).toEqual(['synced', 'pending'])
  })
})

describe('available vs on-hand', () => {
  it('subtracts reserved vials', () => {
    expect(available(batch({ qtyReserved: 4 }), [mv(12)])).toBe(8)
  })

  it('never reports negative', () => {
    expect(available(batch({ qtyReserved: 20 }), [mv(12)])).toBe(0)
  })
})

describe('qty_reserved is a lock-protected cache of a derived value', () => {
  it('derives reserved from accepted and in-transit transfers only', () => {
    const ts = [
      transfer({ id: 't1', qty: 4, status: 'accepted' }),
      transfer({ id: 't2', qty: 3, status: 'in_transit' }),
      transfer({ id: 't3', qty: 9, status: 'completed' }),
      transfer({ id: 't4', qty: 7, status: 'declined' }),
      transfer({ id: 't5', qty: 5, status: 'expired' }),
    ]
    expect(deriveReserved('b1', ts)).toBe(7)
  })

  it('holds the invariant: cached column equals derived truth', () => {
    const ts = [transfer({ qty: 4, status: 'accepted' })]
    expect(reservedDrift(batch({ qtyReserved: 4 }), ts)).toBe(0)
  })

  it('detects drift when the cache is wrong', () => {
    const ts = [transfer({ qty: 4, status: 'accepted' })]
    expect(reservedDrift(batch({ qtyReserved: 9 }), ts)).toBe(5)
  })
})

describe('own-clinic movement validation', () => {
  it('rejects dispensing more than is on hand', () => {
    expect(validateMovement(batch(), [mv(3)], -5, 'dispensed')).toEqual({
      ok: false,
      reason: 'would_go_negative',
      onHand: 3,
      requested: 5,
    })
  })

  it('rejects dispensing vials already promised to a neighbour', () => {
    expect(validateMovement(batch({ qtyReserved: 10 }), [mv(12)], -5, 'dispensed')).toEqual({
      ok: false,
      reason: 'reserved_stock',
      available: 2,
      requested: 5,
    })
  })

  it('lets a transfer-out consume the reservation it is fulfilling', () => {
    expect(validateMovement(batch({ qtyReserved: 10 }), [mv(12)], -5, 'transferred_out')).toEqual({
      ok: true,
    })
  })

  it('lets a correction reconcile reality against reserved stock', () => {
    expect(validateMovement(batch({ qtyReserved: 10 }), [mv(12)], -5, 'correction')).toEqual({
      ok: true,
    })
  })

  it('always allows receiving stock', () => {
    expect(validateMovement(batch(), [], 40, 'received')).toEqual({ ok: true })
  })

  it('rejects a no-op', () => {
    expect(validateMovement(batch(), [mv(5)], 0, 'correction')).toEqual({
      ok: false,
      reason: 'zero_delta',
    })
  })
})
