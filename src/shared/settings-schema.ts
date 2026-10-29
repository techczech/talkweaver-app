// The one settings schema (shared settings, @app-patterns/settings) and the map between it and the
// userData/config.json keys the app read its preferences from before 0.40.
//
// config.json keeps what is not a preference (the vault list, window sizes, the live service's
// bookkeeping, Guide progress, the Cloudflare account the connection chose). Every preference is a
// schema setting stored in userData/settings.json; main reads them back under their old config
// names through the overlay (src/main/settings-overlay.ts), so the code that reads a preference did
// not change. Only values that differ from the default are stored, and a missing config key falls
// back to the reader's own default, so each schema default here equals that reader's default
// (scripts/test-shared-settings.mjs checks them).
//
// Pure; erasable TypeScript only (node tests import it as it is).
import { checkValue, defineSchema, type Migrated, type SettingDef } from '@app-patterns/settings'
import { METADATA_REGISTRY } from './metadata-registry.ts'
import { metadataDefaultsViewModel } from './metadata-surfaces.ts'
import { DEFAULT_IMPORTER_SETTINGS } from './importer.ts'
import { PLAIN_FONTS, PLAIN_FONT_DEFAULT, PLAIN_TEXT_SIZE_DEFAULT, PLAIN_TEXT_SIZE_MAX, PLAIN_TEXT_SIZE_MIN } from './plain-view-look.ts'
import { APP_ID } from './bridle-commands.ts'
import { ACTION_BAR_VISIBLE_DEFAULT } from './action-bar-settings.ts'
import { GUIDE_BUTTON_VISIBLE_DEFAULT, GUIDE_TEXT } from './guide.ts'
import { KEYMAP_SETTING, appKeysError } from './keymap-overrides.ts'
import { LOCAL_ONLY, LOCAL_ONLY_KEYS, folderShapeError, siteFolderShapeError } from './settings-folders.ts'

export { APP_ID, APP_NAME } from './bridle-commands.ts'

/** The settings that are keys: kept in the operating system's encrypted store, never in a file. */
export const SECRET_KEYS = { cloudflare: 'accounts.cloudflare', recording: 'accounts.recording' } as const

const TALK_DEFAULT_PREFIX = 'talkDefaults.'
const talkDefaultEntries = METADATA_REGISTRY.filter((e) => (e as { defaultable?: boolean }).defaultable)

// The same rows as the old Settings section (Presenter identity and deck defaults): built from the
// registry-derived model, so a closed vocabulary is a choice with every value and the rest typed text.
const talkDefaults: SettingDef[] = metadataDefaultsViewModel(METADATA_REGISTRY as never, {}).flatMap((group) => group.fields.map((f): SettingDef => {
  const base = { key: `${TALK_DEFAULT_PREFIX}${f.key}`, label: f.label, section: 'talk-defaults', group: `New talks start with: ${group.label}`, default: '' as const }
  const help = `${f.explanation ? `${f.explanation} ` : ''}Filled into the details of every new talk; a talk's own value always wins.`
  if (f.options && f.options.length > 0) {
    const options = [{ value: '', label: 'Not filled in' }, ...f.options.filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.label }))]
    return { ...base, type: 'choice', options, help }
  }
  return { ...base, type: 'text', help: `${help} Empty: not filled in.` }
}))

/**
 * The two rules of settings-folders.ts laid over the declared settings: a setting that names something
 * to run or somewhere to send data is never applied by import, and the separate folders are checked.
 */
function withImportRules(defs: SettingDef[]): SettingDef[] {
  return defs.map((d) => {
    let out: SettingDef = d
    if (LOCAL_ONLY_KEYS.includes(d.key)) out = { ...out, canApply: () => LOCAL_ONLY }
    if (d.key === 'presenting.backupFolder') out = { ...out, validate: folderShapeError }
    if (d.key === 'publishing.siteFolder') out = { ...out, validate: siteFolderShapeError }
    return out
  })
}

