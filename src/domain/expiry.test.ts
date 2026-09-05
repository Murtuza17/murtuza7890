import { describe, expect, it } from 'vitest'
import { bandFor, daysUntilExpiry, humanizeAge, humanizeExpiry, isExpired, normalizeDate } from './expiry'

const now = new Date('2026-09-05T10:00:00.000Z')

describe('daysUntilExpiry', () => {
  it('counts a batch expiring today as still usable', () => {
    // A batch is good until the end of its expiry date, not from midnight.
    expect(daysUntilExpiry('2026-09-05', now)).toBe(0)
    expect(isExpired('2026-09-05', now)).toBe(false)
  })

  it('counts yesterday as expired', () => {
    expect(daysUntilExpiry('2026-09-04', now)).toBe(-1)
    expect(isExpired('2026-09-04', now)).toBe(true)
  })

  it('is independent of the time of day', () => {
    const early = new Date('2026-09-05T00:00:01.000Z')
    const late = new Date('2026-09-05T23:59:58.000Z')
    expect(daysUntilExpiry('2026-09-14', early)).toBe(daysUntilExpiry('2026-09-14', late))
  })
})

describe('bands', () => {
  it.each([
    ['2026-09-04', 'expired'],
    ['2026-09-05', 'critical'],
    ['2026-09-12', 'critical'],
    ['2026-09-13', 'soon'],
    ['2026-10-05', 'soon'],
    ['2026-10-06', 'watch'],
    ['2026-12-04', 'watch'],
    ['2026-12-05', 'ok'],
  ] as const)('%s -> %s', (date, band) => {
    expect(bandFor(date, now)).toBe(band)
  })
})

describe('plain language', () => {
  it.each([
    ['2026-09-05', 'expires today'],
    ['2026-09-06', 'expires tomorrow'],
    ['2026-09-14', 'expires in 9 days'],
    ['2026-09-04', 'expired yesterday'],
    ['2026-09-01', 'expired 4 days ago'],
    ['2027-01-05', 'expires in 4 months'],
  ] as const)('%s -> "%s"', (date, text) => {
    expect(humanizeExpiry(date, now)).toBe(text)
  })
})

describe('staleness marker', () => {
  it.each([
    ['2026-09-05T09:59:30.000Z', 'just now'],
    ['2026-09-05T09:59:00.000Z', '1 minute ago'],
    ['2026-09-05T09:30:00.000Z', '30 minutes ago'],
    ['2026-09-05T08:00:00.000Z', '2 hours ago'],
    ['2026-09-04T10:00:00.000Z', '1 day ago'],
    ['2026-09-02T10:00:00.000Z', '3 days ago'],
  ] as const)('%s -> "%s"', (then, text) => {
    expect(humanizeAge(new Date(then), now)).toBe(text)
  })
})

describe('date shapes', () => {
  it('accepts a bare date', () => {
    expect(normalizeDate('2026-09-14')).toBe('2026-09-14')
  })

  it('accepts a full timestamp', () => {
    expect(normalizeDate('2026-09-14T00:00:00.000Z')).toBe('2026-09-14')
  })

  it('accepts what a Date stringifies to', () => {
    // A driver that hydrates SQL dates into Date objects produces this. It used
    // to yield "expires in NaN months" and a green in-date band.
    expect(normalizeDate(String(new Date('2026-09-14T00:00:00.000Z')))).toBe('2026-09-14')
  })

  it('reports genuinely unreadable input rather than guessing', () => {
    expect(normalizeDate('not a date')).toBeNull()
  })

  it('bands an unreadable expiry as expired, never as in date', () => {
    // Showing bad stock as in date is how an inert vaccine gets administered.
    expect(bandFor('not a date', now)).toBe('expired')
    expect(humanizeExpiry('not a date', now)).toBe('expiry date unclear — check the vial')
  })

  it('gives the same answer for every shape of the same day', () => {
    const shapes = ['2026-09-14', '2026-09-14T00:00:00.000Z', String(new Date('2026-09-14T12:00:00Z'))]
    const answers = new Set(shapes.map((s) => daysUntilExpiry(s, now)))
    expect(answers.size).toBe(1)
    expect([...answers][0]).toBe(9)
  })
})
