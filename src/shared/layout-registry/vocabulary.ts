// One derivation of "what the registry knows" for the Layout Doctor, the compiler validator
// and the parity gates (ADR-0020 R1: registered or it doesn't compile).
import {
  FINITE_VALUE_TOKENS,
  GLOBAL_OPTION_GROUPS,
  LAYOUTS,
  OPEN_PATTERN_TOKENS,
  type LayoutDef,
  type OpenPatternToken
} from './entries.ts'
import { meaningForToken, parseTriggerLine } from '../trigger-line.ts'

export type { OpenPatternToken } from './entries.ts'

export interface TriggerVocabulary {
  bareWords: Set<string>
  /** Regex sources of dynamic bare-word families (countdown-…); tested with .exec like the resolver. */
  dynamicSources: string[]
  /** key → allowed explicit values ('' entries from option groups are skipped: '' means "no token"). */
  valueVocab: Map<string, Set<string>>
  openPatterns: Map<string, OpenPatternToken>
}

export function buildTriggerVocabulary(): TriggerVocabulary {
  const bareWords = new Set<string>()
  const dynamicSources: string[] = []
  const valueVocab = new Map<string, Set<string>>()
  const openPatternKeys = new Set(OPEN_PATTERN_TOKENS.map((token) => token.key))
  const addValueToken = (token: string | undefined): void => {
    const raw = String(token ?? '')
    const at = raw.indexOf('=')
    if (at <= 0) return
    const key = raw.slice(0, at)
    if (openPatternKeys.has(key)) return
    const value = raw.slice(at + 1)
    if (!valueVocab.has(key)) valueVocab.set(key, new Set())
    valueVocab.get(key)!.add(value)
  }
  const addGroups = (groups: typeof GLOBAL_OPTION_GROUPS | undefined): void => {
    for (const group of groups ?? []) {
      for (const value of group.values) addValueToken(value.token)
      for (const token of group.dictionaryTokens ?? []) addValueToken(token)
    }
  }
  for (const entry of LAYOUTS) {
    const isTriggerToken = entry.trigger.trim().startsWith('{')
    if (isTriggerToken) {
      for (const word of entry.triggerWords) bareWords.add(word)
      for (const alias of entry.bareAliases ?? []) bareWords.add(alias.word)
    }
    for (const pattern of entry.dynamicPatterns ?? []) dynamicSources.push(pattern.source)
    addGroups(entry.options)
    // Value-form entry triggers ({contrast=cards} today) contribute their value.
    for (const raw of [entry.trigger, ...entry.aliases]) {
      const inner = raw.replace(/^\{|\}$/g, '')
      if (inner.includes('=')) addValueToken(inner)
    }
  }
  addGroups(GLOBAL_OPTION_GROUPS)
  for (const token of FINITE_VALUE_TOKENS) addValueToken(token)
  // The layout key's vocabulary includes layout-kind entry names and every registry entry that
  // reaches a layout through resolvesTo ({code} → layout=code). Both authored forms must validate
  // against the same registry truth, while {layout=nonsense} must still fail.
  valueVocab.set('layout', new Set(LAYOUTS.flatMap((entry) => [
    ...(entry.kind === 'layout' ? [entry.name] : []),
    ...(entry.resolvesTo?.key === 'layout' ? [String(entry.resolvesTo.value)] : [])
  ])))
  const openPatterns = new Map(OPEN_PATTERN_TOKENS.map((token) => [token.key, token]))
  return { bareWords, dynamicSources, valueVocab, openPatterns }
}

export const TRIGGER_VOCABULARY = buildTriggerVocabulary()

/** The shared form-level resolver used by authoring selection and renderer object handling. */
export function isRegisteredTriggerToken(
  raw: string,
  vocab: TriggerVocabulary = TRIGGER_VOCABULARY
): boolean {
  const equals = raw.indexOf('=')
  if (equals > 0) {
    const key = raw.slice(0, equals)
    const value = raw.slice(equals + 1)
    const listed = vocab.valueVocab.get(key)
    const open = vocab.openPatterns.get(key)
    return Boolean(
      listed?.has(value)
      || (
        open?.form === 'equals'
        && open.pattern
        && new RegExp(`^(?:${open.pattern})$`).test(value)
      )
    )
  }

  const colon = raw.indexOf(':')
  if (colon > 0 && /^[\w-]+$/.test(raw.slice(0, colon))) {
    const key = raw.slice(0, colon)
    const value = raw.slice(colon + 1)
    const open = vocab.openPatterns.get(key)
    return Boolean(
      open?.form === 'colon'
      && open.pattern
      && new RegExp(`^(?:${open.pattern})$`).test(value)
    )
  }

  if (!/^[\w-]+$/.test(raw)) return false
  return vocab.bareWords.has(raw)
    || vocab.dynamicSources.some((source) => new RegExp(source).test(raw))
}

