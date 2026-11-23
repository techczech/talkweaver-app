// The set-up folder (0.45, two Macs): the file format, the names, the merge rule and the words.
// The engine that reads and writes the folder is src/main/setup-folder.ts; the Settings page is
// src/renderer/src/components/SetupFolderPage.tsx.
//
// The rules (the lesson of 0.45: storage shared through a sync service converges only when it is
// simple), each checkable by reading:
//   F1  Each Mac writes only its own file, `mac-<id>.json`, named by this install's id. No Mac opens
//       another Mac's file for writing, renames over it or deletes it.
//   F2  A file is a Mac's file only when its name is exactly `mac-<uuid>.json` and the id inside it is
//       the id in its name. Every other name that carries a Mac id (a sync service's conflict copy,
//       iCloud's "not downloaded" placeholder) is skipped and named; nothing is guessed or repaired.
//   F3  Reading is a merge: per setting, the value with the newest change time across every Mac,
//       this one included, wins; a tie goes to this Mac (between two other Macs, to the larger id, so
//       every Mac picks the same one). Writing is local: the result is applied to this Mac's own
//       settings through the settings store's import (change log, undo), then this Mac's file is written.
//   F4  A change made on this Mac is stamped later than the value it replaced, whatever the clocks
//       say (`localStamp`): a change made after seeing another Mac's value always wins, on every Mac.
//       Clocks decide only between changes made on two Macs before either saw the other's.
//   F5  Nothing travels by default: only the settings named in TRAVELLING, each of one kind (plain text
//       of a small set of characters, a web address in its normal form, an identifier by its exact
//       pattern, or a number, toggle or choice by its schema), the shortcuts, per-vault personal settings
//       by vault id, and two addresses offered as suggestions. Every other setting is named in
//       STAYS_ON_THIS_MAC. Text is never searched for what is unsafe in it; only text that cannot be travels.
//   F6  Every byte read from the folder is untrusted: a file or entry is used only after parseMacFile
//       has judged it by the same rules (and change times by isChangeTime: none more than five minutes
//       after this Mac's clock); the rest is counted and named.
//
// Pure; erasable TypeScript only (node tests import it as it is; the renderer imports the words).
import { checkValue, chordShapeError, type CommandsAdapter, type Schema, type SettingDef, type SettingValue } from '@app-patterns/settings'
import { cleanPersonal } from './vault-personal.ts'
import { isEditorKeyString } from './keymap-overrides.ts'

/** The folder TalkWeaver makes inside the folder chosen (unless the folder chosen is one already). */
export const SETUP_FOLDER_NAME = 'TalkWeaver set-up'
/** The per-Mac setting that holds the folder chosen. Local only: it never travels. */
export const SETUP_FOLDER_SETTING = 'setup.folder'
/** The Settings page (and schema section) of the set-up folder. */
export const SETUP_FOLDER_SECTION = 'setup-folder'
export const SETUP_FILE_FORMAT = 'talkweaver-setup'
export const SETUP_FILE_VERSION = 1
/** A set-up file is a few kilobytes; anything over this is not one. */
export const SETUP_FILE_MAX_BYTES = 1024 * 1024
/** A change time further ahead of this Mac's clock than this is not taken into the merge, and the clocks are reported. */
export const CLOCK_MARGIN_MS = 5 * 60_000
/** This Mac's file is written again at least this often while the app runs, so "last active" means something. */
export const HEARTBEAT_MS = 12 * 3600_000
/** Entries per section of a file; more is not a set-up file. */
export const MAX_ENTRIES = 2000

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const MAC_FILE_RE = new RegExp(`^mac-(${UUID})\\.json$`)
const HAS_MAC_ID_RE = new RegExp(`mac-(${UUID})`)
const UUID_RE = new RegExp(`^${UUID}$`)

export const isMacId = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value)
export const macFileName = (macId: string): string => `mac-${macId}.json`
/** This Mac's temporary file while it writes its own (a dot file beside it; only this Mac removes its own). */
export const ownTempPrefix = (macId: string): string => `.mac-${macId}.json.`

export type NameKind =
  | { kind: 'mac'; macId: string }
  /** iCloud's stand-in for a file not downloaded yet (`.name.icloud`). */
  | { kind: 'placeholder'; macId: string }
  /** Another name carrying a Mac id: a sync service's conflict copy, or a renamed file. */
  | { kind: 'copy'; macId: string }
  /** A writer's temporary file (`.mac-<id>.json.<…>.tmp`): in progress, not read. */
  | { kind: 'temp'; macId: string }
  | { kind: 'ignore' }

/** What a name in the set-up folder is (F2). */
export function classifyName(name: string): NameKind {
  const exact = MAC_FILE_RE.exec(name)
  if (exact) return { kind: 'mac', macId: exact[1] }
  const any = HAS_MAC_ID_RE.exec(name)
  if (!any) return { kind: 'ignore' }
  const macId = any[1]
  if (name.startsWith('.') && name.endsWith('.icloud')) return { kind: 'placeholder', macId }
  if (name.startsWith(ownTempPrefix(macId)) && name.endsWith('.tmp')) return { kind: 'temp', macId }
  return { kind: 'copy', macId }
}

