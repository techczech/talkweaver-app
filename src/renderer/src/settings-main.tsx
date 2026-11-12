import RecordingDeviceSettings from './components/RecordingDeviceSettings'
// Entry of the shared Settings window (0.42): @app-patterns/settings-react's window over TalkWeaver's
// schema and command registry, with the app's own pages (SettingsWindowPages.tsx). State and every
// action come from main through the window's preload (src/preload/settings.ts).
import PreciseWordTimingSettings from './components/PreciseWordTimingSettings'
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow, type CustomPage, type RowHint, type SheetState } from '@app-patterns/settings-react'
import type { SectionRequest, SettingsView } from '@app-patterns/settings-electron'
import '@app-patterns/settings-react/settings.css'
import './settings-page.css'
import { MENUS, registry } from '../../shared/bridle-commands'
import { schema } from '../../shared/settings-schema'
import { speechLanguageName } from '../../shared/speech-locales'
import { BackupsPage, CloudflarePage, GetStartedPage } from './components/SettingsWindowPages'
import AboutUpdatesSettings from './components/AboutUpdatesSettings'
import './update-notices.css'
import { useUpdateSnapshot } from './lib/updateNotices'
import { RECORDING_STORAGE_FIELD, focusSettingField } from './settings-focus'
import { audioInputs, microphoneSettingOptions, type AudioInput } from '../../shared/microphone-choice'

type Bridge = import('@app-patterns/settings-electron').SettingsBridge
const bridge = (window as unknown as { bridleSettings: Bridge }).bridleSettings

const ROW_HINTS: Record<string, RowHint> = {
  'importing.fallback': { control: 'segmented' },
  'importing.renderer': { control: 'segmented' },
  'writing.plainFont': { control: 'segmented' },
  'presenting.warnAt': { example: '10' },
  'recording.discardShorter': { step: 5, example: '30' },
  'recording.wordsLocale': { summary: 'Speech in another language may be missed.' }
}

/**
 * This Mac's audio inputs, kept current as devices come and go. Their names are what Settings ›
 * Recording › Microphone offers (the setting is stored as a name: the schema keeps it text, and this
 * window draws it as a menu of what is connected).
 */
function useAudioInputs(): AudioInput[] {
  const [inputs, setInputs] = useState<AudioInput[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md || typeof md.enumerateDevices !== 'function') return
    const read = (): void => { void md.enumerateDevices().then((list) => setInputs(audioInputs(list))).catch(() => {}) }
    read()
    md.addEventListener('devicechange', read)
    return () => md.removeEventListener('devicechange', read)
  }, [])
  return inputs
}

/** Where the window is open: a section, a sheet on it, or one setting whose field gets the keyboard (`focusKey`). */
type Opened = { section: string; sheet?: SheetState; focusKey?: string; n: number }

