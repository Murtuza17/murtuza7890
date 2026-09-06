import { describe, expect, it } from 'vitest'
import { t, STRINGS, type Lang, type TranslationKey } from './i18n'

describe('i18n localization', () => {
  const languages: Lang[] = ['en', 'te', 'hi']

  it('provides translations for all keys across all supported languages', () => {
    const keys = Object.keys(STRINGS) as TranslationKey[]
    expect(keys.length).toBeGreaterThan(15)

    for (const key of keys) {
      for (const lang of languages) {
        const translated = t(key, lang)
        expect(translated).toBeDefined()
        expect(translated.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('falls back to English when a translation is missing or language is unknown', () => {
    expect(t('tabStock', 'en')).toBe('Your stock')
    expect(t('tabStock', 'te')).toBe('మీ నిల్వ')
    expect(t('tabStock', 'hi')).toBe('आपका स्टॉक')
  })

  it('translates critical urgency and outbreak terms clearly', () => {
    expect(t('outbreak', 'te')).toContain('అవుట్‌బ్రేక్')
    expect(t('outbreak', 'hi')).toContain('प्रकोप')
    expect(t('urgent', 'te')).toBe('అత్యవసరం')
    expect(t('urgent', 'hi')).toBe('ज़रूरी')
  })

  /**
   * Caught a real bug: tabRequests.hi once read 'అనురోధ్ / मांग' — Telugu
   * script leaked into the Hindi slot. A worker who chose Hindi because they
   * cannot read Telugu would have hit Telugu characters on the very first
   * tab label. Length-only checks (the first test above) can't catch this —
   * a non-empty string of the wrong script still passes those.
   */
  it('never lets one language\'s script leak into another\'s slot', () => {
    const teluguChar = /[ఀ-౿]/
    const devanagariChar = /[ऀ-ॿ]/
    for (const key of Object.keys(STRINGS) as TranslationKey[]) {
      expect(t(key, 'hi')).not.toMatch(teluguChar)
      expect(t(key, 'te')).not.toMatch(devanagariChar)
    }
  })
})