/**
 * The folder the set-up files live in, from the folder chosen: the chosen folder itself when it is a
 * `TalkWeaver set-up` folder, else that folder inside it. '' when nothing is chosen. `~` is the home folder.
 */
export function resolveSetupFolder(chosen: unknown, home: string): string {
  if (typeof chosen !== 'string') return ''
  let p = chosen.trim()
  if (!p) return ''
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = `${home.replace(/\/+$/, '')}/${p.slice(2)}`
  p = p.replace(/\/+$/, '') || '/'
  const last = p.split('/').pop() ?? ''
  return last === SETUP_FOLDER_NAME ? p : `${p === '/' ? '' : p}/${SETUP_FOLDER_NAME}`
}

// ── Change times ───────────────────────────────────────────────────────────────────────────────

/** No change time, and no file time, is earlier than this (1 January 2020): a value of unknown age is stamped with it. */
export const EARLIEST_AT = Date.UTC(2020, 0, 1)
/** A time at all: whole milliseconds, not before EARLIEST_AT. A file's own time must be one (how far ahead it is decides only the clock message). */
export const isFileTime = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= EARLIEST_AT
/** A change time that may enter the merge: a time, not more than CLOCK_MARGIN_MS after this Mac's clock `now`. */
export const isChangeTime = (at: unknown, now: number): at is number => isFileTime(at) && at <= now + CLOCK_MARGIN_MS

// ── What travels (F5): the allow-list ──────────────────────────────────────────────────────────
//
// Nothing travels by default. A setting travels only when TRAVELLING names it with its kind and the rule
// that turns this Mac's value into the value written, or refuses it: the setting then stays on this Mac,
// unaltered (not cut, not cleaned, not replaced from the folder), and the page names it and says why. Every
// other setting of the schema is named in STAYS_ON_THIS_MAC with its reason; scripts/test-setup-folder.mjs
// fails, naming the key, when a setting is in neither. A value read from another Mac's file is accepted only
// when its rule returns it unchanged.
//
// Text is never judged by looking for what is unsafe in it (a path, an address, a token): only text that
// cannot be unsafe travels. Every text value is one of three kinds:
//   plain text   every character a letter, digit or combining mark of any script, the space, or one of
//                . , ' ’ - – — ( ) & ! +   and at most 200 characters. Such text cannot spell a path, a web
//                address, a user name and password, or a query.
//   address      a value that is by definition a web address: http or https, a host, no user name or
//                password, no query, no fragment, a plain path, written exactly as the URL parser writes it
//                (another spelling is refused, never rewritten).
//   identifier   a name with its own exact pattern: the Cloudflare account id, a site, a branch, a command,
//                a key, a colour.
// Numbers, toggles and choices are checked by their schema (type, range, options).

export type TravelKind = 'plain-text' | 'address' | 'identifier' | 'number' | 'toggle' | 'choice'
export type Verdict = { ok: true; value: SettingValue } | { ok: false; why: string }
const yes = (value: SettingValue): Verdict => ({ ok: true, value })
const no = (why: string): Verdict => ({ ok: false, why })

/** Plain text that travels is at most this many characters. */
export const MAX_PLAIN = 200
/** A web address that travels is at most this long. */
export const MAX_URL = 300
/** Why plain text stays on this Mac (the page says it). */
export const PLAIN_REFUSED = 'contains characters that are not sent to the set-up folder'

