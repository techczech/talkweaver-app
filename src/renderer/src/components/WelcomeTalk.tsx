import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CodeXml, FileInput, Folder, FolderOpen, GraduationCap, ListTree, Presentation, Square } from 'lucide-react'
import garden from '../assets/welcome-garden.svg'
import { WELCOME_COMMANDS, type StartingView } from '../../../shared/workspace-view'

interface Props {
  folder: string
  onStart: (title: string, view: StartingView) => Promise<string | null>
  onChangeFolder: () => void
  onExamples: () => Promise<string | null>
  onOpenTalks: () => void
  onImport: () => void
}

// FR1: choose a starting view and create the same kind of talk from each.
export default function WelcomeTalk({ folder, onStart, onChangeFolder, onExamples, onOpenTalks, onImport }: Props) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleField = useRef<HTMLInputElement | null>(null)
  async function runAction(action: () => Promise<string | null>, fallback: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try { setError(await action()) }
    catch { setError(fallback) }
    finally { setBusy(false) }
  }
  function start(view: StartingView): Promise<void> {
    return runAction(() => onStart(title.trim(), view), 'The talk could not be created. Try again.')
  }
  useEffect(() => window.tw.app.onRunCommand(id => {
    const startView = (Object.keys(WELCOME_COMMANDS) as StartingView[]).find(view => WELCOME_COMMANDS[view] === id)
    if (!startView) return
    if (!title.trim()) { titleField.current?.focus(); return }
    void start(startView)
  }), [title, busy, onStart])
  return (
    <div className="tw-welcome">
      <form className="tw-welcome-card" onSubmit={event => { event.preventDefault(); void start('slide') }}>
        <div className="tw-welcome-brand"><Presentation size={19} />TalkWeaver</div>
        <h1>What would you like to start with?</h1>
        <p>You can switch views at any time. They all make the same talk.</p>
        <label htmlFor="tw-welcome-title">Name of the talk</label>
        <input id="tw-welcome-title" ref={titleField} autoFocus placeholder="For example: Community garden update" value={title}
          onChange={event => setTitle(event.currentTarget.value)} required disabled={busy} />
        <div className="tw-welcome-starts">
          <button type="submit" disabled={busy}>
            <span className="tw-welcome-art" aria-hidden="true">
              <MiniSlide design="empty" />
              <ArrowRight size={18} />
              <MiniSlide design="picture" />
            </span>
            <strong><Square size={17} />Start with a slide</strong>
            <span>Type a title and a few points, as you would in PowerPoint. TalkWeaver shows designs for what you typed.</span>
          </button>
          <button type="button" disabled={busy} onClick={() => void start('outline')}>
            <span className="tw-welcome-art" aria-hidden="true">
              <span className="tw-welcome-outline-art">
                <b>Next season</b><span>• Repair the beds</span><span>• Share the tools</span><span>• Welcome growers</span>
                <b>Money</b><span>• Subs stay at £12</span>
              </span>
              <ArrowRight size={18} />
              <span className="tw-welcome-deck-art">
                <MiniSlide design="list" /><MiniSlide design="table" />
                <MiniSlide design="picture" /><MiniSlide design="list" />
              </span>
            </span>
            <strong><ListTree size={17} />Start with an outline</strong>
            <span>Type or paste an outline, then review how to turn it into slides.</span>
          </button>
        </div>
        {error && <div role="alert" className="tw-welcome-error">{error}</div>}
        <div className="tw-welcome-foot">
          <span className="tw-welcome-location" title={folder}><Folder size={14} /> <span>Saved in {folder}.</span></span>
          <button type="button" onClick={onChangeFolder} disabled={busy}>Change</button>
          <span className="tw-welcome-foot-spacer" />
          <button type="button" onClick={() => void start('markdown')} disabled={busy}><CodeXml size={14} />Write in Markdown</button>
          <button type="button" onClick={() => void runAction(onExamples, 'The example vault could not be opened. Try again.')} disabled={busy}><GraduationCap size={14} />Example talks</button>
          <button type="button" onClick={onOpenTalks} disabled={busy}><FolderOpen size={14} />Open my talks</button>
          <button type="button" onClick={onImport} disabled={busy}><FileInput size={14} />Import PowerPoint</button>
        </div>
      </form>
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
