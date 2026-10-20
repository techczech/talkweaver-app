import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight, CalendarDays, File, Files, GripVertical, ListOrdered, Lock, Presentation, TriangleAlert,
  Video, Image as ImageIcon, ListChecks, Gauge, PencilLine, MessageCircleQuestion, Plus, X, Check, ChevronDown, Info, Pencil, Send, type LucideIcon
} from 'lucide-react'
import { ROUTE_LABELS, runCountText, usedByCounts, usedLine, workFileKey, type WorkFileItem, type WorkFileStepIcon, type WorkFileStepRoute, type WorkFileStepRow, type WorkFileUsedRun } from '../../../shared/work-files-view.ts'
import {
  ADD_LABELS, POLL_TYPE_LABELS, WORK_FILE_ADD_KINDS, WORK_FILE_POLL_TYPES, WORK_FILE_PRESETS, newWorkFileText,
  type WorkFileAdd, type WorkFileAddKind,
} from '../../../shared/work-file-write.ts'
import { buildWorkFileItems } from '../../../shared/work-files-view.ts'
import { useToolsActions } from '../lib/toolsActions'
import '../work-files.css'

type Item = WorkFileItem & { absPath: string; vaultId?: string }
type Listing = { folder: string; items: Item[]; vaults?: Array<{ id: string; name: string }>; newFileVaultId?: string } | null

const STEP_ICONS: Record<WorkFileStepIcon, LucideIcon> = {
  video: Video, presentation: Presentation, 'list-checks': ListChecks, gauge: Gauge, 'pencil-line': PencilLine, 'message-circle-question': MessageCircleQuestion
}