export const schema = defineSchema({
  app: APP_ID,
  sections: [
    { id: 'updates', label: 'About and updates', icon: 'info' },
    { id: 'writing', label: 'Writing', icon: 'pen-line' },
    { id: 'presenting', label: 'Presenting', icon: 'presentation' },
    { id: 'publishing', label: 'Publishing', icon: 'globe' },
    { id: 'recording', label: 'Recording', icon: 'mic' },
    { id: 'talk-defaults', label: 'New talks', icon: 'file-plus' },
    { id: 'importing', label: 'Importing slides', icon: 'file-input' }
  ],
  settings: withImportRules([
    // General
    { key: 'general.placeChip', label: 'Show where I am in the status bar', section: 'general', group: 'Help while you work', type: 'toggle', default: true, help: 'The status bar names the place the caret is in and what you can do there.' },
    { key: 'general.guideButton', label: GUIDE_TEXT.settings.switchTitle, section: 'general', group: 'Help while you work', type: 'toggle', default: GUIDE_BUTTON_VISIBLE_DEFAULT, help: GUIDE_TEXT.settings.switchSub },
    { key: 'general.imageArchive', label: 'Image archive folder', section: 'general', group: 'Images', type: 'path', default: '', help: 'Where images recovered from earlier PowerPoint files are kept. Empty: found automatically.' },
    { key: 'general.imageText', label: 'Search the text inside images', section: 'general', group: 'Images', type: 'toggle', default: true, help: 'Reads the text in vault images in the background so image search finds it.' },
    // Writing
    { key: 'writing.plainFont', label: 'Plain view font', section: 'writing', group: 'Plain view', type: 'choice', default: PLAIN_FONT_DEFAULT, options: PLAIN_FONTS.map((f) => ({ value: f.id, label: f.label })), help: 'The typeface of the Plain view of the outline.' },
    { key: 'writing.plainTextSize', label: 'Plain view text size', section: 'writing', group: 'Plain view', type: 'number', default: PLAIN_TEXT_SIZE_DEFAULT, min: PLAIN_TEXT_SIZE_MIN, max: PLAIN_TEXT_SIZE_MAX, unit: 'px', validate: (v) => (Number.isInteger(v) ? null : 'Must be a whole number'), help: 'The text size of the Plain view of the outline.' },
    { key: KEYMAP_SETTING, label: 'Keys changed inside the editor', section: 'writing', group: 'Editor', type: 'text', default: '', validate: appKeysError, help: 'Keys you changed that are not shortcuts of the menu bar: Enter, Tab and single letters inside the outline, and Undo and Redo. Each command with its key; a command with no key has had its key removed. Reset puts every one back to its default.' },
    { key: 'writing.actionBar', label: 'Show the action bar', section: 'writing', group: 'Editor', type: 'toggle', default: ACTION_BAR_VISIBLE_DEFAULT, help: 'A row of buttons above the outline for the commands you use most.' },
    // Presenting
    { key: 'presenting.warnAt', label: 'Clock turns amber', section: 'presenting', group: 'Presenter clock', type: 'number', default: 5, min: 1, max: 600, unit: 'min before the end', validate: (v) => (Number.isInteger(v) ? null : 'Must be a whole number'), help: 'A talk’s own warn-at in its details wins over this.' },
    { key: 'presenting.urgentAt', label: 'Clock turns dark amber', section: 'presenting', group: 'Presenter clock', type: 'number', default: 1, min: 1, max: 600, unit: 'min before the end', validate: (v) => (Number.isInteger(v) ? null : 'Must be a whole number'), help: 'A talk’s own urgent-at in its details wins over this.' },
    { key: 'presenting.backup', label: 'Back up presentations', section: 'presenting', group: 'Present from anywhere', type: 'toggle', default: false, help: 'Writes each talk as one presenter file to a folder you keep in OneDrive or Dropbox, so a forgotten laptop never stops a talk.' },
    { key: 'presenting.backupFolder', label: 'Backup folder', section: 'presenting', group: 'Present from anywhere', type: 'path', default: '', help: 'Put it inside a synced folder. Empty: not chosen yet.' },
    { key: 'presenting.backupEvery', label: 'Back up every', section: 'presenting', group: 'Present from anywhere', type: 'number', default: 15, min: 5, max: 1440, unit: 'min', validate: (v) => (Number.isInteger(v) ? null : 'Must be a whole number'), help: 'How often changed talks are written again.' },
    // Publishing
    { key: 'publishing.customDomain', label: 'Handout address', section: 'publishing', group: 'Handouts on the web', type: 'text', default: '', help: 'Your own domain for published handouts, for example https://handouts.example.com. Empty: the Cloudflare Pages address.' },
    { key: 'publishing.shortLinks', label: 'Short links', section: 'publishing', group: 'Handouts on the web', type: 'toggle', default: false, help: 'Links end in a short code instead of the talk’s name.' },
    { key: 'publishing.siteFolder', label: 'Site folder on this Mac', section: 'publishing', group: 'Advanced', type: 'path', default: '', help: 'Where the published site is assembled. Empty: inside the app’s own folder.' },
    { key: 'publishing.branch', label: 'Production branch', section: 'publishing', group: 'Advanced', type: 'text', default: 'main', validate: (v) => (typeof v === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(v) ? null : 'Letters, digits, . _ / - only'), help: 'The Cloudflare Pages branch that is the live site.' },
    // Recording
    { key: 'recording.discardShorter', label: 'Discard runs shorter than', section: 'recording', group: 'Runs', type: 'number', default: 20, min: 0, max: 86400, unit: 's', validate: (v) => (Number.isInteger(v) ? null : 'Must be a whole number'), help: 'A run this short is taken for an accidental open and not kept.' },
    { key: 'recording.endpoint', label: 'Storage endpoint', section: 'recording', group: 'Recording storage', type: 'text', default: '', help: 'The Cloudflare R2 endpoint recordings are uploaded to. The access keys are in Accounts and keys.' },
    { key: 'recording.bucket', label: 'Storage bucket', section: 'recording', group: 'Recording storage', type: 'text', default: '', help: 'The R2 bucket recordings are uploaded to.' },
    { key: 'recording.transcriptionPython', label: 'Transcription Python', section: 'recording', group: 'Transcription', type: 'path', default: '', help: 'The Python of the transcription environment. Empty: the one set up by the app’s instructions.' },
    { key: 'recording.transcriptionScript', label: 'Transcription script', section: 'recording', group: 'Transcription', type: 'path', default: '', help: 'Empty: the one set up by the app’s instructions.' },
    { key: 'recording.ffmpeg', label: 'ffmpeg', section: 'recording', group: 'Transcription', type: 'path', default: '', help: 'Your own ffmpeg. Empty: the one that comes with the app.' },
    // Importing
    { key: 'importing.includeHidden', label: 'Include hidden slides', section: 'importing', group: 'PowerPoint files', type: 'toggle', default: DEFAULT_IMPORTER_SETTINGS.includeHidden },
    { key: 'importing.keepNotes', label: 'Keep speaker notes', section: 'importing', group: 'PowerPoint files', type: 'toggle', default: DEFAULT_IMPORTER_SETTINGS.preserveNotes },
    { key: 'importing.extractMedia', label: 'Keep pictures and media', section: 'importing', group: 'PowerPoint files', type: 'toggle', default: DEFAULT_IMPORTER_SETTINGS.extractMedia },
    { key: 'importing.fallback', label: 'Use a picture of the slide', section: 'importing', group: 'PowerPoint files', type: 'choice', default: DEFAULT_IMPORTER_SETTINGS.fallbackPolicy, options: [{ value: 'uncertain', label: 'When unsure' }, { value: 'always', label: 'Always' }] },
    { key: 'importing.renderer', label: 'Slide pictures made by', section: 'importing', group: 'PowerPoint files', type: 'choice', default: DEFAULT_IMPORTER_SETTINGS.renderer, options: [{ value: 'automatic', label: 'Automatic' }, { value: 'libreoffice', label: 'LibreOffice' }] },
    // New talks
    ...talkDefaults,
    // Accounts and keys (values in the secrets store; the window shows connected or not)
    { key: SECRET_KEYS.cloudflare, label: 'Cloudflare token', section: 'accounts', type: 'secret', default: null, help: 'Publishes handouts and runs the live service. Kept in this Mac’s secure storage.' },
    { key: 'updates.checkForNewVersions', label: 'Check for new versions', section: 'updates', group: 'New versions', type: 'toggle', default: true, help: 'Once a day. Check for updates checks at any time.' },
    { key: SECRET_KEYS.recording, label: 'Recording storage keys', section: 'accounts', type: 'secret', default: null, help: 'The R2 access key id and secret, typed as id:secret. Kept in this Mac’s secure storage.' }
  ])
})

