import { describe, expect, it } from 'vitest'
import { anticipateTransfers, bestPerNeed, type AnticipateInput, type ClinicDrugPosition } from './anticipate'
import { demandSignal, type ConsumptionStats } from './forecast'
import type { Clinic, Drug } from './types'

const now = new Date('2026-09-05T10:00:00.000Z')

const HUB: Clinic = {
  id: 'c-mbnr', code: 'MBNR', name: 'Mahabubnagar Veterinary Dispensary',
  village: 'Mahabubnagar', district: 'Mahabubnagar', lat: 16.7488, lng: 77.9854, phone: '',
}
const NEAR: Clinic = {
  id: 'c-addakal', code: 'ADKL', name: 'Addakal Dispensary', village: 'Addakal',
  district: 'Mahabubnagar', lat: 16.65, lng: 78.05, phone: '',
}
const FAR: Clinic = {
  id: 'c-midjil', code: 'MDJL', name: 'Midjil Dispensary', village: 'Midjil',
  district: 'Mahabubnagar', lat: 16.7167, lng: 78.3, phone: '',
}

const FMD: Drug = {
  id: 'd-fmd', name: 'Foot & Mouth Disease vaccine', form: 'vial', unit: 'vial',
  requiresColdChain: true, category: 'vaccine',
}

const signal = (over: Partial<ConsumptionStats>) =>
  demandSignal({
    dispensed14d: 0, dispensed30d: 0, dispensed90d: 0, events: 0, events14d: 0,
    observedDays: 90, ...over,
  })

/** Watched 60 days, never dispensed: high confidence the whole batch is doomed. */
const IDLE = signal({ dispensed90d: 0, events: 0, observedDays: 60 })
/** 1/day, steadily. */
const STEADY = signal({ dispensed90d: 90, events: 30, observedDays: 90 })

const batch = (over: Partial<ClinicDrugPosition['batches'][number]> = {}) => ({
  id: 'b1', batchNo: 'FMD-1', expiryDate: '2026-10-05', coldChainOk: true,
  status: 'active', available: 30, ...over,
})

const position = (over: Partial<ClinicDrugPosition>): ClinicDrugPosition => ({
  clinicId: 'c-addakal', drugId: 'd-fmd', onHand: 30, signal: IDLE, batches: [batch()], ...over,
})

/**
 * A receiver's usable stock now comes from its batches, not the `onHand`
 * scalar — onHand can include expired or quarantined vials, which must not
 * count as cover. Every receiver fixture below has to actually hold what its
 * `onHand` claims, so this line-up should read exactly as onHand.
 */
const holding = (qty: number) => [batch({ id: 'stock', batchNo: 'STOCK', available: qty })]

function input(positions: ClinicDrugPosition[], over: Partial<AnticipateInput> = {}): AnticipateInput {
  return {
    positions,
    clinicsById: new Map([HUB, NEAR, FAR].map((c) => [c.id, c])),
    drugsById: new Map([[FMD.id, FMD]]),
    radiusKm: 40,
    now,
    ...over,
  }
}

describe('proposing a transfer nobody asked for', () => {
  it('pairs a clinic that will waste stock with one that will run out', () => {
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 5, batches: holding(5) }),
    ]))
    expect(out).toHaveLength(1)
    expect(out[0]?.fromClinicId).toBe('c-addakal')
    expect(out[0]?.toClinicId).toBe('c-mbnr')
    expect(out[0]?.receiverRunsOutInDays).toBe(5)
  })

  it('says why, in terms a worker can check', () => {
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 5, batches: holding(5) }),
    ]))
    expect(out[0]?.why).toContain('Addakal is not using these')
    expect(out[0]?.why).toContain('Mahabubnagar runs out in 5 days')
    expect(out[0]?.why).toMatch(/\d+ km|\d+\.\d km/)
  })

  it('proposes nothing when both clinics are using their stock', () => {
    expect(anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: STEADY, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 30 }),
    ]))).toHaveLength(0)
  })
})

describe('guard 1: a suggestion must never cause the stockout it prevents', () => {
  it('never moves more than the sender was going to waste anyway', () => {
    // Sender uses 0.5/day and holds 30 with 30 days left: uses ~15, wastes ~15.
    // Even facing a huge shortfall, only the surplus may move.
    const senderSignal = signal({ dispensed90d: 45, events: 12, observedDays: 90 })
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: senderSignal, onHand: 30 }),
      position({
        clinicId: 'c-mbnr',
        signal: signal({ dispensed90d: 450, events: 60, observedDays: 90 }),
        onHand: 1, batches: holding(1),
      }),
    ]))
    expect(out[0]?.qty).toBeLessThanOrEqual(15)
    expect(out[0]?.qty).toBeGreaterThan(0)
  })
})

