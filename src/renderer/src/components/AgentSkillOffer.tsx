// The agent-skill offer (design element 19; mockup frames 1-3 and 6).
//  - AgentSkillStep: the onboarding step on a first run, a dialog over the app: the agents found, each ticked,
//    "Install skill" and "Not now", a "What this does" disclosure that names the folders, then a finished state.
//  - AgentSkillMark: later, one offer per agent found after that, in the status bar beside the update marks.
// The words are the owner's (shared/agent-skill/wording.ts); main does every write and keeps links and
// unmarked folders. Nothing here is a startup failure: an offer that cannot be read shows nothing.
import { useState, type CSSProperties } from 'react'
import { skillWording, joinNames, cliWords, cliAcceptable } from '../../../shared/agent-skill/wording'
import { AGENT_SKILL_IDENTITY } from '../../../shared/agent-skill-identity'
import type { ActionReport, Offer } from '../../../shared/agent-skill/types'
import { agentSkillBridge, useAgentSkillOffer } from '../lib/agentSkillOffer'

const W = skillWording(AGENT_SKILL_IDENTITY)

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }
const dialog: CSSProperties = { width: 520, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 20px 60px rgba(0,0,0,0.35)', padding: '24px 28px', fontFamily: 'var(--font-ui)' }
const list: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, margin: '14px 0 10px', overflow: 'hidden' }
const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px', borderTop: '1px solid var(--line)' }
const btn: CSSProperties = { fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--hover)', color: 'var(--ink)', cursor: 'pointer' }
const primary: CSSProperties = { ...btn, background: 'var(--accent, #0b5fd8)', color: '#fff', border: '1px solid var(--accent, #0b5fd8)' }

function OfferList({ offer, ticked, toggle }: { offer: Offer; ticked: Set<string>; toggle: (id: string) => void }): React.JSX.Element {
  return (
    <div style={list}>
      {offer.agents.map((a, i) => (
        <label key={a.id} style={{ ...row, ...(i === 0 ? { borderTop: 'none' } : {}) }} data-agent-offer-row={a.id}>
          <input type="checkbox" checked={ticked.has(a.id)} onChange={() => toggle(a.id)} />
          <span><strong>{a.name}</strong><br /><span style={{ fontSize: 12, color: 'var(--muted)' }}>{W.foundLine}</span></span>
        </label>
      ))}
      {offer.via.map((v) => (
        <div key={v.name} style={{ ...row, background: 'var(--hover)', fontSize: 13 }}><span aria-hidden>+</span><span><strong>{v.name}</strong> {W.viaLine(v.name, v.through).slice(v.name.length + 1)}</span></div>
      ))}
    </div>
  )
}

export function AgentSkillStep(): React.JSX.Element | null {
  const [offer, setOffer] = useAgentSkillOffer()
  const [ticked, setTicked] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ActionReport | null>(null)
  const api = agentSkillBridge()
  if (!api || !offer || offer.kind !== 'first-run') return done ? finished(done, () => { setDone(null); setOffer(null) }) : null
  const on = ticked ?? new Set(offer.agents.map((a) => a.id))
  const toggle = (id: string): void => setTicked((cur) => { const n = new Set(cur ?? on); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const answer = (install: string[]): void => {
    if (busy) return
    setBusy(true)
    const all = offer.agents.map((a) => a.id)
    void api.answerOffer({ install, decline: all.filter((id) => !install.includes(id)) })
      .then((r) => { setOffer(null); const report = r as ActionReport; if (install.length && report.rows.some((x) => ['installed', 'updated', 'unchanged'].includes(x.result))) setDone(report) })
      .catch(() => setOffer(null)).finally(() => setBusy(false))
  }
  const folders = offer.agents.filter((a) => on.has(a.id) && a.folder).map((a) => ({ name: a.name, folder: `${a.folder}/${AGENT_SKILL_IDENTITY.skillName}` }))
  const disclosure = W.disclosure(folders, AGENT_SKILL_IDENTITY.cli.command, offer.via.map((v) => W.viaLine(v.name, v.through)))
  return (
    <div style={overlay} data-agent-skill-step>
      <div style={dialog} role="dialog" aria-modal="true" aria-label={W.title}
        onKeyDown={(e) => { if (e.key === 'Escape') answer([]) }}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>{W.title}</h2>
        <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.5 }}>{W.text}</p>
        <OfferList offer={offer} ticked={on} toggle={toggle} />
        <details style={{ fontSize: 13 }} data-agent-what-this-does>
          <summary style={{ cursor: 'pointer' }}>{W.whatThisDoes}</summary>
          {disclosure.map((line, i) => <p key={i} style={{ margin: '6px 0', color: 'var(--muted)' }}>{line}</p>)}
        </details>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button type="button" style={btn} disabled={busy} data-agent-not-now onClick={() => answer([])}>{W.notNow}</button>
          <button type="button" style={primary} disabled={busy || on.size === 0} data-agent-install-skill autoFocus onClick={() => answer([...on])}>{W.install}</button>
        </div>
      </div>
    </div>
  )
}

