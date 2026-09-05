/**
 * The sync engine: persists the outbox, drains it, and holds the cached board.
 *
 * All the decisions live in src/domain/outbox.ts and are unit-tested there.
 * This file is the I/O around them — IndexedDB, the network, and a subscription
 * so React can render the result.
 */

import {
  applyResult,
  applyTransportFailure,
  backoffMs,
  isContested,
  markSending,
  nextToSend,
  type OpName,
  type OutboxItem,
  type ServerResult,
} from '../domain/outbox'
import { deviceId, idbDelete, idbGet, idbGetAll, idbPut, STORE_CACHE, STORE_OUTBOX } from './idb'
import { isOnline, onConnectivityChange } from './net'
import { fetchBoard, rpc, type Board } from './supabase'
import { loadSession } from './session'

/** Maps a queued op to its Postgres function and argument shape. */
const RPC_FOR: Record<OpName, string> = {
  log_movement: 'log_movement',
  create_batch: 'create_batch',
  create_request: 'create_request',
  claim_from_match: 'claim_from_match',
  accept_transfer: 'accept_transfer',
  decline_transfer: 'decline_transfer',
  cancel_transfer: 'cancel_transfer',
  dispatch_transfer: 'dispatch_transfer',
  confirm_handoff: 'confirm_handoff',
}

export interface SyncState {
  online: boolean
  draining: boolean
  outbox: OutboxItem[]
  board: Board | null
  /** When the cached board was fetched. Drives "Last updated 2 hours ago". */
  boardFetchedAt: string | null
  lastError: string | null
}

type Listener = (state: SyncState) => void

const listeners = new Set<Listener>()
let state: SyncState = {
  online: true,
  draining: false,
  outbox: [],
  board: null,
  boardFetchedAt: null,
  lastError: null,
}

function set(patch: Partial<SyncState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

export function getState(): SyncState {
  return state
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

// ---------------------------------------------------------------------------
// outbox persistence
// ---------------------------------------------------------------------------

async function reloadOutbox(): Promise<OutboxItem[]> {
  const items = await idbGetAll<OutboxItem>(STORE_OUTBOX)
  // A 'sending' item found at startup means the browser was killed mid-send.
  // Reset it to pending: replaying is safe because the server dedupes on
  // clientId, whereas leaving it stuck would block the queue forever.
  const repaired = items.map((i) => (i.status === 'sending' ? { ...i, status: 'pending' as const } : i))
  await Promise.all(repaired.map((i) => idbPut(STORE_OUTBOX, i)))
  set({ outbox: repaired })
  return repaired
}

async function persist(item: OutboxItem): Promise<void> {
  await idbPut(STORE_OUTBOX, item)
  set({ outbox: state.outbox.map((i) => (i.clientId === item.clientId ? item : i)) })
}

/**
 * Queue an action. Writes to IndexedDB BEFORE anything touches the network, so
 * an action survives the app being closed the instant after the tap.
 */
export async function enqueue(
  op: OpName,
  args: Readonly<Record<string, unknown>>,
): Promise<OutboxItem> {
  const item: OutboxItem = {
    clientId: crypto.randomUUID(),
    op,
    args,
    clientTs: new Date().toISOString(),
    deviceId: await deviceId(),
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    seq: Date.now(),
  }
  await idbPut(STORE_OUTBOX, item)
  set({ outbox: [...state.outbox, item] })
  void drain()
  return item
}

export async function dismiss(clientId: string): Promise<void> {
  await idbDelete(STORE_OUTBOX, clientId)
  set({ outbox: state.outbox.filter((i) => i.clientId !== clientId) })
}

// ---------------------------------------------------------------------------
// draining
// ---------------------------------------------------------------------------

let draining = false

export async function drain(): Promise<void> {
  if (draining || !isOnline()) return
  const session = loadSession()
  if (!session) return

  draining = true
  set({ draining: true })

  try {
    for (;;) {
      const next = nextToSend(state.outbox)
      if (!next) break

      if (next.attempts > 0) {
        await new Promise((r) => setTimeout(r, backoffMs(next.attempts)))
        if (!isOnline()) break
      }

      await persist(markSending(next))

      let settled: OutboxItem
      try {
        const result = await rpc(RPC_FOR[next.op], {
          p_token: session.token,
          p_client_id: next.clientId,
          ...next.args,
        })
        settled = applyResult(next, result as ServerResult)
      } catch (err) {
        // Never reached the server. Stays pending — replay is safe because the
        // server dedupes on clientId.
        settled = applyTransportFailure(next, err instanceof Error ? err.message : 'no signal')
      }

      await persist(settled)
      if (settled.status === 'pending') break // still failing; stop and retry later
    }
  } finally {
    draining = false
    set({ draining: false })
  }

  void refreshBoard()
}

// ---------------------------------------------------------------------------
// board + cache
// ---------------------------------------------------------------------------

const CACHE_KEY = 'board'

/**
 * Load the cached board first, then refresh.
 *
 * Two problems, one mechanism: it makes the app useful with zero signal, and it
 * hides a Supabase free-tier cold start behind instantly-rendered content. The
 * staleness marker is what keeps that honest.
 */
export async function hydrate(): Promise<void> {
  await reloadOutbox()
  const cached = await idbGet<{ board: Board; fetchedAt: string }>(STORE_CACHE, CACHE_KEY)
  if (cached) set({ board: cached.board, boardFetchedAt: cached.fetchedAt })

  onConnectivityChange((online) => {
    set({ online })
    if (online) void drain()
  })
  set({ online: isOnline() })

  await refreshBoard()
  void drain()
}

export async function refreshBoard(): Promise<void> {
  if (!isOnline()) return
  try {
    const board = await fetchBoard()
    await idbPut(STORE_CACHE, { board, fetchedAt: board.fetchedAt }, CACHE_KEY)
    set({ board, boardFetchedAt: board.fetchedAt, lastError: null })
  } catch (err) {
    // Keep showing the cached board rather than blanking the screen. The
    // staleness marker already tells the worker how old it is.
    set({ lastError: err instanceof Error ? err.message : 'Could not reach the server' })
  }
}

/** Actions whose effect the UI may show immediately, keyed by op. */
export function optimisticMovements(items: readonly OutboxItem[]): OutboxItem[] {
  return items.filter((i) => !isContested(i.op) && i.status !== 'rejected')
}
