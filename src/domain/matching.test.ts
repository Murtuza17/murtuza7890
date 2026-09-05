import { describe, expect, it } from 'vitest'
import { findMatches, formatKm, haversineKm, planFulfilment, type MatchInput } from './matching'
import type { Batch, Clinic, Drug, StockMovement, StockRequest } from './types'

const now = new Date('2026-09-05T10:00:00.000Z')

// Real coordinates, Mahabubnagar district, Telangana. Distances from the hub:
// Addakal 13 km, Jadcherla 18 km, Midjil 34 km — chosen so radius filtering and
// the cold-box threshold both do something interesting. Same set as the seed.
const HUB: Clinic = {
  id: 'c-mbnr', code: 'MBNR', name: 'Mahabubnagar Veterinary Dispensary',
  village: 'Mahabubnagar', district: 'Mahabubnagar', lat: 16.7488, lng: 77.9854,
  phone: '+91 90000 00001',
}
const NEAR: Clinic = {
  id: 'c-addakal', code: 'ADKL', name: 'Addakal Dispensary', village: 'Addakal',
  district: 'Mahabubnagar', lat: 16.65, lng: 78.05, phone: '+91 90000 00002',
}
const FAR: Clinic = {
  id: 'c-midjil', code: 'MDJL', name: 'Midjil Dispensary', village: 'Midjil',
  district: 'Mahabubnagar', lat: 16.7167, lng: 78.3, phone: '+91 90000 00003',
}

const FMD: Drug = {
  id: 'd-fmd', name: 'Foot & Mouth Disease vaccine', form: 'vial', unit: 'vial',
  requiresColdChain: true, category: 'vaccine',
}
const OXYTET: Drug = {
  id: 'd-oxytet', name: 'Oxytetracycline 10%', form: 'vial', unit: 'vial',
  requiresColdChain: false, category: 'antibiotic',
}

const batch = (over: Partial<Batch> & { id: string }): Batch => ({
  clinicId: 'c-addakal', drugId: 'd-fmd', batchNo: 'B-1', expiryDate: '2026-12-01',
  coldChainOk: true, qtyReserved: 0, status: 'active', ...over,
})

const request = (over: Partial<StockRequest> = {}): StockRequest => ({
  id: 'r1', clinicId: 'c-mbnr', drugId: 'd-fmd', qtyNeeded: 10, urgency: 'outbreak',
  radiusKm: 40, neededBy: '2026-09-08', note: '', status: 'open',
  createdAt: '2026-09-05T09:00:00.000Z', ...over,
})

const stock = (batchId: string, qty: number): StockMovement[] => [{
  id: `m-${batchId}`, batchId, delta: qty, reason: 'received', actorClinicId: 'c1',
  clientId: `c-${batchId}`, clientTs: '2026-09-01T00:00:00.000Z',
  serverTs: '2026-09-01T00:00:00.000Z',
}]

function input(over: Partial<MatchInput> & { batches: readonly Batch[] }): MatchInput {
  const movements = new Map<string, readonly StockMovement[]>(
    over.batches.map((b) => [b.id, stock(b.id, 20)]),
  )
  return {
    request: request(), requestingClinic: HUB, drug: FMD,
    clinicsById: new Map([HUB, NEAR, FAR].map((c) => [c.id, c])),
    movementsByBatch: movements, now, ...over,
  }
}

describe('haversine', () => {
  it('is zero for a point against itself', () => {
    expect(haversineKm(HUB, HUB)).toBe(0)
  })

  it('is symmetric', () => {
    expect(haversineKm(HUB, NEAR)).toBeCloseTo(haversineKm(NEAR, HUB), 10)
  })

  it('computes a plausible real-world distance', () => {
    expect(haversineKm(HUB, NEAR)).toBeGreaterThan(12)
    expect(haversineKm(HUB, NEAR)).toBeLessThan(14)
  })

  it('formats for a small screen', () => {
    expect(formatKm(8.42)).toBe('8.4 km')
    expect(formatKm(23.6)).toBe('24 km')
  })
})