// ── The map to config.json ─────────────────────────────────────────────────────────────────────

/** A preference stored under one config.json key. `toConfig`/`fromConfig` convert units where they differ. */
interface ScalarMap { config: string; key: string; fromConfig?(v: unknown): unknown; toConfig?(v: unknown): unknown }

const SCALARS: readonly ScalarMap[] = [
  { config: 'updatesCheckForNewVersions', key: 'updates.checkForNewVersions' },
  { config: 'placeChipVisible', key: 'general.placeChip' },
  { config: 'guideButtonVisible', key: 'general.guideButton' },
  { config: 'archiveRoot', key: 'general.imageArchive' },
  { config: 'ocrEnabled', key: 'general.imageText' },
  { config: 'plainViewFont', key: 'writing.plainFont' },
  { config: 'plainViewTextSize', key: 'writing.plainTextSize' },
  { config: 'actionBarVisible', key: 'writing.actionBar' },
  { config: 'timerWarnAtMinutes', key: 'presenting.warnAt' },
  { config: 'timerUrgentAtMinutes', key: 'presenting.urgentAt' },
  { config: 'backupEnabled', key: 'presenting.backup' },
  { config: 'backupFolder', key: 'presenting.backupFolder' },
  { config: 'backupIntervalMin', key: 'presenting.backupEvery' },
  { config: 'publishBaseUrl', key: 'publishing.customDomain' },
  { config: 'publishUseShortIds', key: 'publishing.shortLinks' },
  { config: 'publishSiteDir', key: 'publishing.siteFolder' },
  { config: 'publishProdBranch', key: 'publishing.branch' },
  {
    config: 'recordingDiscardMs', key: 'recording.discardShorter',
    fromConfig: (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v / 1000) : v),
    toConfig: (v) => (typeof v === 'number' ? v * 1000 : v)
  },
  { config: 'recordingR2Endpoint', key: 'recording.endpoint' },
  { config: 'recordingR2Bucket', key: 'recording.bucket' },
  { config: 'transcriptionPython', key: 'recording.transcriptionPython' },
  { config: 'transcriptionScript', key: 'recording.transcriptionScript' },
  { config: 'transcriptionFfmpeg', key: 'recording.ffmpeg' }
]

