import { describe, expect, it } from 'vitest'
import { MAX_QTY, nearestAllowedRadius, validateProposal } from './intake'

const catalogue = new Map([
  ['d-fmd', { id: 'd-fmd', name: 'Foot & Mouth Disease vaccine' }],
  ['d-asv', { id: 'd-asv', name: 'Polyvalent Snake Antivenom' }],
])

const good = {
  drugId: 'd-fmd', qtyNeeded: 20, urgency: 'outbreak',
  radiusKm: 40, neededByDays: 3, note: 'Two herds down at Peddapur',
}

describe('a clean proposal', () => {
  it('passes through intact', () => {
    const result = validateProposal(good, catalogue)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fields).toEqual({
      drugId: 'd-fmd', qtyNeeded: 20, urgency: 'outbreak',
      radiusKm: 40, neededByDays: 3, note: 'Two herds down at Peddapur',
    })
    expect(result.warnings).toEqual([])
  })
})

describe('a hallucinated drug can never reach the database', () => {
  it('refuses an id that is not in the catalogue', () => {
    // The catalogue is §3's trust safeguard. This path changes how a worker
    // REACHES it, never what may enter the database.
    const result = validateProposal({ ...good, drugId: 'd-invented' }, catalogue)
    expect(result).toEqual({ ok: false, reason: 'no_drug_match', drugNameGuess: null })
  })

  it('hands back what the model thought it heard, so the picker can be pre-filtered', () => {
    const result = validateProposal(
      { ...good, drugId: null, drugNameGuess: 'foot and mouth' },
      catalogue,
    )
    expect(result).toEqual({
      ok: false, reason: 'no_drug_match', drugNameGuess: 'foot and mouth',
    })
  })

  it('refuses a name in place of an id — resolution is by id only', () => {
    const result = validateProposal(
      { ...good, drugId: 'Foot & Mouth Disease vaccine' },
      catalogue,
    )
    expect(result.ok).toBe(false)
  })
})

describe('prompt injection through the worker’s own sentence', () => {
  /**
   * The sentence is untrusted input. A worker — or someone handing them a
   * phone — can write anything into it. Bounds here plus a human confirming
   * the draft mean the worst case is a nonsense draft that gets declined.
   */
  it('caps an absurd quantity and says so out loud', () => {
    const result = validateProposal({ ...good, qtyNeeded: 9999 }, catalogue)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fields.qtyNeeded).toBe(MAX_QTY)
    expect(result.warnings[0]).toContain('9999')
    expect(result.warnings[0]).toContain('capped')
  })

  it('rejects a made-up urgency rather than passing it through', () => {
    const result = validateProposal({ ...good, urgency: 'CRITICAL_OVERRIDE' }, catalogue)
    expect(result.ok && result.fields.urgency).toBe('urgent')
  })

  it('clamps a needed-by date far in the future', () => {
    const result = validateProposal({ ...good, neededByDays: 99999 }, catalogue)
    expect(result.ok && result.fields.neededByDays).toBe(30)
  })

  it('truncates a note long enough to be an attack rather than a note', () => {
    const result = validateProposal({ ...good, note: 'x'.repeat(5000) }, catalogue)
    expect(result.ok && result.fields.note.length).toBe(140)
  })
})

describe('malformed model output', () => {
  it('rejects a missing or zero quantity instead of inventing one', () => {
    expect(validateProposal({ ...good, qtyNeeded: undefined }, catalogue).ok).toBe(false)
    expect(validateProposal({ ...good, qtyNeeded: 0 }, catalogue).ok).toBe(false)
    expect(validateProposal({ ...good, qtyNeeded: -5 }, catalogue).ok).toBe(false)
  })

  it('accepts a clean numeral sent as a string, since models do that', () => {
    expect(validateProposal({ ...good, qtyNeeded: '20' }, catalogue).ok).toBe(true)
  })

  it('refuses a spelled-out number rather than guessing at it', () => {
    expect(validateProposal({ ...good, qtyNeeded: 'twenty' }, catalogue).ok).toBe(false)
  })

  it('survives entirely junk input without throwing', () => {
    expect(validateProposal({}, catalogue).ok).toBe(false)
    expect(validateProposal({ drugId: 42, qtyNeeded: {} }, catalogue).ok).toBe(false)
  })

  it('floors a fractional quantity — vials are whole things', () => {
    expect(validateProposal({ ...good, qtyNeeded: 12.7 }, catalogue).ok && true).toBe(true)
    const r = validateProposal({ ...good, qtyNeeded: 12.7 }, catalogue)
    expect(r.ok && r.fields.qtyNeeded).toBe(12)
  })
})

describe('defaults match what the manual form offers', () => {
  it('snaps a radius to an option the form actually has', () => {
    // A worker must be able to reproduce the draft by hand afterwards.
    expect(nearestAllowedRadius(25)).toBe(20)
    expect(nearestAllowedRadius(45)).toBe(40)
    expect(nearestAllowedRadius(3)).toBe(10)
    expect(nearestAllowedRadius(null)).toBe(40)
  })

  it('defaults urgency to urgent, not outbreak', () => {
    // Defaulting to the loudest level would train workers to ignore it.
    const result = validateProposal({ ...good, urgency: undefined }, catalogue)
    expect(result.ok && result.fields.urgency).toBe('urgent')
  })

  it('defaults a missing deadline to three days', () => {
    const result = validateProposal({ ...good, neededByDays: undefined }, catalogue)
    expect(result.ok && result.fields.neededByDays).toBe(3)
  })
})