describe('filtering', () => {
  it('excludes the requesting clinic’s own stock', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', clinicId: 'c-mbnr' })] }))
    expect(out.matches).toHaveLength(0)
    expect(out.excluded[0]?.reason).toBe('own_clinic')
  })

  it('excludes clinics outside the requested radius', () => {
    const out = findMatches(
      input({ request: request({ radiusKm: 10 }), batches: [batch({ id: 'b1' })] }),
    )
    expect(out.matches).toHaveLength(0)
    expect(out.excluded[0]?.reason).toBe('out_of_radius')
  })

  it('excludes expired batches', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', expiryDate: '2026-09-01' })] }))
    expect(out.excluded[0]?.reason).toBe('expired')
  })

  it('excludes non-active batches', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', status: 'quarantined' })] }))
    expect(out.excluded[0]?.reason).toBe('batch_not_active')
  })

  it('excludes stock that is fully reserved to someone else', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', qtyReserved: 20 })] }))
    expect(out.excluded[0]?.reason).toBe('no_available_stock')
  })

  it('offers only the unreserved remainder', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', qtyReserved: 14 })] }))
    expect(out.matches[0]?.availableQty).toBe(6)
  })

  it('never offers a cold-chain vaccine whose cold chain is already broken', () => {
    // It would arrive inert and be recorded as a successful vaccination.
    const out = findMatches(input({ batches: [batch({ id: 'b1', coldChainOk: false })] }))
    expect(out.matches).toHaveLength(0)
    expect(out.excluded[0]?.reason).toBe('cold_chain_broken')
  })

  it('still offers a non-cold-chain drug with cold chain flagged off', () => {
    const out = findMatches(
      input({
        drug: OXYTET,
        request: request({ drugId: 'd-oxytet' }),
        batches: [batch({ id: 'b1', drugId: 'd-oxytet', coldChainOk: false })],
      }),
    )
    expect(out.matches).toHaveLength(1)
  })
})

describe('ranking', () => {
  it('puts soonest expiry first — wasting stock is the problem being solved', () => {
    const out = findMatches(input({
      batches: [
        batch({ id: 'b-late', expiryDate: '2026-11-30' }),
        batch({ id: 'b-soon', expiryDate: '2026-09-14' }),
      ],
    }))
    expect(out.matches.map((m) => m.batchId)).toEqual(['b-soon', 'b-late'])
  })

  it('breaks an expiry tie by distance', () => {
    const out = findMatches(input({
      batches: [
        batch({ id: 'b-far', clinicId: 'c-midjil', expiryDate: '2026-09-14' }),
        batch({ id: 'b-near', clinicId: 'c-addakal', expiryDate: '2026-09-14' }),
      ],
    }))
    expect(out.matches.map((m) => m.batchId)).toEqual(['b-near', 'b-far'])
  })

  it('breaks a distance tie by larger quantity', () => {
    const batches = [batch({ id: 'b-small' }), batch({ id: 'b-big' })]
    const out = findMatches(input({
      batches,
      movementsByBatch: new Map([['b-small', stock('b-small', 5)], ['b-big', stock('b-big', 30)]]),
    }))
    expect(out.matches.map((m) => m.batchId)).toEqual(['b-big', 'b-small'])
  })

  it('surfaces a match that solves both sides above one that solves only one', () => {
    // Expires in 9 days, needed in 3: the holder avoids waste and the requester
    // gets it in time. That beats in-date stock that solves only the shortage.
    const out = findMatches(input({
      batches: [
        batch({ id: 'b-plenty-of-time', expiryDate: '2027-06-01' }),
        batch({ id: 'b-solves-both', expiryDate: '2026-09-14' }),
      ],
    }))
    expect(out.matches[0]?.batchId).toBe('b-solves-both')
    expect(out.matches[0]?.solvesBoth).toBe(true)
    expect(out.matches[1]?.solvesBoth).toBe(false)
  })

  it('demotes stock that expires before it is needed', () => {
    const out = findMatches(input({
      request: request({ neededBy: '2026-09-20' }),
      batches: [
        batch({ id: 'b-too-soon', expiryDate: '2026-09-10' }),
        batch({ id: 'b-usable', expiryDate: '2026-09-25' }),
      ],
    }))
    expect(out.matches[0]?.batchId).toBe('b-usable')
    expect(out.matches[1]?.arrivesInTime).toBe(false)
  })

  it('is a total order — identical inputs give identical output', () => {
    const batches = [batch({ id: 'b-a' }), batch({ id: 'b-b' })]
    const first = findMatches(input({ batches })).matches.map((m) => m.batchId)
    const second = findMatches(input({ batches: [...batches].reverse() })).matches.map((m) => m.batchId)
    expect(first).toEqual(second)
  })
})

