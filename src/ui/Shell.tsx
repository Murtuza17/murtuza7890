import { useState } from 'react'
import { humanizeAge } from '../domain/expiry'
import { pendingCount, rejected, statusLabel, type OutboxItem } from '../domain/outbox'
import { isForcedOffline, setForcedOffline } from '../data/net'
import { dismiss, drain, type SyncState } from '../data/sync'
import { clearSession, type Session } from '../data/session'
import { Sheet } from './bits'

export type Tab = 'stock' | 'requests' | 'transfers'

/**
 * Header, connection state, tabs.
 *
 * The connection strip is the most important non-content pixel in the app. A
 * worker acting on stale data during an outbreak is the failure this product
 * cannot afford, so staleness is stated plainly and permanently rather than
 * hidden behind a spinner.
 */
export function Shell({
  session, sync, tab, onTab, onSignOut, children,
}: {
  session: Session
  sync: SyncState
  tab: Tab
  onTab: (t: Tab) => void
  onSignOut: () => void
  children: React.ReactNode
}) {
  const [queueOpen, setQueueOpen] = useState(false)
  const pending = pendingCount(sync.outbox)
  const problems = rejected(sync.outbox)
  const now = new Date()

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <div className="topbar-clinic">{session.clinic.name}</div>
          <div className="topbar-village">
            {session.clinic.village} · {session.clinic.code}
          </div>
        </div>
        <div className="topbar-spacer" />
        <button className="linkish" onClick={() => { clearSession(); onSignOut() }}>
          Sign out
        </button>
      </div>

      {!sync.online ? (
        <div className="strip strip-offline">
          <span aria-hidden="true">⚠</span>
          No signal — {pending > 0
            ? `${pending} ${pending === 1 ? 'action is' : 'actions are'} waiting to send`
            : 'you can still record what you use'}
        </div>
      ) : pending > 0 ? (
        <div className="strip strip-syncing">
          <span aria-hidden="true">↑</span>
          Sending {pending} {pending === 1 ? 'action' : 'actions'}…
        </div>
      ) : null}

      {problems.length > 0 ? (
        <button className="strip strip-error" style={{ width: '100%', border: 0, textAlign: 'left' }}
                onClick={() => setQueueOpen(true)}>
          <span aria-hidden="true">✕</span>
          {problems.length} {problems.length === 1 ? 'action was' : 'actions were'} not
          accepted — tap to see why
        </button>
      ) : null}

      {sync.boardFetchedAt && (!sync.online || sync.lastError) ? (
        <div className="strip strip-stale">
          <span aria-hidden="true">◷</span>
          Last updated {humanizeAge(new Date(sync.boardFetchedAt), now)}
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {([
          ['stock', 'Your stock'],
          ['requests', 'Requests'],
          ['transfers', 'Transfers'],
        ] as const).map(([key, label]) => (
          <button key={key} role="tab" className="tab" aria-selected={tab === key}
                  onClick={() => onTab(key)}>
            {label}
            {key === 'transfers' && pending > 0 ? <span className="tab-count">{pending}</span> : null}
          </button>
        ))}
      </div>

      <main>{children}</main>

      <DemoBar sync={sync} onOpenQueue={() => setQueueOpen(true)} />

      {queueOpen ? (
        <QueueSheet outbox={sync.outbox} onClose={() => setQueueOpen(false)} />
      ) : null}
    </div>
  )
}

/**
 * Demo controls — spec §5: a judge must be able to cause a disconnect in one tap
 * and watch the queue drain. Two of five judging criteria are about failure
 * handling, so the failure has to be reproducible in seconds.
 */
function DemoBar({ sync, onOpenQueue }: { sync: SyncState; onOpenQueue: () => void }) {
  const [offline, setOffline] = useState(isForcedOffline())
  if (import.meta.env['VITE_DEMO_MODE'] === 'false') return null

  return (
    <div style={{ padding: '0 14px 24px' }}>
      <div className="section-title">Demo controls</div>
      <div className="btn-row">
        <button
          className={offline ? 'btn' : 'btn btn-quiet'}
          onClick={() => {
            const next = !offline
            setForcedOffline(next)
            setOffline(next)
            if (!next) void drain()
          }}
        >
          {offline ? 'Go back online' : 'Cut the connection'}
        </button>
        <button className="btn btn-quiet" onClick={onOpenQueue}>
          Queue ({sync.outbox.length})
        </button>
      </div>
    </div>
  )
}

const OP_LABEL: Record<string, string> = {
  log_movement: 'Recorded use of stock',
  create_batch: 'Added a batch',
  create_request: 'Asked for medicine',
  claim_from_match: 'Claimed medicine',
  accept_transfer: 'Claimed medicine',
  decline_transfer: 'Declined an offer',
  cancel_transfer: 'Gave stock back',
  dispatch_transfer: 'Handed stock over',
  confirm_handoff: 'Confirmed a handover',
}

function QueueSheet({ outbox, onClose }: { outbox: readonly OutboxItem[]; onClose: () => void }) {
  const ordered = [...outbox].sort((a, b) => b.seq - a.seq)

  return (
    <Sheet
      title="Waiting to send"
      subtitle="Everything you do is saved on this phone first, then sent when there is signal."
      onClose={onClose}
    >
      {ordered.length === 0 ? (
        <div className="empty">Nothing waiting. Everything you have done is on the server.</div>
      ) : (
        ordered.map((item) => (
          <div key={item.clientId} className="queue-item">
            <div className="queue-what">
              {OP_LABEL[item.op] ?? item.op}
              <div className="card-meta">{new Date(item.clientTs).toLocaleString()}</div>
            </div>
            <div
              className={`queue-state ${
                item.status === 'done' ? 'queue-done'
                : item.status === 'rejected' ? 'queue-rejected'
                : 'queue-waiting'
              }`}
            >
              {statusLabel(item)}
            </div>
          </div>
        ))
      )}

      {ordered.some((i) => i.status === 'rejected' || i.status === 'done') ? (
        <button
          className="btn btn-quiet"
          onClick={() => {
            for (const i of ordered) {
              if (i.status === 'rejected' || i.status === 'done') void dismiss(i.clientId)
            }
          }}
        >
          Clear finished
        </button>
      ) : null}

      <button className="btn btn-quiet" onClick={onClose}>Close</button>
    </Sheet>
  )
}