/** importerSettings fields that are settings; the rest of the object (cleanupPasses) stays in config.json. */
const IMPORTER_FIELDS: Readonly<Record<string, string>> = {
  includeHidden: 'importing.includeHidden',
  preserveNotes: 'importing.keepNotes',
  extractMedia: 'importing.extractMedia',
  fallbackPolicy: 'importing.fallback',
  renderer: 'importing.renderer'
}

/** config.json keys a preference lives under (wholly or partly). */
export const MAPPED_CONFIG_KEYS: ReadonlySet<string> = new Set([...SCALARS.map((s) => s.config), 'metadataDefaults', 'importerSettings'])

type Bag = Record<string, unknown>
const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v)
const defaultOf = (key: string): unknown => schema.def(key)?.default

/** The preferences a config.json holds, as schema key → value (only the ones it holds). */
export function settingsFromConfig(config: Bag): Bag {
  const out: Bag = {}
  for (const s of SCALARS) {
    if (!Object.hasOwn(config, s.config) || config[s.config] === undefined || config[s.config] === null) continue
    out[s.key] = s.fromConfig ? s.fromConfig(config[s.config]) : config[s.config]
  }
  const md = config['metadataDefaults']
  if (isBag(md)) {
    for (const e of talkDefaultEntries) if (typeof md[e.key] === 'string' && md[e.key] !== '') out[`${TALK_DEFAULT_PREFIX}${e.key}`] = md[e.key]
  }
  const imp = config['importerSettings']
  if (isBag(imp)) for (const [field, key] of Object.entries(IMPORTER_FIELDS)) if (Object.hasOwn(imp, field)) out[key] = imp[field]
  return out
}

/**
 * The stored settings (non-defaults only) written back under their config.json names, over `base`
 * (config.json as it is on disk). A preference at its default is left out, so the reader's own
 * default applies; config.json's own copy of a preference is never used.
 */
