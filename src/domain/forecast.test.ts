import { describe, expect, it } from 'vitest'
import {
  batchOutlook,
  demandSignal,
  STOCKOUT_HORIZON_DAYS,
  type ConsumptionStats,
} from './forecast'

const now = new Date('2026-09-05T10:00:00.000Z')

const stats = (over: Partial<ConsumptionStats> = {}): ConsumptionStats => ({
  dispensed14d: 0, dispensed30d: 0, dispensed90d: 0, events: 0, observedDays: 90, ...over,
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
      dispensed90d: 90, dispensed14d: 42, events: 20, observedDays: 90,
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
