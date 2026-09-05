/**
 * Supabase client and the RPC surface.
 *
 * The anon key is public by design — it ships in the bundle. What protects the
 * data is RLS plus the fact that every mutation is a SECURITY DEFINER function
 * taking a session token (supabase/migrations/0003_rls.sql).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ServerResult } from '../domain/outbox'

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined

export const isConfigured = Boolean(url && anonKey && !url.includes('your-project-ref'))

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url as string, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null

export class NotConfiguredError extends Error {
  constructor() {
    super('Supabase is not configured. Copy .env.example to .env and fill in both values.')
  }
}

function client(): SupabaseClient {
  if (!supabase) throw new NotConfiguredError()
  return supabase
}

export async function rpc(fn: string, args: Record<string, unknown>): Promise<ServerResult> {
  const { data, error } = await client().rpc(fn, args)
  if (error) throw new Error(error.message)
  return (data ?? { ok: false, error: 'empty_response' }) as ServerResult
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

/**
 * One board read.
 *
 * Sweeps lapsed reservations first — spec §4, lazy TTL with no cron and no paid
 * scheduler. A board read is exactly when someone cares whether abandoned stock
 * is free again.
 */
export async function fetchBoard() {
  const db = client()
  // A failed sweep must not blank the board — the next read retries it.
  try {
    await db.rpc('sweep_expired_reservations')
  } catch {
    /* ignored deliberately */
  }

  const [clinics, drugs, stock, requests, transfers, movements] = await Promise.all([
    db.from('clinics_public').select('*').order('name'),
    db.from('drugs').select('*').order('name'),
    db.from('batch_stock').select('*'),
    db.from('requests').select('*').order('created_at', { ascending: false }),
    db.from('transfers').select('*').order('created_at', { ascending: false }),
    db.from('stock_movements').select('*').order('server_ts', { ascending: false }).limit(500),
  ])

  const failed = [clinics, drugs, stock, requests, transfers, movements].find((r) => r.error)
  if (failed?.error) throw new Error(failed.error.message)

  return {
    clinics: clinics.data ?? [],
    drugs: drugs.data ?? [],
    stock: (stock.data ?? []) as BoardRow[],
    requests: requests.data ?? [],
    transfers: transfers.data ?? [],
    movements: movements.data ?? [],
    fetchedAt: new Date().toISOString(),
  }
}

export type Board = Awaited<ReturnType<typeof fetchBoard>>
