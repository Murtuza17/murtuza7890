/**
 * Maps server rows into domain types and exposes the sync state to React.
 *
 * All the reasoning lives in src/domain. This file only reshapes data — if a
 * decision starts creeping in here, it belongs one directory over where it can
 * be tested without a browser.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Batch, Clinic, Drug, StockMovement, StockRequest, Transfer } from '../domain/types'
import { getState, subscribe, type SyncState } from '../data/sync'
import type { Board } from '../data/supabase'

export function useSync(): SyncState {
  const [state, setState] = useState<SyncState>(getState)
  useEffect(() => subscribe(setState), [])
  return state
}

export interface BoardModel {
  clinics: Clinic[]
  clinicsById: Map<string, Clinic>
  drugs: Drug[]
  drugsById: Map<string, Drug>
  batches: Batch[]
  batchesById: Map<string, Batch>
  availableByBatch: Map<string, number>
  onHandByBatch: Map<string, number>
  movements: StockMovement[]
  movementsByBatch: Map<string, StockMovement[]>
  requests: StockRequest[]
  transfers: Transfer[]
}

const EMPTY: BoardModel = {
  clinics: [], clinicsById: new Map(), drugs: [], drugsById: new Map(),
  batches: [], batchesById: new Map(), availableByBatch: new Map(),
  onHandByBatch: new Map(), movements: [], movementsByBatch: new Map(),
  requests: [], transfers: [],
}

type Row = Record<string, unknown>
const str = (r: Row, k: string) => String(r[k] ?? '')
const num = (r: Row, k: string) => Number(r[k] ?? 0)
const bool = (r: Row, k: string) => Boolean(r[k])
const nullable = (r: Row, k: string) => (r[k] == null ? null : String(r[k]))

export function toModel(board: Board | null): BoardModel {
  if (!board) return EMPTY

  const clinics: Clinic[] = board.clinics.map((r: Row) => ({
    id: str(r, 'id'), code: str(r, 'code'), name: str(r, 'name'),
    village: str(r, 'village'), district: str(r, 'district'),
    lat: num(r, 'lat'), lng: num(r, 'lng'), phone: str(r, 'phone'),
  }))

  const drugs: Drug[] = board.drugs.map((r: Row) => ({
    id: str(r, 'id'), name: str(r, 'name'),
    form: str(r, 'form') as Drug['form'], unit: str(r, 'unit'),
    requiresColdChain: bool(r, 'requires_cold_chain'),
    category: str(r, 'category') as Drug['category'],
  }))

  const batches: Batch[] = board.stock.map((r) => ({
    id: r.batch_id, clinicId: r.clinic_id, drugId: r.drug_id, batchNo: r.batch_no,
    expiryDate: r.expiry_date, coldChainOk: r.cold_chain_ok,
    qtyReserved: r.qty_reserved, status: r.status as Batch['status'],
  }))

  const movements: StockMovement[] = board.movements.map((r: Row) => ({
    id: str(r, 'id'), batchId: str(r, 'batch_id'), delta: num(r, 'delta'),
    reason: str(r, 'reason') as StockMovement['reason'],
    actorClinicId: str(r, 'actor_clinic_id'), clientId: str(r, 'client_id'),
    clientTs: str(r, 'client_ts'), serverTs: nullable(r, 'server_ts'),
  }))

  const requests: StockRequest[] = board.requests.map((r: Row) => ({
    id: str(r, 'id'), clinicId: str(r, 'clinic_id'), drugId: str(r, 'drug_id'),
    qtyNeeded: num(r, 'qty_needed'), urgency: str(r, 'urgency') as StockRequest['urgency'],
    radiusKm: num(r, 'radius_km'), neededBy: str(r, 'needed_by'), note: str(r, 'note'),
    status: str(r, 'status') as StockRequest['status'], createdAt: str(r, 'created_at'),
  }))

  const transfers: Transfer[] = board.transfers.map((r: Row) => ({
    id: str(r, 'id'), requestId: nullable(r, 'request_id'), batchId: str(r, 'batch_id'),
    fromClinicId: str(r, 'from_clinic_id'), toClinicId: str(r, 'to_clinic_id'),
    qty: num(r, 'qty'), senderCode: nullable(r, 'sender_code'),
    receiverCode: nullable(r, 'receiver_code'),
    status: str(r, 'status') as Transfer['status'],
    reservedUntil: nullable(r, 'reserved_until'), createdAt: str(r, 'created_at'),
    acceptedAt: nullable(r, 'accepted_at'), dispatchedAt: nullable(r, 'dispatched_at'),
    completedAt: nullable(r, 'completed_at'),
  }))

  const movementsByBatch = new Map<string, StockMovement[]>()
  for (const m of movements) {
    const list = movementsByBatch.get(m.batchId)
    if (list) list.push(m)
    else movementsByBatch.set(m.batchId, [m])
  }

  // on_hand and available come from the batch_stock view — the server's own
  // SUM(delta), not a number recomputed from the 500 movements we happened to
  // fetch. Recomputing from a truncated list would quietly understate stock.
  const availableByBatch = new Map(board.stock.map((r) => [r.batch_id, r.available]))
  const onHandByBatch = new Map(board.stock.map((r) => [r.batch_id, r.on_hand]))

  return {
    clinics, clinicsById: new Map(clinics.map((c) => [c.id, c])),
    drugs, drugsById: new Map(drugs.map((d) => [d.id, d])),
    batches, batchesById: new Map(batches.map((b) => [b.id, b])),
    availableByBatch, onHandByBatch,
    movements, movementsByBatch, requests, transfers,
  }
}

export function useBoard(board: Board | null): BoardModel {
  return useMemo(() => toModel(board), [board])
}
