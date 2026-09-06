/**
 * Trilingual localization module — English, Telugu (తెలుగు), Hindi (हिन्दी).
 *
 * Designed for rural livestock assistants across Telangana and central India.
 * Pure logic with zero dependencies, 100% offline-compatible.
 */

export type Lang = 'en' | 'te' | 'hi'

export const LANG_LABELS: Record<Lang, { code: string; label: string }> = {
  en: { code: 'EN', label: 'English' },
  te: { code: 'తె', label: 'తెలుగు' },
  hi: { code: 'हि', label: 'हिन्दी' },
}

export const STRINGS = {
  // Tabs
  tabStock: {
    en: 'Your stock',
    te: 'మీ నిల్వ',
    hi: 'आपका स्टॉक',
  },
  tabRequests: {
    en: 'Requests',
    te: 'అభ్యర్థనలు',
    hi: 'अनुरोध',
  },
  tabTransfers: {
    en: 'Transfers',
    te: 'బదిలీలు',
    hi: 'स्थानांतरण',
  },

  // Common Actions
  askForMedicine: {
    en: 'Ask for medicine',
    te: 'మందులు అడగండి',
    hi: 'दवा का अनुरोध करें',
  },
  addBatch: {
    en: 'Add a batch',
    te: 'కొత్త బ్యాచ్ జోడించండి',
    hi: 'नया बैच जोड़ें',
  },
  claim: {
    en: 'Claim',
    te: 'క్లెయిమ్ చేయండి',
    hi: 'दावा करें',
  },
  dictate: {
    en: 'Dictate',
    te: 'వాయిస్ ద్వారా చెప్పండి',
    hi: 'बोलकर बताएं',
  },
  listening: {
    en: 'Listening…',
    te: 'వింటోంది…',
    hi: 'सुन रहा है…',
  },
  fillInForMe: {
    en: 'Fill this in for me',
    te: 'నా కోసం నింపండి',
    hi: 'मेरे लिए भरें',
  },
  signOut: {
    en: 'Sign out',
    te: 'లాగ్ అవుట్',
    hi: 'साइन आउट',
  },

  // Urgency levels
  outbreak: {
    en: 'Outbreak',
    te: 'అవుట్‌బ్రేక్ (తీవ్రం)',
    hi: 'प्रकोप (अति-गंभीर)',
  },
  urgent: {
    en: 'Urgent',
    te: 'అత్యవసరం',
    hi: 'ज़रूरी',
  },
  routine: {
    en: 'Routine',
    te: 'సాధారణం',
    hi: 'सामान्य',
  },

  // Statuses
  offered: {
    en: 'Offered — not claimed yet',
    te: 'ఆఫర్ చేయబడింది — ఇంకా క్లెయిమ్ కాలేదు',
    hi: 'प्रस्तावित — अभी दावा नहीं',
  },
  claimed: {
    en: 'Claimed — not sent yet',
    te: 'క్లెయిమ్ చేయబడింది — ఇంకా పంపలేదు',
    hi: 'दावा किया गया — अभी भेजा नहीं',
  },
  inTransit: {
    en: 'On the way',
    te: 'మార్గంలో ఉంది',
    hi: 'रास्ते में है',
  },
  completed: {
    en: 'Handed over',
    te: 'అప్పగించబడింది',
    hi: 'सौंप दिया गया',
  },
  disputed: {
    en: 'Codes did not match',
    te: 'కోడ్‌లు సరిపోలలేదు',
    hi: 'कोड मेल नहीं खाए',
  },
  waitingToSend: {
    en: 'Waiting to send',
    te: 'పంపడానికి వేచి ఉంది',
    hi: 'भेजने की प्रतीक्षा',
  },
  saved: {
    en: 'Saved',
    te: 'సేవ్ చేయబడింది',
    hi: 'सुरक्षित',
  },
  noSignal: {
    en: 'No signal',
    te: 'సిగ్నల్ లేదు',
    hi: 'नेटवर्क नहीं है',
  },

  // Section Headers
  worthDoingNow: {
    en: 'Worth doing now · predicted from your own usage',
    te: 'ఇప్పుడే చేయదగినవి · మీ వినియోగం ఆధారంగా సూచనలు',
    hi: 'अभी करने योग्य · आपके उपयोग के आधार पर सुझाव',
  },
  yourRequests: {
    en: 'Your requests',
    te: 'మీ అభ్యర్థనలు',
    hi: 'आपके अनुरोध',
  },
  otherVillagesNeed: {
    en: 'Other villages need',
    te: 'ఇతర గ్రామాల అవసరాలు',
    hi: 'अन्य गांवों की ज़रूरतें',
  },
  needsAttention: {
    en: 'Needs attention',
    te: 'శ్రద్ధ వహించాలి',
    hi: 'कार्रवाई की ज़रूरत',
  },
  finished: {
    en: 'Finished',
    te: 'పూర్తయినవి',
    hi: 'पूर्ण',
  },
  outbreakAlert: {
    en: 'Outbreak Alert',
    te: 'అవుట్‌బ్రేక్ హెచ్చరిక',
    hi: 'प्रकोप चेतावनी',
  },
  expiryRiskSummary: {
    en: 'Expiry Risk Summary',
    te: 'గడువు ముగింపు నష్ట అంచనా',
    hi: 'समाप्ति जोखिम सारांश',
  },
} as const

export type TranslationKey = keyof typeof STRINGS

export function t(key: TranslationKey, lang: Lang = 'en'): string {
  const entry = STRINGS[key]
  if (!entry) return key
  return entry[lang] ?? entry.en
}

const STORAGE_KEY = 'rural_vet_lang'

export function getStoredLang(): Lang {
  if (typeof localStorage === 'undefined') return 'en'
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'te' || saved === 'hi' || saved === 'en') return saved
  return 'en'
}

export function setStoredLang(lang: Lang): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, lang)
  }
}
