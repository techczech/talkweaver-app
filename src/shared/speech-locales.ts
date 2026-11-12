// Apple supported-locale inventory, macOS 26.5; runtime inventory narrows model states.
export const SPEECH_LOCALES = ["ar-SA", "ca-ES", "cs-CZ", "da-DK", "de-AT", "de-CH", "de-DE", "el-GR", "en-AU", "en-CA", "en-GB", "en-IE", "en-IN", "en-NZ", "en-SG", "en-US", "en-ZA", "es-CL", "es-ES", "es-MX", "es-US", "fi-FI", "fr-BE", "fr-CA", "fr-CH", "fr-FR", "he-IL", "hi-IN", "hr-HR", "hu-HU", "id-ID", "it-CH", "it-IT", "ja-JP", "ko-KR", "ms-MY", "nb-NO", "nl-BE", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU", "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN", "yue-CN", "zh-CN", "zh-HK", "zh-TW"] as const

const languageNames = new Intl.DisplayNames(['en-GB'], {type:'language'})
export function speechLanguageName(locale: string): string {
  try { return languageNames.of(locale) || locale } catch { return locale }
}
