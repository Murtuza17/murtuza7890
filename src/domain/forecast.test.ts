import { describe, expect, it } from 'vitest'
import {
  batchOutlook,
  demandSignal,
  positionOutlook,
  STOCKOUT_HORIZON_DAYS,
  type ConsumptionStats,
} from './forecast'

const now = new Date('2026-09-05T10:00:00.000Z')

const stats = (over: Partial<ConsumptionStats> = {}): ConsumptionStats => ({
  dispensed14d: 0, dispensed30d: 0, dispensed90d: 0, events: 0, events14d: 0,
  observedDays: 90, ...over,
})

const batch = (expiryDate: string) => ({ id: 'b1', expiryDate })

describe('demand is dispensing, and nothing else', () => {
  it('derives a daily rate from the observed window', () => {
    const s = demandSignal(stats({ dispensed90d: 90, events: 12, observedDays: 90 }))
    expect(s.dailyRate).toBe(1)
  })

  it('divides by how long we have actually watched, not by the window length', () => {
    // A clinic that opened 10 days ago and used 20 vials burns 2/day — not
    // 20/90. Extrapolating a short history over a long window would make every
    // new clinic look like it never uses anything.
    const s = demandSignal(stats({ dispensed90d: 20, events: 4, observedDays: 10 }))
    expect(s.dailyRate).toBe(2)
  })
})

describe('confidence comes from how long we watched, not how much happened', () => {
  /**
   * The case most implementations get backwards, and the most actionable one in
   * the system: 60 days of watching with zero dispensed is not missing data. It
   * is a strong observation that the rate is zero — which means the entire
   * batch is heading for the bin.
   */
  it('treats a long quiet stretch as high confidence, not as no data', () => {
    const s = demandSignal(stats({ dispensed90d: 0, events: 0, observedDays: 60 }))
    expect(s.dailyRate).toBe(0)
    expect(s.confidence).toBe('high')
  })

  it('refuses to guess inside the first week', () => {
    const s = demandSignal(stats({ dispensed90d: 12, events: 2, observedDays: 3 }))
    expect(s.confidence).toBe('none')
  })

  it.each([
    [10, 'low'],
    [30, 'medium'],
    [60, 'high'],
  ] as const)('after %i days of watching, confidence is %s', (observedDays, expected) => {
    expect(demandSignal(stats({ dispensed90d: 30, events: 6, observedDays })).confidence)
      .toBe(expected)
  })
})

describe('surge detection — the outbreak signature', () => {
  it('flags a clinic burning several times its own baseline', () => {
    // 90 vials over 90 days = 1/day baseline. 42 in the last 14 = 3/day.
    // This fires before anyone has posted a request or said "outbreak".
    const s = demandSignal(stats({
      dispensed90d: 90, dispensed14d: 42, events: 20, events14d: 10, observedDays: 90,
    }))
    expect(s.trend).toBe('surging')
  })

  it('does not mistake one vaccination camp for an outbreak', () => {
    // A single big event inside the window is a camp, not a trend.
    const s = demandSignal(stats({
      dispensed90d: 40, dispensed14d: 40, events: 1, observedDays: 90,
    }))
    expect(s.trend).not.toBe('surging')
  })

  it('calls a clinic that never dispenses quiet', () => {
    expect(demandSignal(stats({ observedDays: 60 })).trend).toBe('quiet')
  })
})

describe('waste forecast — the premise of the product', () => {
  it('predicts the whole batch is wasted when nothing is ever used', () => {
    const signal = demandSignal(stats({ dispensed90d: 0, events: 0, observedDays: 60 }))
    const out = batchOutlook(batch('2026-09-19'), 25, signal, now)
    expect(out.risk).toBe('will_expire_unused')
    expect(out.projectedWaste).toBe(25)
    expect(out.why).toContain('none used')
  })

  it('predicts a partial surplus when the rate is too slow to finish the batch', () => {
    // 0.5/day for 14 days = 7 used, 18 of 25 wasted.
    const signal = demandSignal(stats({ dispensed90d: 45, events: 9, observedDays: 90 }))
    const out = batchOutlook(batch('2026-09-19'), 25, signal, now)
    expect(out.risk).toBe('will_expire_unused')
    expect(out.projectedUse).toBe(7)
    expect(out.projectedWaste).toBe(18)
  })

  it('does not cry waste when the clinic will comfortably use it', () => {
    const signal = demandSignal(stats({ dispensed90d: 180, events: 30, observedDays: 90 }))
    const out = batchOutlook(batch('2026-12-01'), 25, signal, now)
    expect(out.risk).not.toBe('will_expire_unused')
    expect(out.projectedWaste).toBe(0)
  })
})

describe('stockout forecast — the other half', () => {
  it('warns when the shelf runs dry inside the horizon', () => {
    const signal = demandSignal(stats({ dispensed90d: 180, events: 30, observedDays: 90 }))
    const out = batchOutlook(batch('2027-06-01'), 12, signal, now)
    expect(out.risk).toBe('will_run_out')
    expect(out.daysToStockout).toBe(6)
    expect(out.why).toContain('runs out in 6 days')
  })

  it('stays quiet about a stockout too far out to act on', () => {
    const signal = demandSignal(stats({ dispensed90d: 90, events: 20, observedDays: 90 }))
    const out = batchOutlook(batch('2027-06-01'), STOCKOUT_HORIZON_DAYS + 40, signal, now)
    expect(out.risk).toBe('balanced')
  })

  it('reports no stockout at all when nothing is being used', () => {
    const signal = demandSignal(stats({ observedDays: 60 }))
    expect(batchOutlook(batch('2027-06-01'), 10, signal, now).daysToStockout).toBeNull()
  })
})