// Letters, combining marks and digits of any script, the space and twelve marks; nothing else. The combining
// overlays that draw a stroke or a slash through a letter (U+0334–U+0338, U+20D2–U+20D6, U+20E5–U+20E6) are left out.
// Characters that draw nothing (default-ignorable: fillers, variation selectors, the grapheme joiner) and the
// enclosing circle-backslash (U+20E0) are left out too.
const PLAIN_RE = /^(?:(?![\u0334-\u0338\u20D2-\u20D6\u20E0\u20E5\u20E6]|\p{Default_Ignorable_Code_Point})[\p{L}\p{M}\p{N} .,'’\-–—()&!+])*$/u
/** Plain text as it travels: returned unchanged, or refused (never altered). */
export function plainText(value: unknown): Verdict {
  if (typeof value !== 'string') return no('is not text')
  if ([...value].length > MAX_PLAIN) return no(`is longer than ${MAX_PLAIN} characters`)
  return PLAIN_RE.test(value) ? yes(value) : no(PLAIN_REFUSED)
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/
/** Why a web address does not travel, or null: see "address" above. */
export function addressProblem(raw: string): string | null {
  if (raw.length > MAX_URL) return `is longer than ${MAX_URL} characters`
  if (!/^[\x21-\x7e]+$/.test(raw)) return 'is not a web address (it has spaces or characters an address does not have)'
  let url: URL
  try { url = new URL(raw) } catch { return 'is not a web address written in full (http:// or https:// first)' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'is not an http or https address'
  if (url.username || url.password) return 'holds a user name or password'
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) return 'has a query or fragment (?… or #…), which can hold a token'
  if (!HOST_RE.test(url.hostname)) return 'has no host name of lower-case letters, digits, dots and hyphens'
  if (!URL_PATH_RE.test(url.pathname)) return 'has characters in its path that are not sent (letters, digits and . _ ~ / - only)'
  if (raw !== url.href && !(url.pathname === '/' && `${raw}/` === url.href)) return 'is not written the way a web address is written (https://host/path, lower case)'
  return null
}
/** A host name (share.example.com): lower-case letters, digits, dots and hyphens. */
export const isHostName = (value: unknown): value is string => typeof value === 'string' && HOST_RE.test(value)

type Rule = (value: unknown, def: SettingDef) => Verdict
export type Travel = Readonly<{ kind: TravelKind; rule: Rule }>
/** The setting's own check (type, options, range, its validate): what its setter runs. */
const checked: Rule = (value, def) => { const e = checkValue(def, value); return e ? no(`does not pass the setting’s own check (${e})`) : yes(value as SettingValue) }
const plain: Travel = { kind: 'plain-text', rule: (value, def) => { const t = plainText(value); return t.ok ? checked(t.value, def) : t } }
const address: Travel = {
  kind: 'address',
  rule: (value, def) => {
    if (typeof value !== 'string') return no('is not text')
    if (value === '') return checked('', def)
    const p = addressProblem(value)
    return p ? no(p) : checked(value, def)
  }
}
/** The speaker's web address on the posters: an address, or a bare host name as a poster shows one (example.com). */
const webAddress: Travel = { kind: 'address', rule: (value, def) => (isHostName(value) ? checked(value, def) : address.rule(value, def)) }
const number: Travel = { kind: 'number', rule: checked }
const toggle: Travel = { kind: 'toggle', rule: checked }
const choice: Travel = { kind: 'choice', rule: checked }
/** An identifier: '' or the exact pattern, then the setting's own check. */
const identifier = (re: RegExp, why: string, extra: (v: string) => boolean = () => true): Travel => ({
  kind: 'identifier',
  rule: (value, def) => (typeof value === 'string' && (value === '' || (re.test(value) && extra(value))) ? checked(value, def) : no(why))
})
const WORD = '[a-z]+(?:-[a-z]+)*'
const TRIGGER = '[a-z][a-z0-9-]*(?:=[A-Za-z0-9.-]+)?'
const COMMAND_RE = /^[a-z][a-z0-9-]{0,40}(?:\.[a-z0-9-]{1,40}){0,3}$/
/** Keys changed inside the editor (JSON, command → CodeMirror key): each command and key by its pattern, written sorted. */
const editorKeys: Travel = {
  kind: 'identifier',
  rule: (value, def) => {
    if (typeof value !== 'string') return no('is not text')
    if (value === '') return checked('', def)
    let raw: unknown
    try { raw = JSON.parse(value) } catch { return no('is not a list of keys') }
    if (!isBag(raw)) return no('is not a list of keys')
    const entries = Object.entries(raw)
    if (entries.length > 200) return no('has more than 200 keys')
    const out: Record<string, string> = {}
    for (const [command, key] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!COMMAND_RE.test(command)) return no('names a command that is not one')
      if (typeof key !== 'string' || (key !== '' && (key !== key.trim() || !isEditorKeyString(key)))) return no('holds a key the editor does not know')
      out[command] = key
    }
    return checked(JSON.stringify(out), def)
  }
}

/** Every setting that travels, with its kind and the rule that writes (or refuses) its value. Nothing else travels. */
export const TRAVELLING: Readonly<Record<string, Travel>> = {
  'general.theme': choice,
  'general.placeChip': toggle,
  'general.guideButton': toggle,
  'general.imageText': toggle,
  'writing.openInView': choice,
  'writing.slidesPanelView': choice,
  'writing.slideTabView': choice,
  'writing.plainFont': choice,
  'writing.plainTextSize': number,
  'writing.editorKeys': editorKeys,
  'writing.actionBar': toggle,
  'presenting.warnAt': number,
  'presenting.urgentAt': number,
  'presenting.backup': toggle,
  'presenting.backupEvery': number,
  'publishing.shortLinks': toggle,
  // Cloudflare's own formats: the account id is 32 hexadecimal digits; a Pages site is lower-case letters, digits and hyphens (at most 58).
  'publishing.cloudflareAccount': identifier(/^[0-9a-f]{32}$/, 'is not a Cloudflare account id (32 characters, digits and a to f)'),
  'publishing.cloudflareSite': identifier(/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/, 'is not a Cloudflare Pages site name (lower-case letters, digits and hyphens)'),
  // Git's branch names, narrowed: no slash (it reads as a folder), no "..", not ending ".lock".
  'publishing.branch': identifier(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/, 'is not a branch name that travels (letters, digits and . _ - only, no slash)', (v) => !v.includes('..') && !v.endsWith('.lock')),
  'recording.discardShorter': number,
  'recording.wordsLocale': choice,
  'importing.includeHidden': toggle,
  'importing.keepNotes': toggle,
  'importing.extractMedia': toggle,
  'importing.fallback': choice,
  'importing.renderer': choice,
  'updates.checkForNewVersions': toggle,
  'updates.alphaVersions': toggle,
  'talkDefaults.author': plain,
  'talkDefaults.hide_email': choice,
  'talkDefaults.image_steps': choice,
  'talkDefaults.live_look_ahead': choice,
  'talkDefaults.auto_title_slide': choice,
  'talkDefaults.auto_thanks_slide': choice,
  'talkDefaults.thanks': plain,
  'talkDefaults.links_index': choice,
  'talkDefaults.series': plain,
  'talkDefaults.web': webAddress,
  'talkDefaults.affiliation': plain,
  'talkDefaults.colour': choice,
  'talkDefaults.title_style': choice,
  'talkDefaults.font': choice,
  'talkDefaults.title_look': choice,
  'talkDefaults.title_look_tone': choice,
  'talkDefaults.claim_style': choice,
  'talkDefaults.narrow_columns': choice,
  'talkDefaults.screenshot_style': choice,
  'talkDefaults.screenshot_list': choice,
  'talkDefaults.palette': choice,
  // One colour name or a list (blue, light): lower-case words with hyphens, commas between; then the list's own check.
  'talkDefaults.section-colours': identifier(new RegExp(`^${WORD}(?:, ?${WORD}){0,19}$`), 'is not a colour name or a list of them'),
  'talkDefaults.section_labels': choice,
  // Trigger words as on a slide's {…} line (reveal numbered, mode=focus).
  'talkDefaults.triggers': identifier(new RegExp(`^${TRIGGER}(?: ${TRIGGER}){0,19}$`), 'is not a list of trigger words (word or word=value, spaces between)', (v) => v.length <= MAX_PLAIN),
  'talkDefaults.logo-colour': choice,
  'talkDefaults.license': choice,
  'talkDefaults.license-note': plain,
  'talkDefaults.license-url': address
}

/** Every setting that never travels, with why. A setting in neither table fails the test. */
export const STAYS_ON_THIS_MAC: Readonly<Record<string, string>> = {
  'general.imageArchive': 'a folder on this Mac',
  'presenting.backupFolder': 'a folder on this Mac',
  'publishing.siteFolder': 'a folder on this Mac',
  'setup.folder': 'which folder this Mac shares its set-up through',
  'publishing.customDomain': 'an address handouts go to: offered to your other Macs to confirm instead',
  'recording.capture': 'what this Mac’s own camera and microphone record',
  'recording.camera': 'a device of this Mac',
  'recording.microphone': 'a device of this Mac',
  'recording.endpoint': 'where recordings are sent',
  'recording.bucket': 'where recordings are sent',
  'recording.wordsEngine': 'which engine writes the words out depends on what is installed on each Mac (macOS 26, Parakeet)',
  'recording.transcriptionPython': 'a program on this Mac',
  'recording.transcriptionScript': 'a program on this Mac',
  'recording.ffmpeg': 'a program on this Mac',
  'accounts.cloudflare': 'a key',
  'accounts.recording': 'a key',
  // Text that holds links and colons by design: no kind of text that travels keeps its ordinary values.
  'talkDefaults.cta': 'the closing slide’s call to action says where to find you, which is usually a web address',
  'talkDefaults.credits': 'credits name sources, with links and colons, by design',
  'talkDefaults.logo': 'a logo value is looked up as a file beside the talk when it is not a built-in name, so it is a file reference'
}
/** Kept for readers of 0.45's first draft: the importable settings that still stay on each Mac. */
export const PER_MAC_KEYS: Readonly<Record<string, string>> = { 'recording.wordsEngine': STAYS_ON_THIS_MAC['recording.wordsEngine'] }

/**
 * Where publishing goes. Applied on first join with the rest of the preview; after that, a change from
 * another Mac is offered here (Use on this Mac), never applied by a read.
 */
export const ASK_FIRST = ['publishing.cloudflareAccount', 'publishing.cloudflareSite', 'publishing.branch'] as const
export type AskFirstKey = (typeof ASK_FIRST)[number]
export const isAskFirst = (key: string): key is AskFirstKey => (ASK_FIRST as readonly string[]).includes(key)

/** The settings of this schema that travel: those TRAVELLING names. */
export function travellingSettingKeys(schema: Schema): string[] {
  return schema.settings.filter((d) => Object.hasOwn(TRAVELLING, d.key)).map((d) => d.key)
}
/** The settings of this schema that never travel. */
export function stayingSettingKeys(schema: Schema): string[] {
  return schema.settings.filter((d) => !Object.hasOwn(TRAVELLING, d.key)).map((d) => d.key)
}
/** Settings named in neither table (must be none; the test names them). */
export function unlistedSettingKeys(schema: Schema): string[] {
  return schema.settings.filter((d) => !Object.hasOwn(TRAVELLING, d.key) && !Object.hasOwn(STAYS_ON_THIS_MAC, d.key)).map((d) => d.key)
}

/** The value written for a setting, or why it stays on this Mac. */
export function serialiseSetting(schema: Schema, key: string, value: unknown): Verdict {
  if (!Object.hasOwn(TRAVELLING, key)) return no('stays on this Mac')
  const def = schema.def(key)
  if (!def) return no('is not a setting of this version')
  return TRAVELLING[key].rule(value, def)
}
/** A shortcut as it travels (an identifier): a command of this version, a chord of the shape the settings store keeps. */
export function serialiseChord(commands: Pick<CommandsAdapter, 'isCommand'>, commandId: string, chord: unknown): Verdict {
  if (!okKey(commandId) || !commands.isCommand(commandId)) return no('is not a command of this version')
  if (typeof chord !== 'string' || chord.length > 64 || chordShapeError(chord) !== null) return no('is not a shortcut')
  return yes(chord)
}
/** The kind of each per-vault field and each address offered to the other Mac. */
export const VAULT_FIELD_KIND: Readonly<Record<VaultField, TravelKind>> = { author: 'plain-text', badgeColour: 'identifier', badgeInitial: 'identifier' }
export const SUGGESTION_KIND: Readonly<Record<SuggestionKind, TravelKind>> = { handoutAddress: 'address', shareLinkAddress: 'identifier' }
/** A vault's personal setting as it travels: what the vault registry's own cleaner keeps, then its kind's rule. */
export function serialiseVaultField(field: VaultField, value: unknown): Verdict {
  if (typeof value !== 'string') return no('is not text')
  if (value === '') return yes('')
  // Never cut to fit: a value longer than the cleaner keeps stays on this Mac whole.
  if (field === 'author' && value.trim().length > 120) return no('is longer than 120 characters')
  if (field === 'badgeInitial' && [...value.trim()].length !== 1) return no('is not one letter or digit')
  const clean = cleanPersonal({ [field]: value })[field]
  if (!clean) return no('is not a value Edit this vault keeps')
  // The author is plain text as Edit this vault keeps it, unaltered: one with spaces or marks the cleaner would trim stays here.
  if (field === 'author') { const t = plainText(value); return !t.ok ? t : clean === value ? yes(clean) : no('has spaces at its start or end') }
  if (field === 'badgeColour') return /^#[0-9a-f]{6}$/.test(clean) ? yes(clean) : no('is not a colour')
  return /^[\p{L}\p{N}]$/u.test(clean) ? yes(clean) : no('is not one letter or digit')
}
/** An address offered to the other Mac: the handout address (an address), the share-link host name (an identifier). */
export function serialiseSuggestion(kind: SuggestionKind, value: unknown): Verdict {
  if (typeof value !== 'string') return no('is not text')
  if (value === '') return yes('')
  if (kind === 'handoutAddress') { const p = addressProblem(value); return p ? no(p) : yes(value) }
  return isHostName(value) ? yes(value) : no('is not a host name')
}
/** A value from another Mac is accepted only when its rule returns it unchanged. */
const fixed = (v: Verdict, value: unknown): boolean => v.ok && Object.is(v.value, value)

/** This Mac's name as written and as read: plain text of at most 120 characters, else "A Mac" (never cut). */
export function cleanMacName(value: unknown): string {
  if (typeof value !== 'string') return 'A Mac'
  // Judged as given (trim() would also drop invisible marks); only the spaces at its ends are left off.
  const t = value.trim()
  return t && [...t].length <= 120 && plainText(value).ok ? t : 'A Mac'
}

export const VAULT_FIELDS = ['author', 'badgeColour', 'badgeInitial'] as const
export type VaultField = (typeof VAULT_FIELDS)[number]
export const VAULT_FIELD_LABEL: Readonly<Record<VaultField, string>> = { author: 'Author', badgeColour: 'Badge colour', badgeInitial: 'Badge letter' }
const isVaultId = (id: string): boolean => /^[A-Za-z0-9_-]{1,100}$/.test(id)

/** The addresses offered to the other Mac to confirm, never applied by a read. */
export const SUGGESTIONS = ['handoutAddress', 'shareLinkAddress'] as const
export type SuggestionKind = (typeof SUGGESTIONS)[number]
export const SUGGESTION_LABEL: Readonly<Record<SuggestionKind, string>> = { handoutAddress: 'Handout address', shareLinkAddress: 'Share-link address' }

// ── The file ───────────────────────────────────────────────────────────────────────────────────

export type Stamped<V = SettingValue> = { value: V; at: number }

export interface MacFile {
  format: typeof SETUP_FILE_FORMAT
  version: number
  macId: string
  macName: string
  appVersion: string
  /** ms since 1970, this Mac's clock. */
  writtenAt: number
  /** A fresh id on every write: tells this Mac's own writes from another computer writing under its id. */
  writeId: string
  /** Derived from this computer's hardware and the Mac id (never the hardware id itself): a copy of the app data on another Mac writes a different one. '' = not known. */
  mark: string
  settings: Record<string, Stamped>
  shortcuts: Record<string, Stamped<string>>
  /** By vault id (the id in the vault's own `.talkweaver/vault.json`, the same on every Mac). */
  vaults: Record<string, Partial<Record<VaultField, Stamped<string>>>>
  suggestions: Partial<Record<SuggestionKind, Stamped<string>>>
}

export type SkipReason = 'unreadable' | 'git-conflict' | 'copy' | 'placeholder' | 'newer' | 'too-large' | 'wrong-mac' | 'not-downloaded' | 'bad-time' | 'not-read'

export const SKIP_WORDS: Readonly<Record<SkipReason, string>> = {
  unreadable: 'Could not be read as a set-up file. Left as it is.',
  'git-conflict': 'Has Git conflict markers. Left as it is: resolve it in Git.',
  copy: 'A copy the sync service made (a conflict copy or a renamed file). Not read and left as it is.',
  placeholder: 'Not downloaded to this Mac yet. It is read once it is.',
  'not-downloaded': 'Not downloaded to this Mac yet, and TalkWeaver does not download it. It is read once the sync service has.',
  newer: 'Written by a newer TalkWeaver. Update TalkWeaver on this Mac to read it.',
  'too-large': 'Too large to be a set-up file. Left as it is.',
  'wrong-mac': 'Its name and the Mac named inside it do not match (renamed or copied by hand). Not read and left as it is.',
  'bad-time': 'Its time is impossible (not a time, or before 2020). Not read and left as it is.',
  'not-read': 'Not read this time: the folder took too long to answer, or holds too many files. Tried again on the next read.'
}

const isBag = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const okKey = (k: string): boolean => k.length > 0 && k.length <= 200 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype'

/** Judges every entry of another Mac's file before it can be used (the same rules as what this Mac writes). */
export interface EntryJudge {
  /** This Mac's clock now: no change time may be more than CLOCK_MARGIN_MS after it. */
  now: number
  setting(key: string, value: unknown): boolean
  shortcut(commandId: string, chord: unknown): boolean
}
/** The judge from the schema and the command registry: what the setters use. */
export function entryJudge(schema: Schema, commands: Pick<CommandsAdapter, 'isCommand'>, now: number): EntryJudge {
  return {
    now,
    setting: (key, value) => fixed(serialiseSetting(schema, key, value), value),
    shortcut: (commandId, chord) => fixed(serialiseChord(commands, commandId, chord), chord)
  }
}
/** Entries left out of a file, by why. */
export type Rejected = { time: number; value: number; key: number }

function stampedSection<V>(raw: unknown, judge: (key: string, e: Record<string, unknown>) => 'ok' | 'time' | 'value' | 'key', rejected: Rejected): Record<string, Stamped<V>> | null {
  const out = Object.create(null) as Record<string, Stamped<V>>
  if (raw === undefined) return out
  if (!isBag(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > MAX_ENTRIES) return null
  for (const [k, e] of entries) {
    // An entry that is not one is left out and counted, never guessed at; the rest of the file stands.
    const verdict = !okKey(k) ? 'key' : !isBag(e) ? 'value' : judge(k, e)
    if (verdict !== 'ok') { rejected[verdict] += 1; continue }
    out[k] = { value: (e as Record<string, unknown>)['value'] as V, at: (e as Record<string, unknown>)['at'] as number }
  }
  return out
}

/** Git's conflict markers: a `<<<<<<<` line, then `=======`, then `>>>>>>>`. */
export function hasConflictMarkers(text: string): boolean {
  if (!text.includes('<<<<<<<')) return false
  let stage = 0
  for (const line of text.split(/\r?\n/)) {
    if (stage === 0 && line.startsWith('<<<<<<<')) stage = 1
    else if (stage === 1 && line.startsWith('=======')) stage = 2
    else if (stage === 2 && line.startsWith('>>>>>>>')) return true
  }
  return false
}

/**
 * Another Mac's file read from `text`, whose name carries `nameId` (F2). Every byte is untrusted: the file
 * is refused whole when its shape or its own time is wrong; an entry is left out (and counted) when its
 * key is not one that travels, its time is outside the window (isChangeTime) or its value is not one its
 * setting's rule returns unchanged. Never throws.
 */
export function parseMacFile(text: string, nameId: string, judge: EntryJudge): { ok: true; file: MacFile; rejected: Rejected; ahead: number } | { ok: false; reason: SkipReason } {
  if (hasConflictMarkers(text)) return { ok: false, reason: 'git-conflict' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, reason: 'unreadable' } }
  if (!isBag(raw) || raw['format'] !== SETUP_FILE_FORMAT) return { ok: false, reason: 'unreadable' }
  const version = raw['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, reason: 'unreadable' }
  if (version > SETUP_FILE_VERSION) return { ok: false, reason: 'newer' }
  if (raw['macId'] !== nameId) return { ok: false, reason: 'wrong-mac' }
  if (!isFileTime(raw['writtenAt'])) return { ok: false, reason: 'bad-time' }
  const rejected: Rejected = { time: 0, value: 0, key: 0 }
  // The newest time in the file, entries left out for their time included: only for the clock message.
  let newest = raw['writtenAt']
  const timed = (e: Record<string, unknown>, valueOk: boolean): 'ok' | 'time' | 'value' => {
    if (isFileTime(e['at'])) newest = Math.max(newest, e['at'])
    return !isChangeTime(e['at'], judge.now) ? 'time' : valueOk ? 'ok' : 'value'
  }
  const settings = stampedSection<SettingValue>(raw['settings'], (k, e) => (!Object.hasOwn(TRAVELLING, k) ? 'key' : timed(e, judge.setting(k, e['value']))), rejected)
  const shortcuts = stampedSection<string>(raw['shortcuts'], (k, e) => timed(e, judge.shortcut(k, e['value'])), rejected)
  const suggestions = stampedSection<string>(raw['suggestions'], (k, e) => (!(SUGGESTIONS as readonly string[]).includes(k) ? 'key' : timed(e, fixed(serialiseSuggestion(k as SuggestionKind, e['value']), e['value']))), rejected)
  if (!settings || !shortcuts || !suggestions) return { ok: false, reason: 'unreadable' }
  const vaults = Object.create(null) as MacFile['vaults']
  if (raw['vaults'] !== undefined) {
    if (!isBag(raw['vaults']) || Object.keys(raw['vaults']).length > MAX_ENTRIES) return { ok: false, reason: 'unreadable' }
    for (const [id, fields] of Object.entries(raw['vaults'])) {
      if (!okKey(id) || !isVaultId(id)) { rejected.key += 1; continue }
      const section = stampedSection<string>(fields, (f, e) => (!(VAULT_FIELDS as readonly string[]).includes(f) ? 'key' : timed(e, fixed(serialiseVaultField(f as VaultField, e['value']), e['value']))), rejected)
      if (!section) { rejected.value += 1; continue }
      const kept: Partial<Record<VaultField, Stamped<string>>> = {}
      for (const f of VAULT_FIELDS) if (section[f]) kept[f] = section[f]
      vaults[id] = kept
    }
  }
  const appVersion = typeof raw['appVersion'] === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(raw['appVersion']) ? raw['appVersion'] : ''
  const mark = typeof raw['mark'] === 'string' && /^[0-9a-f]{0,64}$/.test(raw['mark']) ? raw['mark'] : ''
  return {
    ok: true,
    rejected,
    ahead: newest - judge.now > CLOCK_MARGIN_MS ? newest - judge.now : 0,
    file: {
      format: SETUP_FILE_FORMAT, version, macId: nameId, macName: cleanMacName(raw['macName']), appVersion,
      writtenAt: raw['writtenAt'] as number,
      writeId: typeof raw['writeId'] === 'string' ? raw['writeId'].slice(0, 80) : '',
      mark, settings, shortcuts, vaults, suggestions: suggestions as MacFile['suggestions']
    }
  }
}

/** Who wrote a file under this Mac's id: only what the ownership check needs (never applied, so not judged). */
export function ownershipOf(text: string): { macId: string; writeId: string; mark: string } | null {
  if (hasConflictMarkers(text)) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!isBag(raw) || raw['format'] !== SETUP_FILE_FORMAT || typeof raw['macId'] !== 'string') return null
  return { macId: raw['macId'], writeId: typeof raw['writeId'] === 'string' ? raw['writeId'] : '', mark: typeof raw['mark'] === 'string' ? raw['mark'] : '' }
}

/** Entries left out, in words: "2 entries not read (a time before 2020 or more than five minutes ahead of this Mac’s clock; a value its setting refuses)". */
export function rejectedWords(r: Rejected): string | null {
  const n = r.time + r.value + r.key
  if (!n) return null
  const why = [r.time && 'a time before 2020 or more than five minutes ahead of this Mac’s clock', r.value && 'a value its setting refuses', r.key && 'a setting this version does not let travel'].filter(Boolean).join('; ')
  return `${n} entr${n === 1 ? 'y' : 'ies'} not read (${why}).`
}

/** The text of a Mac's file: keys sorted, so the same content is the same bytes. */
export function serialiseMacFile(file: MacFile): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (isBag(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]))
    return value
  }
  return `${JSON.stringify(sorted(file), null, 2)}\n`
}

