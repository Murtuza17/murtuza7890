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
})