describe('explanation', () => {
  it('always states why a match surfaced', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', expiryDate: '2026-09-14' })] }))
    expect(out.matches[0]?.explain).toBe('13 km · expires in 9 days · 20 vials')
  })

  it('flags a cold-chain drug travelling too far for an unrefrigerated bike', () => {
    const out = findMatches(input({ batches: [batch({ id: 'b1', clinicId: 'c-midjil' })] }))
    expect(out.matches[0]?.needsColdBox).toBe(true)
  })

  it('does not flag a cold box for a drug that does not need one', () => {
    const out = findMatches(input({
      drug: OXYTET,
      request: request({ drugId: 'd-oxytet' }),
      batches: [batch({ id: 'b1', drugId: 'd-oxytet', clinicId: 'c-midjil' })],
    }))
    expect(out.matches[0]?.needsColdBox).toBe(false)
  })

  it('caps the offer at what was actually asked for', () => {
    const out = findMatches(input({
      request: request({ qtyNeeded: 5 }),
      batches: [batch({ id: 'b1' })],
    }))
    expect(out.matches[0]?.availableQty).toBe(20)
    expect(out.matches[0]?.qtyOffered).toBe(5)
  })
})

describe('partial fulfilment across clinics', () => {
  it('fills a shortage from two neighbours rather than leaving it open', () => {
    const batches = [batch({ id: 'b-12' }), batch({ id: 'b-8', clinicId: 'c-midjil' })]
    const out = findMatches(input({
      request: request({ qtyNeeded: 20 }),
      batches,
      movementsByBatch: new Map([['b-12', stock('b-12', 12)], ['b-8', stock('b-8', 8)]]),
    }))
    const plan = planFulfilment(request({ qtyNeeded: 20 }), out.matches)
    expect(plan.complete).toBe(true)
    expect(plan.qtyPlanned).toBe(20)
    expect(plan.allocations.map((a) => a.qty)).toEqual([12, 8])
  })

  it('reports the shortfall honestly when the district simply does not have it', () => {
    const out = findMatches(input({
      request: request({ qtyNeeded: 50 }),
      batches: [batch({ id: 'b1' })],
    }))
    const plan = planFulfilment(request({ qtyNeeded: 50 }), out.matches)
    expect(plan.complete).toBe(false)
    expect(plan.qtyPlanned).toBe(20)
    expect(plan.qtyShort).toBe(30)
  })

  it('stops allocating once the need is met', () => {
    const batches = [batch({ id: 'b-a' }), batch({ id: 'b-b', clinicId: 'c-midjil' })]
    const out = findMatches(input({ request: request({ qtyNeeded: 5 }), batches }))
    const plan = planFulfilment(request({ qtyNeeded: 5 }), out.matches)
    expect(plan.allocations).toHaveLength(1)
    expect(plan.allocations[0]?.qty).toBe(5)
  })
})