// ── The merge (F3, F4) ─────────────────────────────────────────────────────────────────────────

/** Target ids: a setting, a shortcut, a per-vault field. One flat space for the merge. */
export const settingTarget = (key: string): string => `s:${key}`
export const shortcutTarget = (commandId: string): string => `k:${commandId}`
export const vaultTarget = (vaultId: string, field: VaultField): string => `v:${vaultId}:${field}`

/** A file's entries in the flat space. */
export function targetsOf(file: Pick<MacFile, 'settings' | 'shortcuts' | 'vaults'>): Map<string, Stamped<SettingValue>> {
  const out = new Map<string, Stamped<SettingValue>>()
  for (const [k, e] of Object.entries(file.settings)) out.set(settingTarget(k), e)
  for (const [k, e] of Object.entries(file.shortcuts)) out.set(shortcutTarget(k), e)
  for (const [id, fields] of Object.entries(file.vaults)) for (const f of VAULT_FIELDS) { const e = fields[f]; if (e) out.set(vaultTarget(id, f), e) }
  return out
}

export type Winner = Stamped<SettingValue> & { from: string | null }

/**
 * Per target, the value with the newest change time. `own` is this Mac's (from: null). A tie goes to
 * this Mac; between two other Macs, to the larger Mac id, so every Mac picks the same winner.
 * `ties`: targets where this Mac kept its own value against a different value with the same time.
 */