function sentOn(iso: string | null): string {
  if (!iso) return 'sent'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'sent' : `sent ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

function Thumb({ step }: { step: WorkFileStepRow }): JSX.Element {
  if (step.thumb === 'video') {
    return <div className="tw-wf-thumb video" data-thumb="video"><Video aria-hidden />{step.minutes ? <span>{step.minutes}:00</span> : null}</div>
  }
  if (step.thumb === 'slide') {
    return <div className="tw-wf-thumb slide" data-thumb="slide"><span className="im"><ImageIcon aria-hidden /></span><span className="tx"><i /><i /><i /><i /></span></div>
  }
  const Icon = STEP_ICONS[step.icon]
  return <div className="tw-wf-thumb icon" data-thumb="icon"><Icon aria-hidden /></div>
}


/** Where a step's answer goes, as a small tag (2026-10-19 prework-responses design, mockup 01). */
function RouteTag({ route }: { route: WorkFileStepRoute }): JSX.Element {
  const Icon = route === 'local' ? Lock : Send
  return <span className={`tw-wf-route ${route}`} data-wf-route={route}><Icon aria-hidden />{ROUTE_LABELS[route]}</span>
}

const ROUTE_SAYS: Record<'sent' | 'local', { lead: string; rest: string }> = {
  sent: {
    lead: 'Travels to you like a live question,',
    rest: ' without a name unless they add one. It waits on the live service and arrives when you open the Run (or when TalkWeaver checks, every 5 minutes while the work is open).'
  },
  local: {
    lead: 'Stays on the participant\u2019s phone.',
    rest: ' You never see it, and it is not on the Run page. Use it for reflection and self-checks. A results slide cannot show this step.'
  }
}

/** The step's Edit panel: where its answer goes, as a two-way switch, and the step's own source with the token. */
function StepEdit({ step, onRoute, busy, error }: { step: WorkFileStepRow; onRoute?: (local: boolean) => void; busy: boolean; error: string | null }): JSX.Element {
  const route = step.route === 'local' ? 'local' : 'sent'
  const says = ROUTE_SAYS[route]
  return (
    <div className="tw-wf-edit" data-wf-edit={step.id ?? ''}>
      {step.route === 'counts' ? (
        <div className="tw-wf-r1 note"><span className="soft">A {step.kind === 'video' ? 'video' : 'slide'} sends only that it was {step.kind === 'video' ? 'watched' : 'read'}: a count, with nothing a participant wrote. It has no answer to send or keep.</span></div>
      ) : (
        <>
          <h4>Where this answer goes</h4>
          <div className="tw-wf-routerow">
            <div className="tw-wf-seg" role="radiogroup" aria-label="Where this answer goes">
              <button type="button" role="radio" aria-checked={route === 'sent'} className={route === 'sent' ? 'on' : ''} data-wf-route-choice="sent" disabled={busy || !onRoute}
                onClick={() => { if (route !== 'sent') onRoute?.(false) }}><Send aria-hidden />Sent to you</button>
              <button type="button" role="radio" aria-checked={route === 'local'} className={route === 'local' ? 'on l' : ''} data-wf-route-choice="local" disabled={busy || !onRoute}
                onClick={() => { if (route !== 'local') onRoute?.(true) }}><Lock aria-hidden />Local only</button>
            </div>
            <p className="why" data-wf-route-says={route}><b>{says.lead}</b>{says.rest}</p>
          </div>
        </>
      )}
      {error && <div className="tw-wf-error" role="alert" data-wf-route-error>{error}</div>}
      {step.source.length > 0 && (
        <pre className="tw-wf-src" data-wf-source>{step.source.map((line, i) => (
          <span key={i} className={i === 0 ? 'h' : /^[ \t]*\{/.test(line) ? 'tok' : 'body'}>{line}{'\n'}</span>
        ))}</pre>
      )}
      {step.route !== 'counts' && (
        <div className="tw-wf-r1 note"><Info aria-hidden /><span className="soft">Shown to participants as {route === 'local' ? '\u201cOnly on this phone\u201d' : '\u201cSent to the speaker\u201d'}. Steps are Sent to you unless the file says <span className="mono">{'{local}'}</span>.</span></div>
      )}
    </div>
  )
}

function StepRows({ steps, onRoute }: { steps: WorkFileStepRow[]; onRoute?: (stepId: string, local: boolean) => Promise<string | null> }): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const route = async (stepId: string, local: boolean): Promise<void> => {
    if (!onRoute || busy) return
    setBusy(true); setError(null)
    try { setError(await onRoute(stepId, local)) } catch { setError('The step could not be written.') }
    setBusy(false)
  }
  return (
    <>
      {steps.length === 0 && <div className="tw-wf-emptyrow">No steps yet</div>}
      {steps.map((step) => {
        const key = step.id ?? `n${step.n}`
        const open = editing === key
        return (
          <div key={step.n} className={`tw-wf-stepbox${open ? ' open' : ''}`}>
            <div className="tw-wf-r1 step" data-wf-step={step.id ?? ''}>
              <GripVertical className="soft" aria-hidden />
              <Thumb step={step} />
              <div className="t">
                <b>{step.n} · {step.title}</b>
                <small>{step.kindLabel} · <span className="mono">{step.id ? `id ${step.id}` : 'no id'}</span></small>
              </div>
              <RouteTag route={step.route} />
              {onRoute && step.id && (
                <button type="button" className="tw-wf-btn sm" data-wf-step-edit={step.id} aria-expanded={open} onClick={() => { setEditing(open ? null : key); setError(null) }}>
                  <Pencil aria-hidden /><span>Edit</span>
                </button>
              )}
            </div>
            {open && step.id && <StepEdit step={step} busy={busy} error={error} onRoute={(local) => { void route(step.id as string, local) }} />}
          </div>
        )
      })}
    </>
  )
}

const ADD_ICONS: Record<WorkFileAddKind, LucideIcon> = { video: Video, slide: Presentation, check: ListChecks, task: PencilLine, question: MessageCircleQuestion }

/** The Add row: Video, Slide, Quick check, Task, Question (which offers every poll type). Nothing is added until a button is pressed. */
function AddRow({ onAdd, disabled }: { onAdd: (add: WorkFileAdd) => void; disabled?: boolean }): JSX.Element {
  const [asking, setAsking] = useState(false)
  return (
    <div className="tw-wf-addrow" data-wf-addrow>
      <span className="lbl">Add</span>
      {WORK_FILE_ADD_KINDS.map((kind) => {
        const Icon = ADD_ICONS[kind]
        if (kind === 'question') {
          return (
            <button type="button" key={kind} className="tw-wf-btn sm" data-wf-add="question" aria-expanded={asking} disabled={disabled} onClick={() => setAsking((v) => !v)}>
              <Icon aria-hidden /><span>{ADD_LABELS[kind]}</span><ChevronDown aria-hidden />
            </button>
          )
        }
        return (
          <button type="button" key={kind} className="tw-wf-btn sm" data-wf-add={kind} disabled={disabled} onClick={() => onAdd({ kind })}>
            <Icon aria-hidden /><span>{ADD_LABELS[kind]}</span>
          </button>
        )
      })}
      {asking && (
        <div className="tw-wf-polltypes" data-wf-polltypes>
          <span className="lbl">Question type</span>
          {WORK_FILE_POLL_TYPES.map((pollType) => (
            <button type="button" key={pollType} className="tw-wf-btn sm" data-wf-add-poll={pollType} disabled={disabled}
              onClick={() => { setAsking(false); onAdd({ kind: 'question', pollType }) }}>
              <span>{POLL_TYPE_LABELS[pollType]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A new file, not yet saved: a title, an optional "start from", and the steps the author has added so far. */
/** `vault`: where it will be saved (named in the sheet when several vaults are open). */
function NewFile({ onCancel, onSaved, vault, showVault }: { onCancel: () => void; onSaved: (fileName: string, vaultId?: string) => void; vault: { id: string; name: string } | null; showVault: boolean }): JSX.Element {
  const [title, setTitle] = useState('')
  const [presetId, setPresetId] = useState('blank')
  const [adds, setAdds] = useState<WorkFileAdd[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const preview = useMemo(() => {
    const text = newWorkFileText({ id: 'untitled-work-file', title: 'Untitled work file', presetId, adds })
    return buildWorkFileItems([{ fileName: 'untitled-work-file.md', text }], [], [])[0]?.steps ?? []
  }, [presetId, adds])
  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true); setError(null)
    try {
      const result = await window.tw.workFiles.create({ title, presetId, adds, vaultId: vault?.id })
      if (result.ok) onSaved(result.fileName, vault?.id)
      else setError(result.error)
    } catch { setError('The file could not be written.') }
    setSaving(false)
  }
  return (
    <div className="tw-wf-detail" data-wf-new>
      <div className="tw-wf-dhead">
        <form className="tw-wf-titleform" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <input
            className="tw-wf-titlein" data-wf-title autoFocus placeholder="Name the work file" aria-label="Work file title"
            value={title} onChange={(e) => { setTitle(e.target.value); setError(null) }}
          />
        </form>
        <span className="sp" />
        <button type="button" className="tw-wf-btn" data-wf-cancel onClick={onCancel}><X aria-hidden /><span>Cancel</span></button>
        <button type="button" className="tw-wf-btn primary" data-wf-save disabled={!title.trim() || saving} onClick={() => { void save() }}><Check aria-hidden /><span>Save file</span></button>
      </div>
      <div className="tw-wf-cols">
        <div className="tw-wf-main">
          {error && <div className="tw-wf-error" role="alert" data-wf-error>{error}</div>}
          {vault && showVault && <div className="tw-wf-emptyrow" data-wf-new-vault>Saved in the vault {vault.name}</div>}
          <Section icon={ListOrdered} title="Steps" meta={String(preview.length)}>
            <StepRows steps={preview} />
            <AddRow onAdd={(add) => setAdds((list) => [...list, add])} />
          </Section>
          <Section icon={Files} title="Start from">
            <div className="tw-wf-presets" role="radiogroup" aria-label="Start from" data-wf-presets>
              {WORK_FILE_PRESETS.map((p) => (
                <label key={p.id} className={`tw-wf-preset${presetId === p.id ? ' on' : ''}`}>
                  <input type="radio" name="wf-preset" value={p.id} checked={presetId === p.id} data-wf-preset={p.id} onChange={() => setPresetId(p.id)} />
                  <span><b>{p.label}</b><small>{p.description}</small></span>
                </label>
              ))}
            </div>
          </Section>
        </div>
        <div className="tw-wf-side">
          <Section icon={Presentation} title="Used by" meta="0 talks · 0 runs">
            <div className="tw-wf-emptyrow">Not used yet</div>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, meta, aside, children }: { icon: LucideIcon; title: string; meta?: string; aside?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="tw-wf-sec">
      <header><Icon aria-hidden /><b>{title}</b>{meta ? <span>{meta}</span> : null}{aside ? <span className="aside">{aside}</span> : null}</header>
      <div>{children}</div>
    </section>
  )
}

function RunRow({ run, note, vaultId, onOpenRun }: { run: WorkFileUsedRun; note: string; vaultId?: string; onOpenRun: (talkSlug: string, runId: string, vaultId?: string) => void }): JSX.Element {
  return (
    <div className="tw-wf-r1" data-wf-run={`${run.talkSlug}/${run.runId}`}>
      <CalendarDays className="soft" aria-hidden />
      <div className="t"><b>{run.name}</b><small>{note}</small></div>
      <button type="button" className="tw-wf-btn sm" onClick={() => onOpenRun(run.talkSlug, run.runId, vaultId)}><ArrowUpRight aria-hidden /><span>Open run</span></button>
    </div>
  )
}

function Detail({ item, vaultName, onOpenRun, onAdd, onRoute }: { item: Item; vaultName: string | null; onOpenRun: (talkSlug: string, runId: string, vaultId?: string) => void; onAdd: (add: WorkFileAdd) => void; onRoute: (stepId: string, local: boolean) => Promise<string | null> }): JSX.Element {
  const phaseWord = (p: 'pre' | 'post'): string => (p === 'pre' ? 'Pre-work' : 'Post-work')
  const unsent = item.runs.filter((r) => r.sentAt === null)
  const sent = item.runs.filter((r) => r.sentAt !== null)
  const nothing = item.usedTalks.length === 0 && unsent.length === 0
  return (
    <div className="tw-wf-detail" data-wf-detail={item.fileName}>
      <div className="tw-wf-dhead">
        <div className="titles">
          <h1>{item.title}</h1>
          <div className="sub"><File aria-hidden /><span className="mono">{item.relPath}</span>{vaultName ? <span data-wf-vault> · {vaultName}</span> : null}</div>
        </div>
        <span className="sp" />
      </div>
      <div className="tw-wf-cols">
        <div className="tw-wf-main">
          {item.findings.length > 0 && (
            <Section icon={TriangleAlert} title="Findings" meta={String(item.findings.length)}>
              <div data-wf-findings>
                {item.findings.map((f, i) => (
                  <div className={`tw-wf-r1 finding ${f.severity}`} key={i}>
                    <TriangleAlert aria-hidden />
                    <div className="t"><b>{f.message}</b><small>{f.severity === 'blocking' ? 'Stops this file being sent' : 'Does not stop it being sent'}{f.line ? ` · line ${f.line}` : ''}</small></div>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section icon={ListOrdered} title="Steps" meta={String(item.steps.length)} aside="Where each answer goes is set per step">
            <StepRows steps={item.steps} onRoute={onRoute} />
            <AddRow onAdd={onAdd} />
          </Section>
        </div>
        <div className="tw-wf-side">
          <Section icon={Presentation} title="Used by" meta={usedByCounts(item)}>
            {nothing && <div className="tw-wf-emptyrow">Not used yet</div>}
            {item.usedTalks.map((t) => (
              <div className="tw-wf-r1" key={`${t.slug}/${t.role}`} data-wf-talk={`${t.slug}/${t.role}`}>
                <Presentation className="soft" aria-hidden />
                <div className="t"><b>{t.title}</b><small>{phaseWord(t.role)}, in its metadata</small></div>
                <button type="button" className="tw-wf-btn sm" onClick={() => { void window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath: t.outlinePath }) }}>
                  <ArrowUpRight aria-hidden /><span>Open talk</span>
                </button>
              </div>
            ))}
            {unsent.map((r) => <RunRow key={`${r.talkSlug}/${r.runId}/${r.phase}`} vaultId={item.vaultId} run={r} note={`Run · ${phaseWord(r.phase).toLowerCase()} · not sent yet`} onOpenRun={onOpenRun} />)}
          </Section>
          <div className="tw-wf-pinnote" data-wf-pin-note><Info aria-hidden /><span><b>Runs already sent keep their version.</b> Changing a step’s option reaches only Runs planned after this.</span></div>
          {sent.length > 0 && (
            <Section icon={Lock} title="Runs already sent" meta={String(sent.length)}>
              <div className="tw-wf-r1 note"><span className="soft">Each keeps the version it went out with.</span></div>
              {sent.map((r) => <RunRow key={`${r.talkSlug}/${r.runId}/${r.phase}`} vaultId={item.vaultId} run={r} note={`${phaseWord(r.phase)} · ${sentOn(r.sentAt)}`} onOpenRun={onOpenRun} />)}
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

/** The Tools window's Work files view: the list of the vault's work files, and one file open beside it. */
export function WorkFilesView({ onOpenRun, request }: { onOpenRun: (talkSlug: string, runId: string, vaultId?: string) => void; request?: { fileName: string; vaultId?: string; nonce: number } | null }): JSX.Element {
  const [listing, setListing] = useState<Listing | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // Asked to show a file (the Run page's Open file): select it, as a click on its row would.
  useEffect(() => { if (request) { setSelected(workFileKey(request.vaultId, request.fileName)); setDrafting(false) } }, [request])
  const load = useCallback((): void => {
    window.tw.workFiles.list().then(setListing).catch(() => setListing(null))
  }, [])
  useEffect(() => {
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  const addStep = (item: Item) => async (add: WorkFileAdd): Promise<void> => {
    setAddError(null)
    try {
      // Into the vault the file is in, never the first vault.
      const result = await window.tw.workFiles.addStep(item.fileName, add, item.vaultId)
      if (!result.ok) setAddError(result.error)
    } catch { setAddError('The step could not be written.') }
    load()
  }
  // Where a step's answer goes: `{local}` written or taken out through the work-file write path; the error in words, or null.
  const setRoute = (item: Item) => async (stepId: string, local: boolean): Promise<string | null> => {
    let error: string | null = null
    try {
      // Into the vault the file is in, never the first vault.
      const result = await window.tw.workFiles.setStepLocal(item.fileName, stepId, local, item.vaultId)
      if (!result.ok) error = result.error
    } catch { error = 'The step could not be written.' }
    load()
    return error
  }
  const items = listing?.items ?? []
  const keyOf = (i: Item): string => workFileKey(i.vaultId, i.fileName)
  const open = items.find((i) => keyOf(i) === selected) ?? null
  // Which vault each file is in is shown once more than one vault is open.
  const several = (listing?.vaults?.length ?? 0) > 1
  const nameOf = (id: string | undefined): string | null => (several && id ? listing?.vaults?.find((v) => v.id === id)?.name ?? null : null)
  // The new file always goes to the listing's destination vault, even when only one vault is open; the name is shown only when several are.
  const newFileVault = listing?.vaults?.find((v) => v.id === listing.newFileVaultId) ?? null
  // Tools command New work file (ticket 30): the "New file" button's own handler.
  useToolsActions({ 'tools-new-work-file': { enabled: true, run: () => { setDrafting(true); setAddError(null) } } })
  return (
    <div className="tw-tools-view" data-tools-view="workfiles">
      <section className="tw-tools-list" aria-label="Work files">
        <header>
          <h2>Work files</h2>
          <button type="button" className="tw-wf-btn primary sm" data-wf-new-file onClick={() => { setDrafting(true); setAddError(null) }}><Plus aria-hidden /><span>New file</span></button>
        </header>
        {drafting && (
          <div className="tw-wf-row sel draft" data-wf-draft-row>
            <span className="l1"><span className="nm">Untitled work file</span><span className="tw-wf-pill amber">Not saved</span></span>
            <span className="l3">Not in the list until saved</span>
          </div>
        )}
        {listing !== undefined && items.length === 0 && !drafting ? (
          <div className="tw-tools-empty">
            <Files aria-hidden />
            <b>No work files</b>
            <p>A work file holds the steps of a pre-work or a post-work.</p>
          </div>
        ) : (
          <div className="tw-wf-rows" role="list">
            {items.map((item) => (
              <button
                type="button" role="listitem" key={keyOf(item)}
                className={`tw-wf-row${keyOf(item) === selected && !drafting ? ' sel' : ''}`}
                data-wf-row={item.fileName} data-wf-vault-id={item.vaultId} aria-current={keyOf(item) === selected ? 'true' : undefined}
                onClick={() => { setSelected(keyOf(item)); setDrafting(false) }}
              >
                <span className="l1">
                  <span className="nm">{item.title}</span>
                  {item.findings.length > 0 && (
                    <span className={`tw-wf-pill ${item.blocking ? 'red' : 'amber'}`} data-wf-findings-pill>
                      {item.findings.length} finding{item.findings.length === 1 ? '' : 's'}
                    </span>
                  )}
                  <span className="when">{item.steps.length} step{item.steps.length === 1 ? '' : 's'}</span>
                </span>
                <span className="l2">{usedLine(item)}</span>
                <span className="l3"><span className="mono">{item.fileName}</span> · {runCountText(item)}{nameOf(item.vaultId) ? <span data-wf-row-vault> · {nameOf(item.vaultId)}</span> : null}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="tw-tools-detail tw-wf-detailpane" aria-label="Work files detail">
        {drafting ? (
          <NewFile
            onCancel={() => setDrafting(false)}
            vault={newFileVault}
            showVault={several}
            onSaved={(fileName, vaultId) => { setDrafting(false); setSelected(workFileKey(vaultId ?? listing?.newFileVaultId, fileName)); load() }}
          />
        ) : open ? (
          <>
            {addError && <div className="tw-wf-error" role="alert" data-wf-error>{addError}</div>}
            <Detail item={open} vaultName={nameOf(open.vaultId)} onOpenRun={onOpenRun} onAdd={(add) => { void addStep(open)(add) }} onRoute={setRoute(open)} />
          </>
        ) : (
          <div className="tw-tools-none"><Files aria-hidden /><span>No work file selected</span></div>
        )}
      </section>
    </div>
  )
}