function SettingsApp(): React.JSX.Element | null {
  const update = useUpdateSnapshot()
  const [parakeetReady,setParakeetReady] = useState(false)
  useEffect(()=>{let alive=true;void window.tw.settings.transcriptionStatus().then(r=>{if(alive)setParakeetReady(r.state==='ready')}).catch(()=>{});return()=>{alive=false}},[])
  const [languages,setLanguages] = useState<Array<{value:string;label:string}>>([])
  const [speech, setSpeech] = useState('Checking language models…')
  useEffect(() => { let alive=true
    void window.tw.settings.nativeSpeechInventory().then(r=>{
      if (!alive) return
      setSpeech(!r.available ? r.error || 'Built-in words unavailable.' : `Installed: ${[...(r.installed ?? []),...(r.dictationInstalled ?? [])].join(', ') || 'none'}. Other supported languages download once on first use. Offline without a model: connect once and Retry.`)
      const installed = new Set([...(r.installed ?? []),...(r.dictationInstalled ?? [])].map(l=>l.replaceAll('_','-')))
      const supported = [...new Set([...(r.supported ?? []),...(r.dictationSupported ?? [])].map(l=>l.replaceAll('_','-')))].sort()
      setLanguages(supported.map(value=>({value,label:`${speechLanguageName(value)} · ${installed.has(value) ? 'Installed' : 'Needs download'}`})))
    }).catch(()=>{if(alive)setSpeech('Language models could not be checked. Retry by reopening Settings.')})

    return ()=>{alive=false}
  },[])

  const [view, setView] = useState<SettingsView | null>(null)
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 })
  const [seenAt, setSeenAt] = useState(() => Date.now())
  const inputs = useAudioInputs()

  useEffect(() => {
    const open = async (req: SectionRequest): Promise<void> => {
      let sheet: SheetState | undefined
      if (req.action === 'import') {
        const picked = await bridge.importPick()
        if (picked) sheet = { kind: picked.preview.refused ? 'refused' : 'import', fileName: picked.fileName, preview: picked.preview }
      }
      setOpened((o) => ({ section: req.section, ...(sheet ? { sheet } : {}), n: o.n + 1 }))
    }
    void bridge.view().then((v) => {
      setView(v)
      if (v.request) void open(v.request)
    })
    const offChanged = bridge.onChanged(setView)
    const offSection = bridge.onSection((r) => void open(r))
    return () => { offChanged(); offSection() }
  }, [])

  // A page asked for one setting (goToSetting): once its section is on screen, its field is
  // focused. The window was remounted for the section, so the row is there after this render; a
  // few frames more cover a slow first paint.
  useEffect(() => {
    const key = opened.focusKey
    if (!key) return
    let frame = 0
    let tries = 0
    const attempt = (): void => {
      if (focusSettingField(document, key) || ++tries > 10) return
      frame = requestAnimationFrame(attempt)
    }
    attempt()
    return () => cancelAnimationFrame(frame)
  }, [opened.n, opened.focusKey])
  const goToSetting = (section: string, key: string): void => setOpened((o) => ({ section, focusKey: key, n: o.n + 1 }))

  if (!view) return null
  const savedMic = view.state.settings['recording.microphone']
  const micOptions = microphoneSettingOptions(inputs, typeof savedMic === 'string' ? savedMic : '')
  const shown = (update?.source === 'store' ? schema.settings.filter((d) => d.key !== 'updates.checkForNewVersions') : schema.settings)
    .map((d) => d.key === 'recording.microphone' ? { ...d, type: 'choice' as const, options: micOptions } : d.key === 'recording.wordsLocale' ? { ...d, help: `${d.help} ${speech}`, ...(languages.length ? { options: languages } : {}) } : d.key === 'recording.wordsEngine' ? { ...d, options: d.options?.filter(o => o.value !== 'parakeet' || parakeetReady) } : d)
  const pages: CustomPage[] = [
    { id: 'updates', label: 'About and updates', icon: 'info', render: () => <>
      <AboutUpdatesSettings look={{ sectionHead: { display: 'none' }, hint: {}, rowFolder: {}, folderLabel: { fontWeight: 600 }, btn: { cursor: 'pointer' } }} record={() => {}} onShowWhatsNew={() => { void (window as unknown as { tw: { settings: { editorAction(action: string): Promise<unknown> } } }).tw.settings.editorAction('whats-new') }} />
      <button type="button" onClick={() => setOpened((o) => ({ section: 'updates', sheet: { kind: 'reset-all' }, n: o.n + 1 }))}>Reset all settings…</button>
    </> },
    { id: 'recording', label: 'Recording', icon: 'video', render: () => <div className="recording-settings-page">
      <RecordingDeviceSettings microphone={String(savedMic || '')} capture={String(view.state.settings['recording.capture'] || 'voice')} setCapture={value => { void bridge.set('recording.capture', value) }} />
      <label>Microphone <select value={String(savedMic || '')} onChange={e => { void bridge.set('recording.microphone', e.target.value) }}>{micOptions.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select></label>
      {shown.filter(d => ['recording.wordsEngine', 'recording.wordsLocale'].includes(d.key)).map(d => <p key={d.key}><label>{d.label} <select data-setting-key={d.key} value={String(view.state.settings[d.key] ?? d.default)} onChange={e => { void bridge.set(d.key, e.target.value) }}>{d.options?.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select></label><small>{d.help}</small></p>)}
      <details><summary>Advanced recording settings</summary>{shown.filter(d => d.section === 'recording' && !['recording.camera', 'recording.capture', 'recording.microphone', 'recording.wordsEngine', 'recording.wordsLocale'].includes(d.key)).map(d => <p key={d.key}><label>{d.label} <input type={d.type === 'number' ? 'number' : 'text'} value={String(view.state.settings[d.key] ?? d.default ?? '')} onChange={e => { void bridge.set(d.key, d.type === 'number' ? Number(e.target.value) : e.target.value) }} /></label></p>)}</details>
    </div> },
    { id: 'get-started', label: 'Get started', icon: 'graduation-cap', placement: 'all', render: () => <GetStartedPage /> },
    { id: 'backups', label: 'Backups', icon: 'hard-drive', render: () => <BackupsPage version={view.state.changes.length} /> },
    { id: 'cloudflare', label: 'Cloudflare', icon: 'cloud', render: () => <CloudflarePage onSetUpRecording={() => goToSetting(RECORDING_STORAGE_FIELD.section, RECORDING_STORAGE_FIELD.key)} /> }
  ]
  return (
    <>
    <SettingsWindow
      key={opened.n}
      schema={{ ...schema, settings: shown, def: (key: string) => shown.find((d) => d.key === key) ?? schema.def(key), sections: [...schema.sections.filter((s) => s.id !== 'about' && s.id !== 'updates' && s.id !== 'recording'), { ...schema.section('updates')!, pinned: true }] }}
      state={view.state}
      registry={registry}
      menus={MENUS}
      appInfo={view.appInfo}
      actions={bridge}
      slots={view.slots}
      rowHints={ROW_HINTS}
      customPages={pages}
      changesSeenAt={seenAt}
      onChangesSeen={setSeenAt}
      initial={{ section: opened.section, ...(opened.sheet ? { sheet: opened.sheet } : {}), ...(opened.focusKey ? { selKey: opened.focusKey } : {}) }}
    />
    <PreciseWordTimingSettings language={String(view.state.settings['recording.wordsLocale']??'en-US')} />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
