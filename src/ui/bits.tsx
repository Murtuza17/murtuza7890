/** Small shared pieces. Presentational only — no fetching, no decisions. */

import type { ReactNode } from 'react'
import { bandFor, EXPIRY_BANDS, humanizeExpiry } from '../domain/expiry'

/**
 * Expiry pill: colour AND icon AND words.
 *
 * Sunlight washes colour out of a cheap screen before anything else goes, and
 * red/green is unreliable for about 1 in 12 men regardless. Any one of the
 * three carries the meaning on its own.
 */
export function ExpiryPill({ date, now }: { date: string; now: Date }) {
  const band = bandFor(date, now)
  return (
    <span className={`pill band-${band}`}>
      <span className="pill-icon" aria-hidden="true">{EXPIRY_BANDS[band].icon}</span>
      {humanizeExpiry(date, now)}
    </span>
  )
}

export function Qty({ n, unit }: { n: number; unit: string }) {
  return (
    <div className="qty">
      <div className="qty-n">{n}</div>
      <div className="qty-u">{n === 1 ? unit : `${unit}s`}</div>
    </div>
  )
}

/** Empty states instruct rather than apologise. */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div>{children}</div>
    </div>
  )
}

export function Note({ kind, children }: { kind: 'error' | 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={`note note-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  )
}

export function Sheet({
  title, subtitle, onClose, children,
}: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="sheet">
        <h2>{title}</h2>
        {subtitle ? <div className="card-sub">{subtitle}</div> : null}
        {children}
      </div>
    </div>
  )
}