function finished(report: ActionReport, close: () => void): React.JSX.Element {
  const ok = report.rows.filter((r) => ['installed', 'updated', 'unchanged'].includes(r.result))
  const first = ok[0]?.name ?? 'your agent'
  return (
    <div style={overlay} data-agent-skill-done>
      <div style={dialog} role="dialog" aria-modal="true" aria-label={W.doneTitle}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>{W.doneTitle}</h2>
        <p style={{ margin: 0, color: 'var(--muted)' }}>{W.doneLead}</p>
        <div style={list}>{ok.map((r, i) => <div key={r.id} style={{ ...row, ...(i === 0 ? { borderTop: 'none' } : {}) }}><strong>{r.name}</strong></div>)}</div>
        {report.cli && !cliAcceptable(report.cli) && <p style={{ margin: '8px 0 0', color: 'var(--muted)' }} data-agent-cli-blocked>{cliWords(report.cli, true)}</p>}
        <p style={{ margin: '8px 0 0', fontWeight: 600 }}>{W.tryHeading}</p>
        <p style={{ margin: '4px 0', color: 'var(--muted)' }}>“{W.tryExample(first)}”</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}><button type="button" style={primary} autoFocus data-agent-done onClick={close}>{W.done}</button></div>
      </div>
    </div>
  )
}

/** The later offer: a mark in the status bar, opened to a small notice. Shown once per agent. */
/** `compact`: a narrow status bar shows a short chip ("3 agents found", the full words in its tooltip and name); `hidden`: the bar has no room for it. */
export function AgentSkillMark({ compact = false, hidden = false }: { compact?: boolean; hidden?: boolean } = {}): React.JSX.Element | null {
  const [offer, setOffer] = useAgentSkillOffer()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const api = agentSkillBridge()
  if (!api || !offer || offer.kind !== 'later' || (hidden && !open)) return null
  const names = offer.agents.map((a) => a.name)
  const ids = offer.agents.map((a) => a.id)
  const finish = (): void => { setOpen(false); setOffer(null) }
  return (
    <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      <span style={{ position: 'relative' }}>
        <button type="button" data-agent-skill-mark aria-expanded={open} title={W.laterMark(names)} aria-label={W.laterMark(names)}
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', padding: 0, whiteSpace: 'nowrap' }}
          onClick={() => { if (!open) void api.offerShown(ids); setOpen((v) => !v) }}>{compact ? `${names.length} agent${names.length === 1 ? '' : 's'} found` : W.laterMark(names)}</button>
        {open && (
          <div role="dialog" aria-label={W.laterTitle(names)} data-agent-skill-popover
            style={{ position: 'absolute', bottom: '150%', left: 0, width: 340, background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8, boxShadow: '0 8px 30px rgba(0,0,0,0.25)', padding: 14, zIndex: 1500, whiteSpace: 'normal' }}>
            <strong>{W.laterTitle(names)}</strong>
            <div style={{ margin: '4px 0 10px', color: 'var(--muted)' }}>{W.laterText(names)}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={primary} disabled={busy} data-agent-install-skill onClick={() => { setBusy(true); void api.install(ids).catch(() => {}).finally(() => { setBusy(false); finish() }) }}>{W.install}</button>
              <button type="button" style={btn} disabled={busy} data-agent-not-now onClick={() => { void api.decline(ids).catch(() => {}).finally(finish) }}>{W.notNow}</button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Agents: {joinNames(names)}. Change this any time in Settings.</div>
          </div>
        )}
      </span>
    </>
  )
}