export function newestWins(own: ReadonlyMap<string, Stamped<SettingValue>>, remotes: ReadonlyArray<{ macId: string; entries: ReadonlyMap<string, Stamped<SettingValue>> }>): { winners: Map<string, Winner>; ties: Array<{ target: string; macId: string }> } {
  const winners = new Map<string, Winner>()
  for (const [t, e] of own) winners.set(t, { ...e, from: null })
  const ties: Array<{ target: string; macId: string }> = []
  for (const r of remotes) {
    for (const [t, e] of r.entries) {
      const best = winners.get(t)
      if (!best || e.at > best.at || (e.at === best.at && best.from !== null && r.macId > best.from)) {
        winners.set(t, { ...e, from: r.macId })
      } else if (e.at === best.at && best.from === null && !Object.is(e.value, best.value)) {
        ties.push({ target: t, macId: r.macId })
      }
    }
  }
  return { winners, ties }
}

/**
 * The change time of a value this Mac now holds in place of `previous` (F4): when the change was made
 * (the change log's time, else now), but always later than the value it replaced.
 */
export function localStamp(changedAt: number, previous: Stamped<SettingValue> | undefined): number {
  const at = Number.isFinite(changedAt) ? Math.floor(changedAt) : EARLIEST_AT
  return previous ? Math.max(at, previous.at + 1) : Math.max(at, EARLIEST_AT)
}

