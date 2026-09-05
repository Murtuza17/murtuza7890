/**
 * Expiry reasoning. Pure — no I/O, no locale APIs, no Date.now().
 *
 * Every function takes `now` explicitly. A domain module that reads the clock
 * cannot be tested deterministically, and expiry is the visual spine of the
 * inventory view — it has to be exactly right.
 */

import type { IsoDate } from './types'

/**
 * Buckets, not a raw number of days.
 *
 * A field worker under pressure does not read "expires in 23 days" and compute
 * anything. They read a band. The bands drive colour AND icon AND text, because
 * a cheap screen in direct sunlight loses colour first and roughly 1 in 12 men
 * cannot rely on red/green at all.
 */
export type ExpiryBand = 'expired' | 'critical' | 'soon' | 'watch' | 'ok'

export const EXPIRY_BANDS: Readonly<Record<ExpiryBand, { label: string; icon: string }>> = {
  expired: { label: 'Expired', icon: '✕' },
  critical: { label: 'Expires this week', icon: '!!' },
  soon: { label: 'Expires this month', icon: '!' },
  watch: { label: 'Expires in 3 months', icon: '•' },
  ok: { label: 'In date', icon: '✓' },
}

const DAY_MS = 86_400_000

/**
 * Normalise anything date-shaped to `YYYY-MM-DD`.
 *
 * Postgres dates arrive as bare `2026-09-19` through PostgREST, but a driver
 * that hydrates them into Date objects yields `Thu Sep 19 2026 ...` instead.
 * Blindly appending a time to that produced `NaN`, which rendered as
 * "expires in NaN months" AND banded expiring stock as safely in date — the
 * dangerous direction. Caught in a browser, not by a unit test, which is why
 * this now has both.
 *
 * Returns null when the input genuinely cannot be read, so callers must decide
 * rather than silently propagating NaN.
 */
export function normalizeDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10)
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 10)
}

/** Whole days from `now` to the END of the expiry date — a batch is good all day. */
export function daysUntilExpiry(expiryDate: IsoDate, now: Date): number {
  const day = normalizeDate(expiryDate)
  // Unreadable expiry fails towards "expired". Showing bad stock as in date is
  // how an inert vaccine gets administered; the opposite is a wasted trip.
  if (day === null) return Number.NEGATIVE_INFINITY
  const expiry = Date.parse(`${day}T23:59:59.999Z`)
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  return Math.floor((expiry - today) / DAY_MS)
}

export function bandFor(expiryDate: IsoDate, now: Date): ExpiryBand {
  const days = daysUntilExpiry(expiryDate, now)
  if (days < 0) return 'expired'
  if (days <= 7) return 'critical'
  if (days <= 30) return 'soon'
  if (days <= 90) return 'watch'
  return 'ok'
}

export function isExpired(expiryDate: IsoDate, now: Date): boolean {
  return daysUntilExpiry(expiryDate, now) < 0
}

/** Plain language, no library. "expires in 9 days", "expired 3 days ago". */
export function humanizeExpiry(expiryDate: IsoDate, now: Date): string {
  const days = daysUntilExpiry(expiryDate, now)
  if (!Number.isFinite(days)) return 'expiry date unclear — check the vial'
  if (days < -1) return `expired ${Math.abs(days)} days ago`
  if (days === -1) return 'expired yesterday'
  if (days === 0) return 'expires today'
  if (days === 1) return 'expires tomorrow'
  if (days <= 60) return `expires in ${days} days`
  const months = Math.round(days / 30)
  return `expires in ${months} months`
}

/** "Last updated 2 hours ago" — the staleness marker on a cached board. */
export function humanizeAge(then: Date, now: Date): string {
  const mins = Math.floor((now.getTime() - then.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 minute ago'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.floor(mins / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}
