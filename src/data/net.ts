/**
 * Connectivity, with a demo override.
 *
 * Spec §5: a judge must be able to cause a disconnect in one tap and watch the
 * queue drain. Two of five judging criteria are about failure handling, so the
 * failure has to be reproducible in seconds rather than described in prose —
 * and `navigator.onLine` cannot be faked from a page.
 *
 * The override only ever forces OFFLINE. It can never claim a connection the
 * device does not have.
 */

type Listener = (online: boolean) => void

const listeners = new Set<Listener>()
let forcedOffline = false

export function isOnline(): boolean {
  if (forcedOffline) return false
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

export function isForcedOffline(): boolean {
  return forcedOffline
}

export function setForcedOffline(value: boolean): void {
  if (forcedOffline === value) return
  forcedOffline = value
  const online = isOnline()
  for (const l of listeners) l(online)
}

export function onConnectivityChange(listener: Listener): () => void {
  listeners.add(listener)
  const notify = () => listener(isOnline())
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
