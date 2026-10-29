// Entry of the shared Settings window (0.42): @app-patterns/settings-react's window over TalkWeaver's
// schema and command registry, with the app's own pages (SettingsWindowPages.tsx). State and every
// action come from main through the window's preload (src/preload/settings.ts).
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow, type CustomPage, type RowHint, type SheetState } from '@app-patterns/settings-react'
import type { SectionRequest, SettingsView } from '@app-patterns/settings-electron'
import '@app-patterns/settings-react/settings.css'
import './settings-page.css'
import { MENUS, registry } from '../../shared/bridle-commands'
import { schema } from '../../shared/settings-schema'
import { BackupsPage, CloudflarePage, GetStartedPage } from './components/SettingsWindowPages'
import AboutUpdatesSettings from './components/AboutUpdatesSettings'
import './update-notices.css'
import { useUpdateSnapshot } from './lib/updateNotices'
import { RECORDING_STORAGE_FIELD, focusSettingField } from './settings-focus'

type Bridge = import('@app-patterns/settings-electron').SettingsBridge
const bridge = (window as unknown as { bridleSettings: Bridge }).bridleSettings

const ROW_HINTS: Record<string, RowHint> = {
  'importing.fallback': { control: 'segmented' },
  'importing.renderer': { control: 'segmented' },
  'writing.plainFont': { control: 'segmented' },
  'presenting.warnAt': { example: '10' },
  'recording.discardShorter': { step: 5, example: '30' }
}

/** Where the window is open: a section, a sheet on it, or one setting whose field gets the keyboard (`focusKey`). */
type Opened = { section: string; sheet?: SheetState; focusKey?: string; n: number }

function SettingsApp(): React.JSX.Element | null {
  const update = useUpdateSnapshot()
  const [view, setView] = useState<SettingsView | null>(null)
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 })
  const [seenAt, setSeenAt] = useState(() => Date.now())

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
  const pages: CustomPage[] = [
    { id: 'updates', label: 'About and updates', icon: 'info', render: () => <>
      <AboutUpdatesSettings look={{ sectionHead: { display: 'none' }, hint: {}, rowFolder: {}, folderLabel: { fontWeight: 600 }, btn: { cursor: 'pointer' } }} record={() => {}} onShowWhatsNew={() => { void (window as unknown as { tw: { settings: { editorAction(action: string): Promise<unknown> } } }).tw.settings.editorAction('whats-new') }} />
      <button type="button" onClick={() => setOpened((o) => ({ section: 'updates', sheet: { kind: 'reset-all' }, n: o.n + 1 }))}>Reset all settings…</button>
    </> },
    { id: 'get-started', label: 'Get started', icon: 'graduation-cap', placement: 'all', render: () => <GetStartedPage /> },
    { id: 'backups', label: 'Backups', icon: 'hard-drive', render: () => <BackupsPage version={view.state.changes.length} /> },
    { id: 'cloudflare', label: 'Cloudflare', icon: 'cloud', render: () => <CloudflarePage onSetUpRecording={() => goToSetting(RECORDING_STORAGE_FIELD.section, RECORDING_STORAGE_FIELD.key)} /> }
  ]
  return (
    <SettingsWindow
      key={opened.n}
      schema={{ ...schema, settings: update?.source === 'store' ? schema.settings.filter((d) => d.key !== 'updates.checkForNewVersions') : schema.settings, sections: [...schema.sections.filter((s) => s.id !== 'about' && s.id !== 'updates'), { ...schema.section('updates')!, pinned: true }] }}
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
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
)
