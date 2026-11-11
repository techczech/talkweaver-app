// Settings › Get started › "Give your agents skills to use TalkWeaver" (design element 19; mockup frames 5 and 7).
// Always present. One row per agent found (or with a copy): Installed at version N, Not installed, Installed
// separately, Kept as it is, Changed. Install, Remove and Replace go through main, which writes only the skill's
// own folder and never through a link. A failed write shows here, with where the skill is and a Copy button.
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { skillWording, rowWords, cliWords } from '../../../shared/agent-skill/wording'
import { AGENT_TABLE } from '../../../shared/agent-skill/agents'
import type { AgentRow, StatusReport } from '../../../shared/agent-skill/types'
import { AGENT_SKILL_IDENTITY } from '../../../shared/agent-skill-identity'

type Look = Record<'sectionHead' | 'hint' | 'rowFolder' | 'folderLabel' | 'btn', CSSProperties>

interface Bridge {
  status(): Promise<StatusReport>
  install(ids: string[]): Promise<unknown>
  remove(ids: string[]): Promise<unknown>
  replace(ids: string[]): Promise<unknown>
}
const bridge = (): Bridge | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { tw?: { agentSkill?: Bridge } }).tw?.agentSkill)

const W = skillWording(AGENT_SKILL_IDENTITY)

export default function AgentSkillSettings({ look }: { look: Look }): React.JSX.Element | null {
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const api = bridge()
  const load = useCallback(() => { void api?.status().then(setStatus).catch(() => {}) }, [api])
  useEffect(load, [load])
  if (!api) return null
  const act = (kind: 'install' | 'remove' | 'replace', row: AgentRow): void => {
    setBusy(row.id)
    void api[kind]([row.id]).catch(() => {}).finally(() => { setBusy(null); load() })
  }
  const rows = (status?.agents ?? []).filter((r) => r.state !== 'not-found' || r.found)
  const visible = rows.filter((r) => r.state !== 'via' || r.found)
  const names = AGENT_TABLE.filter((a) => !a.via).map((a) => a.name)
  return (
    <div data-agent-skill-card>
      <div style={look.sectionHead} data-setting="agent-skill">{W.title}</div>
      {status && status.noneFound && visible.length === 0 && (
        <>
          <div style={look.folderLabel} data-agent-skill-none>{W.noneFoundTitle}</div>
          <div style={look.hint}>{W.noneFound(names)}</div>
        </>
      )}
      {status && !status.skillAvailable && <div style={look.hint} data-agent-skill-unavailable>The skill that comes with this copy of {AGENT_SKILL_IDENTITY.appName} cannot be read, so it cannot be installed.</div>}
      {visible.map((row) => {
        const words = rowWords(row)
        // Replace may override a newer or changed copy, so it sits beside Remove when both apply.
        const actions = [
          ...(row.canInstall ? [{ label: row.state === 'installed' ? 'Update' : W.install, run: () => act('install', row), attr: 'data-agent-install' }] : []),
          ...(row.canRemove ? [{ label: 'Remove', run: () => act('remove', row), attr: 'data-agent-remove' }] : []),
          ...(row.canReplace && !row.canInstall ? [{ label: 'Replace', run: () => act('replace', row), attr: 'data-agent-replace' }] : [])
        ]
        return (
          <div style={look.rowFolder} key={row.id} data-agent-row={row.id} data-agent-state={row.state}>
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>{row.name} <span style={{ fontWeight: 400, color: 'var(--muted)' }} data-agent-status>· {words.status}</span></div>
              {words.detail && <div style={look.hint}>{words.detail}</div>}
              {row.state === 'failed' && status?.skillLocation && (
                <div style={look.hint}>
                  The skill is in <code>{status.skillLocation}</code>.{' '}
                  <button type="button" style={{ ...look.btn, padding: '1px 6px' }} data-agent-copy-location
                    onClick={() => { void navigator.clipboard?.writeText(status.skillLocation ?? '').then(() => setCopied(true)).catch(() => {}) }}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
              )}
            </div>
            {actions.length > 0 && <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>{actions.map((action) => <button key={action.attr} type="button" style={{ ...look.btn, opacity: busy === row.id ? 0.5 : 1 }} disabled={busy === row.id} {...{ [action.attr]: '' }} onClick={action.run}>{action.label}</button>)}</div>}
          </div>
        )
      })}
      {status && status.cli.state !== 'unsupported' && visible.some((r) => r.state === 'installed' || r.state === 'shared') && (
        <div style={look.hint} data-agent-cli data-agent-cli-state={status.cli.state}>{cliWords(status.cli, true)}</div>
      )}
      <div style={look.hint}>{W.refreshNote}</div>
      <details style={look.hint} data-agent-what-this-does>
        <summary style={{ cursor: 'pointer', color: 'var(--accent, var(--ink))' }}>{W.whatThisDoes}</summary>
        {W.disclosure(
          visible.filter((r) => r.folder && r.state !== 'via').map((r) => ({ name: r.name, folder: `${r.folder}/${AGENT_SKILL_IDENTITY.skillName}` })),
          AGENT_SKILL_IDENTITY.cli.command, []
        ).map((line, i) => <div key={i} style={{ marginTop: 4 }}>{line}</div>)}
      </details>
    </div>
  )
}
