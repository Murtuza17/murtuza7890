/**
 * Client side of natural-language intake. Adapter only — the rules live in
 * src/domain/intake.ts, which re-validates everything this receives.
 *
 * Every failure path here returns rather than throws, because there is always a
 * good answer available: the manual form the worker was already looking at.
 * Offline, unconfigured, rate-limited, slow, or garbled — the outcome is the
 * same, the form stays, and the worker fills it in as before.
 */

import { validateProposal, type IntakeResult } from '../domain/intake'
import type { Drug } from '../domain/types'
import { isOnline } from './net'

/** A worker under pressure will not wait longer than this, and should not. */
const TIMEOUT_MS = 12_000

export type IntakeOutcome =
  | { kind: 'parsed'; result: IntakeResult }
  | { kind: 'unavailable'; message: string }

export async function parseRequestText(
  text: string,
  drugs: readonly Drug[],
): Promise<IntakeOutcome> {
  if (!isOnline()) {
    return { kind: 'unavailable', message: 'No signal — fill the form in below instead.' }
  }
  if (text.trim() === '') {
    return { kind: 'unavailable', message: 'Type or dictate what you need first.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch('/api/parse-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        drugs: drugs.map((d) => ({ id: d.id, name: d.name })),
      }),
      signal: controller.signal,
    })

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; proposal?: unknown; error?: string }
      | null

    if (!res.ok || !body?.ok) {
      return { kind: 'unavailable', message: messageFor(body?.error) }
    }

    const catalogue = new Map(drugs.map((d) => [d.id, { id: d.id, name: d.name }]))
    return {
      kind: 'parsed',
      result: validateProposal((body.proposal ?? {}) as Record<string, unknown>, catalogue),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { kind: 'unavailable', message: 'Took too long — fill the form in below instead.' }
    }
    return { kind: 'unavailable', message: 'Could not read that — fill the form in below instead.' }
  } finally {
    clearTimeout(timer)
  }
}

/** Plain language, and always says what to do next. */
function messageFor(error: string | undefined): string {
  switch (error) {
    case 'not_configured':
    case 'bad_key':
      return 'Typing help is not switched on — fill the form in below.'
    case 'rate_limited':
      return 'Too many requests just now — fill the form in below.'
    case 'refused':
      return 'Could not read that — fill the form in below instead.'
    default:
      return 'Could not read that — fill the form in below instead.'
  }
}