describe('guard 2: a suggestion must not just relocate the bin', () => {
  it('caps at what the receiver can actually use before the same expiry date', () => {
    // 40 vials expiring in 4 days, receiver burns 1/day: they can use 4, not 40.
    // Moving all 40 would "save" 36 vials into a different bin.
    const out = anticipateTransfers(input([
      position({
        clinicId: 'c-addakal', signal: IDLE, onHand: 40,
        batches: [batch({ available: 40, expiryDate: '2026-09-09' })],
      }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 0, batches: [] }),
    ]))
    expect(out[0]?.qty).toBeLessThanOrEqual(4)
  })

  it('proposes nothing when the receiver could not use any of it in time', () => {
    // Expires tomorrow; receiver uses 1/day and already holds 5.
    expect(anticipateTransfers(input([
      position({
        clinicId: 'c-addakal', signal: IDLE, onHand: 40,
        batches: [batch({ available: 40, expiryDate: '2026-09-06' })],
      }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 5, batches: holding(5) }),
    ]))).toHaveLength(0)
  })
})

describe('safety filters', () => {
  it('never proposes moving a batch whose cold chain is broken', () => {
    expect(anticipateTransfers(input([
      position({
        clinicId: 'c-addakal', signal: IDLE, onHand: 30,
        batches: [batch({ coldChainOk: false })],
      }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 2, batches: holding(2) }),
    ]))).toHaveLength(0)
  })

  it('never proposes a quarantined or expired batch', () => {
    expect(anticipateTransfers(input([
      position({
        clinicId: 'c-addakal', signal: IDLE, onHand: 30,
        batches: [batch({ status: 'quarantined' })],
      }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 2, batches: holding(2) }),
    ]))).toHaveLength(0)
  })

  it('stays inside the radius', () => {
    expect(anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-midjil', signal: STEADY, onHand: 2, batches: holding(2) }),
    ], { radiusKm: 10 }))).toHaveLength(0)
  })

  it('flags a cold box when the trip is too long unrefrigerated', () => {
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-midjil', signal: STEADY, onHand: 2, batches: holding(2) }),
    ]))
    expect(out[0]?.needsColdBox).toBe(true)
  })
})

describe('the honesty rule holds here too', () => {
  it('proposes nothing off the back of a clinic we have barely observed', () => {
    const brandNew = signal({ dispensed90d: 20, events: 2, observedDays: 3 })
    expect(anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: brandNew, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 2, batches: holding(2) }),
    ]))).toHaveLength(0)
  })

  it('carries the weaker of the two forecasts, not the flattering one', () => {
    const thin = signal({ dispensed90d: 20, events: 3, observedDays: 10 })  // low
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),        // high
      position({ clinicId: 'c-mbnr', signal: thin, onHand: 1, batches: holding(1) }),
    ]))
    expect(out[0]?.confidence).toBe('low')
  })
})

describe('ranking and de-duplication', () => {
  it('puts the clinic that runs out soonest first', () => {
    const out = anticipateTransfers(input([
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 2, batches: holding(2) }),
      position({ clinicId: 'c-midjil', signal: STEADY, onHand: 9, batches: holding(9) }),
    ]))
    expect(out.map((t) => t.toClinicId)).toEqual(['c-mbnr', 'c-midjil'])
  })

  it('shows one suggestion per need, not a wall of them', () => {
    // Two expiring batches at the sender, one shortage — the worker needs a
    // decision, not an inventory listing.
    const out = anticipateTransfers(input([
      position({
        clinicId: 'c-addakal', signal: IDLE, onHand: 60,
        batches: [batch({ id: 'b1' }), batch({ id: 'b2', batchNo: 'FMD-2' })],
      }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 3, batches: holding(3) }),
    ]))
    expect(out.length).toBeGreaterThan(1)
    expect(bestPerNeed(out)).toHaveLength(1)
  })

  it('is a total order — the board does not reshuffle between reads', () => {
    const positions = [
      position({ clinicId: 'c-addakal', signal: IDLE, onHand: 30 }),
      position({ clinicId: 'c-mbnr', signal: STEADY, onHand: 4, batches: holding(4) }),
      position({ clinicId: 'c-midjil', signal: STEADY, onHand: 4, batches: holding(4) }),
    ]
    const a = anticipateTransfers(input(positions)).map((t) => t.toClinicId)
    const b = anticipateTransfers(input([...positions].reverse())).map((t) => t.toClinicId)
    expect(a).toEqual(b)
  })
})