export interface WinningAuthoredLayout {
  layout: string
  triggerToken: string
}

type AuthoredAttribute = {
  value: string | boolean
  triggerToken: string
}

function isCompilerGridDimension(value: string | boolean): boolean {
  if (typeof value !== 'string') return false
  const match = value.trim().match(/^(\d+)\s*[x×X]\s*(\d+)$/)
  return Boolean(match && Number(match[1]) >= 1 && Number(match[2]) >= 1)
}

/**
 * Resolve the authored half of the compiler's inferLayout precedence for REGISTERED tokens.
 * Unresolved-but-applied compiler attrs intentionally stay outside this authoring mirror.
 * Content-based fallbacks do not belong here because callers resolve a Trigger line, not a body.
 */
export function winningAuthoredLayout(
  line: string,
  vocab: TriggerVocabulary = TRIGGER_VOCABULARY
): WinningAuthoredLayout | null {
  const attrs = new Map<string, AuthoredAttribute>()
  for (const token of parseTriggerLine(line)) {
    if (!isRegisteredTriggerToken(token.raw, vocab)) continue
    const equals = token.raw.indexOf('=')
    const colon = token.raw.indexOf(':')
    const meanings = equals <= 0 && colon > 0
      ? [{ key: token.raw.slice(0, colon), value: token.raw.slice(colon + 1) }]
      : meaningForToken(token.raw)
    for (const meaning of meanings) {
      attrs.set(meaning.key, {
        value: meaning.value,
        triggerToken: token.raw
      })
    }
  }

  const explicit = attrs.get('layout')
  if (typeof explicit?.value === 'string') {
    return { layout: explicit.value, triggerToken: explicit.triggerToken }
  }

  const implied = (
    key: string,
    layout: string,
    accepts: (value: string | boolean) => boolean = (value) => value !== true
  ): WinningAuthoredLayout | null => {
    const attr = attrs.get(key)
    return attr && accepts(attr.value)
      ? { layout, triggerToken: attr.triggerToken }
      : null
  }

  return implied('statement', 'statement', () => true)
    ?? implied('cols', 'columns')
    ?? implied('timeline', 'timeline')
    ?? implied('chart', 'chart')
    ?? implied('curve', 'sigmoid', (value) => value === 'sigmoid')
    ?? implied('contrast', 'contrast')
    ?? implied('equation', 'equation')
    ?? implied('blocks', 'grid', isCompilerGridDimension)
    ?? implied('cards', 'cards')
}

function rawTriggerTokens(source: string): string[] {
  const groups = [...source.matchAll(/\{([^}]*)\}/g)]
    .flatMap((group) => group[1].split(/[\s,]+/))
    .filter(Boolean)
  if (groups.length > 0) return groups
  const trimmed = source.trim()
  return /^[\w-]+(?:=[^\s{}]+)?$/.test(trimmed) ? [trimmed] : []
}

/**
 * A registry entry owns a token only when the global compiler vocabulary accepts it and the
 * entry itself declares it. This closes the old `entry.name=<anything>` authoring shortcut.
 */
export function layoutEntryAcceptsTriggerToken(
  entry: LayoutDef,
  raw: string,
  vocab: TriggerVocabulary = TRIGGER_VOCABULARY
): boolean {
  if (!isRegisteredTriggerToken(raw, vocab)) return false
  const identityTokens = [
    ...rawTriggerTokens(entry.trigger),
    ...entry.aliases.flatMap(rawTriggerTokens)
  ]
  if (identityTokens.includes(raw)) return true
  if (entry.triggerWords.includes(raw)) return true
  if ((entry.bareAliases ?? []).some((alias) => alias.word === raw)) return true
  if ((entry.dynamicPatterns ?? []).some((pattern) => new RegExp(pattern.source).test(raw))) {
    return true
  }
  const equals = raw.indexOf('=')
  if (equals <= 0 || raw.slice(0, equals) !== entry.name) return false
  return (entry.options ?? []).some((group) =>
    group.values.some((value) => value.token === raw)
    || (group.dictionaryTokens ?? []).includes(raw)
  )
}
