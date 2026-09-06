/**
 * Clinic session. Code + 4-digit PIN, as the brief requires — no OAuth, no SMS.
 *
 * DEVIATION from the brief, flagged: the spec says "a signed clinic id in
 * localStorage". Signing needs a server-held secret, and there is nowhere to
 * keep one in a static Vercel deploy without adding an edge function — so a
 * "signed" id would have been signed with a key sitting in the bundle, which is
 * not a signature at all. Instead the server issues an opaque random token
 * stored in clinic_sessions and validates it on every mutation. Same intent
 * (the client cannot assert a clinic id it was not given), actually enforceable,
 * and no secret to leak.
 */

import type { Clinic } from '../domain/types'
import { rpc } from './supabase'

const KEY = 'vetswap.session'

export interface Session {
  token: string
  clinic: Clinic
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    /* private mode — the session simply will not survive a reload */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignored */
  }
}

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; message: string; attemptsLeft?: number }

export async function login(code: string, pin: string): Promise<LoginResult> {
  const result = await rpc('clinic_login', { p_code: code, p_pin: pin })

  if (result['ok'] === true) {
    const session: Session = {
      token: result['token'] as string,
      clinic: result['clinic'] as Clinic,
    }
    saveSession(session)
    return { ok: true, session }
  }

  if (result['error'] === 'locked') {
    return {
      ok: false,
      message:
        (result['message'] as string) ??
        'Too many wrong PINs. Try again shortly, or call the district office.',
    }
  }

  const left = result['attempts_left'] as number | undefined
  return {
    ok: false,
    message:
      left === undefined
        ? 'That clinic code and PIN do not match.'
        : `That PIN is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before this clinic is locked for 15 minutes.`,
    ...(left === undefined ? {} : { attemptsLeft: left }),
  }
}
