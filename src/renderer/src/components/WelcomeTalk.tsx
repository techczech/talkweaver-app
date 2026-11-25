import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowRight, CodeXml, FileInput, Folder, GraduationCap, ListTree, Square } from 'lucide-react'
import garden from '../assets/welcome-garden.svg'
import type { TalkInfo, VaultView } from '../../../preload/index'
import { WELCOME_COMMANDS, type StartingView } from '../../../shared/workspace-view'
import WelcomeTalkList from './WelcomeTalkList'
import '../welcome-talk.css'

interface Props {
  folder: string
  folderPath?: string
  talks?: TalkInfo[]
  vaults?: VaultView[]
  searchRef: RefObject<HTMLInputElement>
  onOpen: (talk: TalkInfo) => Promise<boolean>
  onStart: (title: string, view: StartingView) => Promise<string | null>
  onChangeFolder: () => void
  onExamples: () => Promise<string | null>
  onOpenTalks: () => void
  onImport: () => void
}

export default function WelcomeTalk({
  folder, folderPath, talks, vaults, searchRef, onOpen, onStart, onChangeFolder, onExamples, onOpenTalks, onImport
}: Props) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleField = useRef<HTMLInputElement>(null)
  // An open or create can still be waiting for the window claim when a second input arrives.
  const running = useRef(false)
  const canSearch = Boolean(talks?.length && vaults)
  async function runAction(action: () => Promise<string | null>, fallback: string): Promise<void> {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    try { setError(await action()) }
    catch { setError(fallback) }
    finally { running.current = false; setBusy(false) }
  }
  function start(view: StartingView): void {
    if (!title.trim()) { titleField.current?.focus(); return }
    void runAction(() => onStart(title.trim(), view), 'The talk could not be created. Try again.')
  }
  function open(talk: TalkInfo): void {
    void runAction(async () => { await onOpen(talk); return null }, 'The talk could not be opened. Try again.')
  }
  function examples(): void {
    void runAction(onExamples, 'The example vault could not be opened. Try again.')
  }
  useEffect(() => window.tw.app.onRunCommand(id => {
    const startView = (Object.keys(WELCOME_COMMANDS) as StartingView[]).find(view => WELCOME_COMMANDS[view] === id)
    if (startView) start(startView)
  }), [title, onStart])

  return (
    <div className={`tw-welcome${canSearch ? ' tw-welcome--split' : ' tw-welcome--first'}`}>
      {talks && vaults && canSearch && (
        <WelcomeTalkList talks={talks} vaults={vaults} searchRef={searchRef}
          busy={busy} onOpen={open} onOpenTalks={onOpenTalks} onExamples={examples}
          onUseName={name => { setTitle(name); titleField.current?.focus() }} />
      )}
      <section className="tw-welcome-new" aria-labelledby="tw-welcome-new-heading">
        <form onSubmit={event => { event.preventDefault(); start('slide') }}>
          <h2 id="tw-welcome-new-heading">Start a new talk</h2>
          <div>
            <label htmlFor="tw-welcome-title">Name of the talk</label>
            <input id="tw-welcome-title" ref={titleField} autoFocus={!canSearch}
              placeholder="For example: Community garden update" value={title}
              onChange={event => setTitle(event.currentTarget.value)} disabled={busy} />
            {error && <div role="alert" className="tw-welcome-error">{error}</div>}
          </div>
          <div className="tw-welcome-starts">
            <button type="submit" disabled={busy}>
              <span className="tw-welcome-art" aria-hidden>
                <span className="tw-welcome-before"><MiniSlide design="empty" /></span>
                <ArrowRight size={18} />
                <MiniSlide design="picture" />
              </span>
              <span className="tw-welcome-start-text">
                <strong><Square size={17} />Start with a slide</strong>
                <span>Type a title and a few points, as you would in PowerPoint. TalkWeaver shows designs for what you typed.</span>
              </span>
            </button>
            <button type="button" disabled={busy} onClick={() => start('outline')}>
              <span className="tw-welcome-art" aria-hidden>
                <span className="tw-welcome-before tw-welcome-outline-art">
                  <b>Next season</b><span>• Repair the beds</span><span>• Share the tools</span><span>• Welcome growers</span>
                  <b>Money</b><span>• Subs stay at £12</span>
                </span>
                <ArrowRight size={18} />
                <span className="tw-welcome-deck-art">
                  <MiniSlide design="list" /><MiniSlide design="table" />
                  <MiniSlide design="picture" /><MiniSlide design="list" />
                </span>
              </span>
              <span className="tw-welcome-start-text">
                <strong><ListTree size={17} />Start with an outline</strong>
                <span>Type or paste an outline, then review how to turn it into slides.</span>
              </span>
            </button>
          </div>
          <div className="tw-welcome-start-actions">
            <button className="tw-welcome-button" type="button" onClick={() => start('markdown')} disabled={busy}><CodeXml size={14} />Write in Markdown</button>
            <button className="tw-welcome-button" type="button" onClick={onImport} disabled={busy}><FileInput size={14} />Import PowerPoint…</button>
          </div>
          <div className="tw-welcome-location">
            <Folder size={14} aria-hidden /><span title={folderPath ?? folder}>{canSearch ? 'Saved in' : 'New talks are saved in'} {folder}</span>
            <button type="button" className="tw-welcome-button tw-welcome-button--small" onClick={onChangeFolder} disabled={busy}>Change folder…</button>
          </div>
          {!canSearch && <div className="tw-welcome-no-talks">
            <div><strong>No talks yet</strong><span>Talks you make or import are listed here.</span></div>
            <button type="button" className="tw-welcome-button" onClick={examples} disabled={busy}>
              <GraduationCap size={14} />Open the example talks
            </button>
          </div>}
        </form>
      </section>
    </div>
  )
}

function MiniSlide({ design }: { design: 'empty' | 'picture' | 'list' | 'table' }) {
  return (
    <span className={`tw-welcome-mini tw-welcome-mini--${design}`}>
      <b>{design === 'empty' ? 'Slide title' : design === 'picture' ? 'Three priorities' : design === 'table' ? 'Watering rota' : 'What we grew'}</b>
      {design === 'picture' ? (
        <span className="tw-welcome-slide-columns">
          <span><i>Repair the beds</i><i>Share the tools</i><i>Welcome new growers</i></span>
          <img src={garden} alt="" />
        </span>
      ) : design === 'table' ? (
        <span className="tw-welcome-mini-table" />
      ) : (
        <span className="tw-welcome-mini-points">
          {design === 'empty' ? '• First point' : <>• Tomatoes and beans<br />• Two new herb beds<br />• Extra for the food bank</>}
        </span>
      )}
    </span>
  )
}
