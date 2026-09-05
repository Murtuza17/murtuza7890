/**
 * Domain types. Pure — no React, no Supabase, no I/O.
 *
 * Vials are the unit throughout. Money does not exist in this system.
 */

export type ClinicId = string
export type DrugId = string
export type BatchId = string
export type RequestId = string
export type TransferId = string

/** ISO-8601 instant, always server-authoritative where ordering matters. */
export type Iso = string
/** Calendar date, `YYYY-MM-DD`. Expiry is a date, not an instant. */
export type IsoDate = string

export interface Clinic {
  id: ClinicId
  code: string
  name: string
  village: string
  district: string
  lat: number
  lng: number
  phone: string
}

export type DrugForm = 'vial' | 'ampoule' | 'bottle' | 'sachet'
export type DrugCategory = 'vaccine' | 'antivenom' | 'antibiotic' | 'antiparasitic' | 'supportive'

export interface Drug {
  id: DrugId
  name: string
  form: DrugForm
  unit: string
  requiresColdChain: boolean
  category: DrugCategory
}

export type BatchStatus = 'active' | 'quarantined' | 'depleted' | 'expired'

export interface Batch {
  id: BatchId
  clinicId: ClinicId
  drugId: DrugId
  batchNo: string
  expiryDate: IsoDate
  /** Cold chain held unbroken since receipt. False = do not transfer, quarantine. */
  coldChainOk: boolean
  /**
   * Vials committed to accepted/in-transit transfers.
   *
   * This is a stored running total — the very thing the ledger exists to avoid.
   * It is safe here and *only* here because it is mutated exclusively inside the
   * row-locked `accept_transfer` transaction on the server: never by a client,
   * never offline, never merged. See `ledger.assertReservedConsistent`.
   */
  qtyReserved: number
  status: BatchStatus
}

export type MovementReason =
  | 'received'
  | 'dispensed'
  | 'wasted'
  | 'expired'
  | 'transferred_out'
  | 'transferred_in'
  | 'correction'

/**
 * The ledger row. Append-only, never updated, never deleted.
 *
 * `delta` is signed. On-hand is SUM(delta) — see ledger.ts for why this is the
 * single most important decision in the codebase.
 */
export interface StockMovement {
  id: string
  batchId: BatchId
  delta: number
  reason: MovementReason
  actorClinicId: ClinicId
  /** Client-generated UUID. UNIQUE in Postgres — this is what makes replay safe. */
  clientId: string
  /** Device clock. Display and within-device sequencing ONLY. Never orders across devices. */
  clientTs: Iso
  /** Server clock. The only ordering authority in the system. */
  serverTs: Iso | null
}

export type Urgency = 'routine' | 'urgent' | 'outbreak'
export type RequestStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired'

export interface StockRequest {
  id: RequestId
  clinicId: ClinicId
  drugId: DrugId
  qtyNeeded: number
  urgency: Urgency
  radiusKm: number
  neededBy: IsoDate
  note: string
  status: RequestStatus
  createdAt: Iso
}

export type TransferStatus =
  | 'proposed'
  | 'accepted'
  | 'in_transit'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'disputed'

export interface Transfer {
  id: TransferId
  requestId: RequestId | null
  batchId: BatchId
  fromClinicId: ClinicId
  toClinicId: ClinicId
  qty: number
  /** Both codes issued at ACCEPT, not dispatch — the handoff happens with no signal. */
  senderCode: string | null
  receiverCode: string | null
  status: TransferStatus
  reservedUntil: Iso | null
  createdAt: Iso
  acceptedAt: Iso | null
  dispatchedAt: Iso | null
  completedAt: Iso | null
}

export type EventType =
  | 'transfer_proposed'
  | 'transfer_accepted'
  | 'transfer_declined'
  | 'transfer_dispatched'
  | 'transfer_confirmed'
  | 'transfer_completed'
  | 'transfer_disputed'
  | 'transfer_cancelled'
  | 'transfer_expired'
  | 'claim_rejected'
  | 'batch_created'
  | 'stock_moved'
  | 'request_opened'
  | 'request_closed'

export interface DomainEvent {
  id: string
  entityType: 'transfer' | 'batch' | 'request'
  entityId: string
  type: EventType
  actorClinicId: ClinicId | null
  payload: Readonly<Record<string, unknown>>
  clientTs: Iso | null
  serverTs: Iso
}
