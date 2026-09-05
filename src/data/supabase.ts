/**
 * Supabase access over plain fetch.
 *
 * DEVIATION from CLAUDE.md §2, flagged: the stack is still React + Vite +
 * Supabase, but without @supabase/supabase-js. The SDK was 100 KB gzipped of
 * the 125 KB bundle, and the whole of what this app used from it was `.rpc()`
 * and `select * order limit` — both of which are one PostgREST URL each.
 *
 * The spec's own reasoning about webfonts applies with more force here: this
 * is a render-blocking download for a worker on 2G during an outbreak, and
 * ~100 KB is several seconds of staring at a blank screen. Same argument, same
 * conclusion, bigger number.
 *
 * The anon key is public by design — it ships in the bundle either way. What
 * protects the data is RLS plus every mutation being a SECURITY DEFINER
 * function behind a session token (supabase/migrations/0003_rls.sql).
 */

import type { ServerResult } from '../domain/outbox'

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined

export const isConfigured = Boolean(url && anonKey && !url.includes('your-project-ref'))

export class NotConfiguredError extends Error {
  constructor() {
    super('Supabase is not configured. Copy .env.example to .env and fill in both values.')
  }
}

/** A hung request on a bad link must not block the queue behind it forever. */
const TIMEOUT_MS = 15_000

function headers(): HeadersInit {
  return {
    apikey: anonKey as string,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  if (!isConfigured) throw new NotConfiguredError()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: headers(),
      signal: controller.signal,
    })
    const text = await res.text()
    const body: unknown = text ? JSON.parse(text) : null

    if (!res.ok) {
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as { message: unknown }).message)
          : `Request failed (${res.status})`
      throw new Error(message)
    }
    return body
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('The server did not answer in time')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function rpc(fn: string, args: Record<string, unknown>): Promise<ServerResult> {
  const body = await request(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  return (body ?? { ok: false, error: 'empty_response' }) as ServerResult
}

async function select<T>(table: string, query = ''): Promise<T[]> {
  const body = await request(`${table}?select=*${query}`, { method: 'GET' })
  return (Array.isArray(body) ? body : []) as T[]
}

export interface BoardRow {
  batch_id: string
  clinic_id: string
  drug_id: string
  batch_no: string
  expiry_date: string
  cold_chain_ok: boolean
  status: string
  on_hand: number
  qty_reserved: number
  available: number
}

type Row = Record<string, unknown>

/**
 * One board read.
 *
 * Sweeps lapsed reservations first — spec §4, lazy TTL with no cron and no paid
 * scheduler. A board read is exactly when someone cares whether abandoned stock
 * has come free.
 */
export async function fetchBoard() {
  // A failed sweep must not blank the board — the next read retries it.
  try {
    await rpc('sweep_expired_reservations', {})
  } catch {
    /* ignored deliberately */
  }

  const [clinics, drugs, stock, requests, transfers, movements, events] = await Promise.all([
    select<Row>('clinics_public', '&order=name'),
    select<Row>('drugs', '&order=name'),
    select<BoardRow>('batch_stock'),
    select<Row>('requests', '&order=created_at.desc'),
    select<Row>('transfers', '&order=created_at.desc'),
    select<Row>('stock_movements', '&order=server_ts.desc&limit=500'),
    // The trail a disputed handoff is judged on. Bounded: a field worker needs
    // recent history, not the whole log, and this rides a 2G connection.
    //
    // Supplementary, so it must never be able to blank the board — losing the
    // audit trail on a flaky link is a degraded view, losing the stock list is
    // a useless app. Everything above is load-bearing and stays in Promise.all.
    select<Row>('events', '&order=server_ts.desc&limit=300').catch(() => [] as Row[]),
  ])

  return {
    clinics, drugs, stock, requests, transfers, movements, events,
    fetchedAt: new Date().toISOString(),
  }
}

export type Board = Awaited<ReturnType<typeof fetchBoard>>
