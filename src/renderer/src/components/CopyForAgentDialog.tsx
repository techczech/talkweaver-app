import { useEffect, useRef, useState } from 'react'
import { ClipboardCopy } from 'lucide-react'
import { buildHandoffPrompt, handoffAspectName, type HandoffSource } from '../../../shared/handoff-prompt'
import type { StatusReport } from '../../../shared/agent-skill/types'

export type HandoffReady = { source: HandoffSource; saved: boolean; stillCurrent: () => Promise<boolean> }
type State = 'saving' | 'ready' | 'nosave' | 'copied' | 'blocked'

export default function CopyForAgentDialog({ aspect, prepare, close }: {
  aspect: string
  prepare: () => Promise<HandoffReady>
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const promptBox = useRef<HTMLTextAreaElement>(null)
  const prepareRef = useRef(prepare)
  prepareRef.current = prepare
  const [goal, setGoal] = useState('')
  const [ready, setReady] = useState<HandoffReady | null>(null)
  const [state, setState] = useState<State>('saving')
  const [checking, setChecking] = useState(false)
  const [skill, setSkill] = useState<StatusReport | null>(null)
  const [attempt, retry] = useState(0)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  useEffect(() => {
    let active = true
    setState('saving')
    setReady(null)
    void prepareRef.current().then(result => {
      if (active) { setReady(result); setState('ready') }
    }).catch(() => { if (active) setState('nosave') })
    return () => { active = false }
  }, [attempt])
  useEffect(() => {
    let present = true
    void window.tw.agentSkill?.status().then(result => { if (present) setSkill(result) }).catch(() => {})
    return () => { present = false }
  }, [])
  const prompt = ready ? buildHandoffPrompt(aspect, ready.source, goal) : ''
  const copy = async (): Promise<void> => {
    if (!ready || !prompt || checking) return
    setChecking(true)
    try {
      if (!await ready.stillCurrent()) { setReady(null); setState('nosave'); return }
      try { await navigator.clipboard.writeText(prompt); setState('copied') }
      catch { setState('blocked'); promptBox.current?.focus(); promptBox.current?.select() }
    } catch { setReady(null); setState('nosave') }
    finally { setChecking(false) }
  }
  const noSkill = skill && !skill.agents.some(row => row.found && row.version && ['installed', 'separate', 'shared', 'changed'].includes(row.state))
  return <dialog ref={dialog} className="tw-agent-dialog" aria-labelledby="tw-agent-heading"
    onCancel={event => { event.preventDefault(); close() }}>
    <h2 id="tw-agent-heading"><ClipboardCopy size={17} />Copy for agent: {handoffAspectName(aspect)}</h2>
    <p>This copies the request below. Paste it into your own agent. Nothing runs from here and the talk does not change.</p>
    {ready?.saved && <p className="tw-right-origin" role="status">Your last typing was saved to the file a moment ago, so the agent reads what you see.</p>}
    {state === 'nosave' && <div className="tw-right-origin" role="alert">
      <span>{['sketch', 'split', 'scratch'].includes(aspect) ? 'The talk or Scratchpad file could not be verified.' : 'The talk could not be saved or has changed on disk.'} Copy is off until the file matches this window.</span>
      <button type="button" className="toolbar-btn" onClick={() => retry(count => count + 1)}>Try again</button>
    </div>}
    {noSkill && <div className="tw-right-origin"><span>No connected agent has the TalkWeaver skill.</span>
      <button type="button" className="toolbar-btn" onClick={() => { void window.tw.settingsWindow.open('get-started') }}>Install the skill</button>
    </div>}
    <input aria-label="What should be better?" placeholder="What should be better? (optional, added to the request)" value={goal}
      onChange={event => { setGoal(event.target.value); if (ready) setState('ready') }} />
    <textarea ref={promptBox} aria-label="Request for agent" value={prompt} readOnly rows={13} />
    <footer className="tw-agent-actions">
      <span role="status">{state === 'saving' ? 'Saving the talk…' : state === 'copied' ? 'Copied. Paste it into your agent.'
        : state === 'blocked' ? 'Could not copy. The text is selected: press ⌘C.' : state === 'nosave' ? 'Not saved yet, so Copy is off.'
        : ready?.source.scratch ? 'Names the Scratchpad item and its edit scope.'
        : ready?.source.slide ? 'Names the file, the slide and only this aspect.' : 'Names the file and the talk’s design settings.'}</span>
      <button type="button" className="toolbar-btn" onClick={close}>Close</button>
      <button type="button" className="toolbar-btn tw-agent-primary" disabled={!ready || checking} onClick={() => { void copy() }}>
        <ClipboardCopy size={15} />{state === 'copied' ? 'Copy again' : 'Copy'}
      </button>
    </footer>
  </dialog>
}