/** "about 3 hours", "about 2 days". */
export function aboutDuration(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 90) return `about ${min} minute${min === 1 ? '' : 's'}`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 24) return `about ${hours} hours`
  const days = Math.round(ms / 86_400_000)
  return `about ${days} day${days === 1 ? '' : 's'}`
}

// ── What the window and `setup status` show ─────────────────────────────────────────────────────

export type SetupFolderMac = { macId: string; name: string; appVersion: string; lastActive: number; thisMac: boolean }
export type SetupFolderSkip = { file: string; path: string; reason: SkipReason; words: string }
export type SetupFolderChangeRow = { label: string; from: string; to: string }
export type SetupFolderBatch = { id: string; macName: string; at: number; rows: SetupFolderChangeRow[]; undone: boolean; undoable: boolean; /** Stopped part-way and not yet put back (Undo tries again). */ unfinished?: boolean }
/** An address (SuggestionKind) or where publishing goes (AskFirstKey) set on another Mac, offered here. */
export type OfferKind = SuggestionKind | AskFirstKey
export const OFFER_KINDS: readonly OfferKind[] = [...SUGGESTIONS, ...ASK_FIRST]
export type SetupFolderSuggestion = { kind: OfferKind; label: string; value: string; macName: string; canUse: boolean; why: string | null }
export type SetupFolderNotice = { kind: 'clock' | 'tie' | 'foreign' | 'vault-unmatched' | 'not-applied' | 'held' | 'rejected' | 'copied' | 'interrupted' | 'read-only' | 'not-restored'; text: string }