export function configWithSettings(base: Bag, stored: Readonly<Bag>): Bag {
  const out: Bag = { ...base }
  for (const s of SCALARS) {
    delete out[s.config]
    if (Object.hasOwn(stored, s.key)) out[s.config] = s.toConfig ? s.toConfig(stored[s.key]) : stored[s.key]
  }
  const md: Record<string, string> = {}
  for (const e of talkDefaultEntries) {
    const v = stored[`${TALK_DEFAULT_PREFIX}${e.key}`]
    if (typeof v === 'string' && v !== '') md[e.key] = v
  }
  delete out['metadataDefaults']
  if (Object.keys(md).length > 0) out['metadataDefaults'] = md
  const imp: Bag = isBag(base['importerSettings']) ? { ...base['importerSettings'] } : {}
  for (const [field, key] of Object.entries(IMPORTER_FIELDS)) {
    delete imp[field]
    if (Object.hasOwn(stored, key)) imp[field] = stored[key]
  }
  delete out['importerSettings']
  if (Object.keys(imp).length > 0) out['importerSettings'] = imp
  return out
}

/**
 * A config.json write split in two: the preferences it changes (schema key → value; `undefined`
 * means back to default) and the rest, for config.json itself.
 */
export function splitConfigPatch(patch: Bag): { settings: Bag; rest: Bag } {
  const rest: Bag = {}
  const settings: Bag = {}
  for (const [k, v] of Object.entries(patch)) if (!MAPPED_CONFIG_KEYS.has(k)) rest[k] = v
  for (const s of SCALARS) {
    if (!Object.hasOwn(patch, s.config)) continue
    const v = patch[s.config]
    settings[s.key] = v === undefined || v === null ? undefined : s.fromConfig ? s.fromConfig(v) : v
  }
  if (Object.hasOwn(patch, 'metadataDefaults')) {
    const md = isBag(patch['metadataDefaults']) ? patch['metadataDefaults'] : {}
    for (const e of talkDefaultEntries) {
      const v = md[e.key]
      settings[`${TALK_DEFAULT_PREFIX}${e.key}`] = typeof v === 'string' && v !== '' ? v : undefined
    }
  }
  if (Object.hasOwn(patch, 'importerSettings')) {
    const imp = isBag(patch['importerSettings']) ? patch['importerSettings'] : {}
    for (const [field, key] of Object.entries(IMPORTER_FIELDS)) settings[key] = Object.hasOwn(imp, field) ? imp[field] : undefined
    const left: Bag = {}
    for (const [f, v] of Object.entries(imp)) if (!Object.hasOwn(IMPORTER_FIELDS, f)) left[f] = v
    rest['importerSettings'] = Object.keys(left).length > 0 ? left : undefined
  }
  return { settings, rest }
}

/** True when `value` is the schema default of `key` (a value at its default is not stored). */
export function isDefault(key: string, value: unknown): boolean {
  return Object.is(defaultOf(key), value)
}

// ── Moving the old preferences in (first launch of 0.40) ───────────────────────────────────────

/** What the app writes as settings.json for the store to migrate: the preferences it found in config.json. */
export const LEGACY_MARK = 'talkweaver-config-preferences'

/** A preference value the schema accepts (a known, non-secret key whose value passes its checks). */
export function acceptedValue(key: string, value: unknown): boolean {
  const def = schema.def(key)
  return !!def && def.type !== 'secret' && checkValue(def, value) === null
}

/**
 * The settings.json the migration hands to the store: config.json's preferences, marked. Only values
 * the schema accepts are handed over (Sol review 1, #1): one refused value (a 1 MB address, say) must
 * not make the whole hand-over too large or unreadable, so the store sets it aside and loads defaults.
 */
export function legacyFileFor(config: Bag): { format: typeof LEGACY_MARK; settings: Bag } {
  const settings: Bag = {}
  for (const [k, v] of Object.entries(settingsFromConfig(config))) if (acceptedValue(k, v)) settings[k] = v
  return { format: LEGACY_MARK, settings }
}

/**
 * The store's migrate hook: reads the file legacyFileFor() wrote. Anything else is not ours (the
 * store sets it aside as damaged). Values at their default produce no changelog entry; values the
 * schema refuses are repaired by the store's loader with an INVALID_SAVED_VALUE entry.
 */
export function migrateLegacy(old: unknown): Migrated | null {
  if (!isBag(old) || old['format'] !== LEGACY_MARK || !isBag(old['settings'])) return null
  const settings: Bag = {}
  for (const [k, v] of Object.entries(old['settings'])) if (schema.def(k) && schema.def(k)?.type !== 'secret') settings[k] = v
  return { settings }
}