describe('the honesty rule', () => {
  it('says unknown rather than guessing from a few days of history', () => {
    const signal = demandSignal(stats({ dispensed90d: 6, events: 1, observedDays: 3 }))
    const out = batchOutlook(batch('2026-09-19'), 25, signal, now)
    expect(out.risk).toBe('unknown')
    expect(out.why).toContain('Not enough history')
  })

  it('never dresses an unknown up as a balanced outlook', () => {
    const signal = demandSignal(stats({ observedDays: 2 }))
    expect(batchOutlook(batch('2027-01-01'), 40, signal, now).risk).toBe('unknown')
  })

  it('always explains itself in terms a worker can check', () => {
    const signal = demandSignal(stats({ dispensed90d: 90, events: 20, observedDays: 90 }))
    const out = batchOutlook(batch('2026-09-14'), 40, signal, now)
    // Rate stated in vials per WEEK — nobody reasons in vials per day.
    expect(out.why).toMatch(/\d+(\.\d)? vials a week/)
  })
})

describe('determinism', () => {
  it('gives the same answer for the same inputs, every time', () => {
    const s = stats({ dispensed90d: 47, dispensed14d: 11, events: 9, observedDays: 63 })
    const a = batchOutlook(batch('2026-10-01'), 30, demandSignal(s), now)
    const b = batchOutlook(batch('2026-10-01'), 30, demandSignal(s), now)
    expect(a).toEqual(b)
  })
})

describe('the planning rate is the conservative one', () => {
  /**
   * The bug this exists to prevent, found by review: projections used only the
   * 90-day baseline, so a clinic in the middle of an outbreak — burning six
   * times its usual rate — looked like it would never finish its stock, was
   * classified a waster, and would have been asked to hand vials to a
   * neighbour days before needing them itself. The exact opposite of correct.
   */
  it('uses the surge rate, not the baseline, once a clinic is burning faster', () => {
    const surging = demandSignal(stats({
      dispensed90d: 90, dispensed14d: 84, events: 30, events14d: 12, observedDays: 90,
    }))
    expect(surging.dailyRate).toBe(1)
    expect(surging.planningRate).toBe(6)

    const out = batchOutlook(batch('2026-09-19'), 25, surging, now)
    expect(out.risk).not.toBe('will_expire_unused')
    expect(out.risk).toBe('will_run_out')
  })

  it('falls back to the baseline when the fortnight is quieter than usual', () => {
    // Being quiet lately is not a reason to assume stock will last: a lull
    // ending is the normal case in outbreak-driven demand.
    const lull = demandSignal(stats({
      dispensed90d: 90, dispensed14d: 0, events: 30, events14d: 0, observedDays: 90,
    }))
    expect(lull.planningRate).toBe(1)
  })
})

describe('one rate shared across a clinic’s batches', () => {
  /**
   * Applying the clinic rate to each batch independently double-counts the same
   * demand: two 10-vial batches at 0.5/day over 30 days each look comfortably
   * used, while between them 5 vials actually go in the bin.
   */
  it('does not let two batches both claim the same consumption', () => {
    const signal = demandSignal(stats({ dispensed90d: 45, events: 12, events14d: 2, observedDays: 90 }))
    const outlooks = positionOutlook(
      [
        { id: 'b-soon', expiryDate: '2026-10-05', available: 10 },
        { id: 'b-later', expiryDate: '2026-10-05', available: 10 },
      ],
      signal, now,
    )
    const totalUse = outlooks.reduce((n, o) => n + o.projectedUse, 0)
    // 0.5/day over 30 days is 15 vials of demand across 20 vials of stock.
    expect(totalUse).toBe(15)
    expect(outlooks.reduce((n, o) => n + o.projectedWaste, 0)).toBe(5)
  })

  it('puts the surplus on the batch that outlives the demand, not the first one', () => {
    // Dispensaries reach for the vial that dies first, so the later batch is
    // the one still sitting there — and the one worth moving.
    // At 0.5/day, b-soon needs 20 days to get through its own 10 vials — give
    // it exactly that so its own window is never the reason it wastes stock.
    // b-later sits far enough out (35 days) that the rate could plow through
    // 17-18 of its own vials alone, but only 8 are left unclaimed once b-soon
    // has taken its 10, so the surplus lands there instead.
    const signal = demandSignal(stats({ dispensed90d: 45, events: 12, events14d: 2, observedDays: 90 }))
    const outlooks = positionOutlook(
      [
        { id: 'b-later', expiryDate: '2026-10-10', available: 10 },
        { id: 'b-soon', expiryDate: '2026-09-25', available: 10 },
      ],
      signal, now,
    )
    const soon = outlooks.find((o) => o.batchId === 'b-soon')
    const later = outlooks.find((o) => o.batchId === 'b-later')
    expect(soon?.projectedWaste).toBe(0)
    expect(later?.projectedWaste).toBeGreaterThan(0)
  })

  it('still reports no waste when the clinic gets through everything', () => {
    const signal = demandSignal(stats({ dispensed90d: 270, events: 40, events14d: 6, observedDays: 90 }))
    const outlooks = positionOutlook(
      [{ id: 'b1', expiryDate: '2026-10-05', available: 10 },
       { id: 'b2', expiryDate: '2026-10-05', available: 10 }],
      signal, now,
    )
    expect(outlooks.every((o) => o.projectedWaste === 0)).toBe(true)
  })
})

describe('surge detection counts recent events, not all-time', () => {
  it('does not read one camp as a surge just because the clinic has history', () => {
    // events: 40 all-time, but only one dispensing in the last fortnight.
    const s = demandSignal(stats({
      dispensed90d: 90, dispensed14d: 40, events: 40, events14d: 1, observedDays: 90,
    }))
    expect(s.trend).not.toBe('surging')
  })
})