export type SetupFolderStatus = {
  /** The folder chosen ('' = none) and the set-up folder the files are in. */
  chosen: string
  folder: string
  state: 'off' | 'joining' | 'joined' | 'unavailable'
  /** Why the folder cannot be used now (state unavailable). */
  problem: string | null
  /** This Mac's name and its file's name. */
  thisMac: { name: string; file: string }
  macs: SetupFolderMac[]
  lastRead: number | null
  skipped: SetupFolderSkip[]
  /** First join: what applying would change on this Mac. */
  preview: { token: string; rows: SetupFolderChangeRow[]; fromMacs: string[] } | null
  history: SetupFolderBatch[]
  suggestions: SetupFolderSuggestion[]
  notices: SetupFolderNotice[]
  /** This Mac's file is in a folder it no longer uses (Remove this Mac's file is offered). */
  leftFile: { folder: string; file: string } | null
}

export const SETUP_FOLDER_TEXT = {
  title: 'Set-up folder',
  intro: 'Keep your preferences, shortcuts and Cloudflare site the same on your Macs. Choose a folder that syncs between them (iCloud Drive, Dropbox, OneDrive, Syncthing, a Git repository); each Mac keeps its own file there.',
  never: 'Never in the folder: keys and tokens, folder paths, microphone and camera, and the programs and addresses set on each Mac.',
  holds: 'What this Mac’s file there holds: this Mac’s name, the ids of your vaults with their author and badge, your preferences and shortcuts, and the Cloudflare account, site and branch. Anyone who can read the folder can read that: a folder inside a public Git repository publishes it.',
  downloads: 'A file your sync service has not downloaded to this Mac is not read, and TalkWeaver does not download it. Where the service does not mark such a file, reading it may make the service download it.',
  reset: 'Reset all settings also stops this Mac using the set-up folder; the files in it are left as they are.',
  askFirst: 'Where publishing goes (the Cloudflare account, site and branch) changes on this Mac only when you choose Use on this Mac.',
  choose: 'Choose folder…',
  change: 'Change…',
  stop: 'Stop using this folder',
  readNow: 'Read now',
  apply: 'Apply',
  notNow: 'Not now',
  review: 'Review and apply…',
  undo: 'Undo',
  remove: 'Remove this Mac’s file',
  showInFinder: 'Show in Finder',
  joinHeading: (macs: string[]): string => `${macs.join(' and ')} already ${macs.length === 1 ? 'keeps its' : 'keep their'} set-up here. Applying changes this Mac:`,
  joinNothing: 'Nothing on this Mac changes.',
  notApplied: 'Not applied yet: nothing is read into this Mac or written to the folder until you apply.',
  recentHeading: 'Changes from your other Macs',
  recentNone: 'No changes have come from another Mac yet.',
  undoNote: 'Undo puts this Mac’s earlier values back, and your other Macs take them from here.',
  macsHeading: 'Macs using this folder',
  skippedHeading: 'Files not read',
  suggestionsHeading: 'Set on another Mac, to confirm here',
  useHere: 'Use on this Mac',
  off: 'No folder chosen. Each Mac keeps its own set-up.',
  thisMac: 'this Mac'
} as const

/** "From MacBook Air (set-up folder)": the file name an import batch is logged under (the Changes page shows it). */
export const batchFileLabel = (macName: string): string => `${macName} (set-up folder)`
