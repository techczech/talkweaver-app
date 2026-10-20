import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Link2, MessageSquareText, Pencil, Presentation, Sparkles, Trash2, X } from 'lucide-react'
import { RUN_EXTRAS_LIMITS, RUN_EXTRA_SLIDE_LIMITS as SLIDE_LIMITS, runExtrasSummary, type RunExtraLink, type RunExtras } from '../../../shared/run-extras'
import { EXTRA_SLIDES_NEED_NEW_FORMAT, EXTRA_SLIDES_NOT_SHOWN, extraSlidePlacement, type RunExtraSlidesState } from '../../../shared/run-extra-slides'
import type { SessionSource } from '../../../shared/sessions-list'

type Editing =
  | { kind: 'intro'; text: string }
  /** `index` -1 is a new link. */
  | { kind: 'link'; index: number; url: string; label: string }
  /** `id` '' is a new extra slide. */
  | { kind: 'slide'; id: string; title: string; text: string; after: string }

/** The Run page's state from what main answered (its extra slides, the Run's slides, and the outline's format). */
function slidesStateOf(result: RunExtraSlidesState): RunExtraSlidesState {
  return { slides: result.slides, extraSlides: result.extraSlides, ...(result.legacyOutline ? { legacyOutline: true as const } : {}) }
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

/**
 * Extras for this run (work-files ticket 24; locked mockup S5): the Run's intro note and extra links, kept on the
 * Run and shown on its handout from the next publish. None → the Add bar; each extra a row with Edit; one at a
 * time is edited inline (Done ⌘↩, Cancel Esc, Remove). Main checks and keeps what is sent (sessions:set-extras);
 * a refusal is shown in the edit box, in words. Extra slides (ticket 25) are kept on the Run too: main reads them
 * with the Run's slides for "Place after" (sessions:extra-slides) and keeps each change on the Run (the talk's
 * outline is never written); a slide whose chosen slide is not among the Run's slides says it goes at the end.
 */
export function RunExtrasSection({ source, onSaved, busy = false }: { source: SessionSource; onSaved: () => void; busy?: boolean }): JSX.Element {
  const runKey = `${source.vaultId}|${source.talkSlug}/${source.runId}`
  // What main last answered, until the list is read again: the section shows the saved extras at once.
  const [saved, setSaved] = useState<{ key: string; extras: RunExtras | null } | null>(null)
  const [editing, setEditing] = useState<(Editing & { key: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const first = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => { setSaved(null) }, [source.extras])
  useEffect(() => { setError(null) }, [editing?.kind, editing?.key])
  useEffect(() => { first.current?.focus() }, [editing?.kind, editing?.key, editing && 'index' in editing ? editing.index : null, editing && 'id' in editing ? editing.id : null])

  // The Run's extra slides, as main read them from the Run; null while they are read, or when they cannot be.
  const [slideState, setSlideState] = useState<{ key: string; state: RunExtraSlidesState | null; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    window.tw.sessions.extraSlides({ vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId })
      .then((result) => { if (live) setSlideState(result.ok ? { key: runKey, state: slidesStateOf(result) } : { key: runKey, state: null, error: result.error }) })
      .catch(() => { if (live) setSlideState({ key: runKey, state: null, error: 'The extra slides could not be read.' }) })
    return () => { live = false }
  }, [runKey, source.vaultId, source.talkSlug, source.runId])
  const slides = slideState?.key === runKey ? slideState.state : null
  const extraSlides = slides?.extraSlides ?? []
  // A talk whose outline is in the older format takes no extra slides (ticket 25): none can be added, and any
  // the Run has are not shown.
  const legacyOutline = slides?.legacyOutline === true

  const extras: RunExtras | null = saved?.key === runKey ? saved.extras : source.extras ?? null
  const links: RunExtraLink[] = extras?.links ?? []
  const open = editing?.key === runKey ? editing : null
  const locked = busy || saving

  const keep = async (next: RunExtras | null): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.tw.sessions.setExtras({ vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId }, next)
      if (!result.ok) { setError(result.error); return }
      setSaved({ key: runKey, extras: result.extras })
      setEditing(null)
      onSaved()
    } catch { setError('That did not go through. Try again.') }
    finally { setSaving(false) }
  }
  const ref = { vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId }
  const keepSlides = async (call: () => Promise<({ ok: true } & RunExtraSlidesState) | { ok: false; error: string }>): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await call()
      if (!result.ok) { setError(result.error); return }
      setSlideState({ key: runKey, state: slidesStateOf(result) })
      setEditing(null)
    } catch { setError('That did not go through. Try again.') }
    finally { setSaving(false) }
  }
  const done = (): void => {
    if (!open) return
    if (open.kind === 'slide') {
      const slide = { title: open.title, text: open.text, after: open.after, ...(open.id ? { id: open.id } : {}) }
      void keepSlides(() => window.tw.sessions.saveExtraSlide(ref, slide))
      return
    }
    if (open.kind === 'intro') { void keep({ ...extras, intro: open.text }); return }
    const link = { url: open.url, ...(open.label.trim() ? { label: open.label } : {}) }
    const nextLinks = open.index < 0 ? [...links, link] : links.map((current, index) => (index === open.index ? link : current))
    void keep({ ...extras, links: nextLinks })
  }
  const remove = (): void => {
    if (!open) return
    if (open.kind === 'slide') {
      if (!open.id) { setEditing(null); return }
      const id = open.id
      void keepSlides(() => window.tw.sessions.removeExtraSlide(ref, id))
      return
    }
    if (open.kind === 'intro') { void keep({ ...extras, intro: '' }); return }
    if (open.index < 0) { setEditing(null); return }
    void keep({ ...extras, links: links.filter((_link, index) => index !== open.index) })
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null) }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); done() }
  }

  const editBox = (body: JSX.Element, removeLabel: string | null): JSX.Element => (
    <div className="tw-extra-edit" data-run-extra-edit={open?.kind} onKeyDown={onKey}>
      {body}
      {error && <div className="tw-extra-err" role="alert" data-run-extra-error>{error}</div>}
      <div className="tw-extra-acts">
        <button type="button" className="tw-sess-btn sm pri" data-run-extra-done disabled={locked} title="Done (⌘↩)" onClick={done}><Check aria-hidden />Done</button>
        <button type="button" className="tw-sess-btn sm" data-run-extra-cancel disabled={saving} title="Cancel (Esc)" onClick={() => setEditing(null)}><X aria-hidden />Cancel</button>
        <span className="sp" />
        {removeLabel && <button type="button" className="tw-sess-btn sm dng" data-run-extra-remove disabled={locked} onClick={remove}><Trash2 aria-hidden />{removeLabel}</button>}
      </div>
    </div>
  )

  const introEditor = open?.kind === 'intro'
    ? editBox(
      <div className="fld">
        <label htmlFor="tw-extra-intro">Intro note</label>
        <textarea id="tw-extra-intro" ref={first} rows={3} maxLength={RUN_EXTRAS_LIMITS.intro} value={open.text} placeholder="Shown at the top of this run's handout"
          onChange={(event) => setEditing({ ...open, text: event.target.value })} />
      </div>, extras?.intro ? 'Remove note' : null)
    : null
  const linkEditor = (index: number): JSX.Element | null => (open?.kind === 'link' && open.index === index
    ? editBox(
      <>
        <div className="fld">
          <label htmlFor="tw-extra-url">Link</label>
          <input id="tw-extra-url" ref={first} type="url" inputMode="url" maxLength={RUN_EXTRAS_LIMITS.url} value={open.url} placeholder="https://"
            onChange={(event) => setEditing({ ...open, url: event.target.value })} />
        </div>
        <div className="fld">
          <label htmlFor="tw-extra-label">Name on the handout <span className="opt">optional</span></label>
          <input id="tw-extra-label" type="text" maxLength={RUN_EXTRAS_LIMITS.label} value={open.label} placeholder={open.url ? hostOf(open.url) : 'Reading list'}
            onChange={(event) => setEditing({ ...open, label: event.target.value })} />
        </div>
      </>, index < 0 ? null : 'Remove link')
    : null)

  const choices = slides?.slides ?? []
  const slideEditor = (id: string): JSX.Element | null => {
    if (open?.kind !== 'slide' || open.id !== id) return null
    // A slide kept after one that is no longer among the Run's slides keeps that choice until it is changed.
    const current = extraSlides.find((slide) => slide.id === id)
    const stray = open.after && !choices.some((choice) => choice.id === open.after) ? open.after : ''
    return editBox(
      <>
        <div className="fld">
          <label htmlFor="tw-extra-slide-title">Slide title</label>
          <input id="tw-extra-slide-title" ref={first} type="text" maxLength={SLIDE_LIMITS.title} value={open.title}
            onChange={(event) => setEditing({ ...open, title: event.target.value })} />
        </div>
        <div className="fld">
          <label htmlFor="tw-extra-slide-text">Slide text</label>
          <textarea id="tw-extra-slide-text" rows={3} maxLength={SLIDE_LIMITS.text} value={open.text}
            onChange={(event) => setEditing({ ...open, text: event.target.value })} />
        </div>
        <div className="g2">
          <div className="fld">
            <label htmlFor="tw-extra-slide-after">Place after</label>
            <select id="tw-extra-slide-after" data-run-extra-after value={open.after} onChange={(event) => setEditing({ ...open, after: event.target.value })}>
              {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.title || choice.id}</option>)}
              {stray && <option value={stray}>{`${current?.afterTitle ?? stray} (not in this run’s slides)`}</option>}
              <option value="">At the end</option>
            </select>
          </div>
          <div />
        </div>
      </>, id ? 'Remove slide' : null)
  }

  return (
    <section className="tw-run-sec tw-run-extras" data-run-section="extras">
      <header><Sparkles aria-hidden /><span>Extras for this run</span><span className="meta" data-run-extras-summary>{runExtrasSummary(extras, extraSlides.length)}</span></header>
      {extras?.intro && (
        <div className="r1" data-run-extra="intro">
          <MessageSquareText aria-hidden className="ic" />
          <div className="t"><b>Intro note</b><small>{extras.intro}</small></div>
          {open?.kind === 'intro'
            ? <span className="tw-sess-pill blue"><Pencil aria-hidden />Editing</span>
            : <button type="button" className="tw-sess-btn sm" data-run-extra-edit-intro disabled={locked} onClick={() => setEditing({ key: runKey, kind: 'intro', text: extras.intro ?? '' })}><Pencil aria-hidden />Edit</button>}
        </div>
      )}
      {extras?.intro ? introEditor : null}
      {links.map((link, index) => (
        <div key={`${index}:${link.url}`}>
          <div className="r1" data-run-extra="link">
            <Link2 aria-hidden className="ic" />
            <div className="t"><b>{link.label || hostOf(link.url)}</b><small>{link.url}</small></div>
            {open?.kind === 'link' && open.index === index
              ? <span className="tw-sess-pill blue"><Pencil aria-hidden />Editing</span>
              : <button type="button" className="tw-sess-btn sm" data-run-extra-edit-link={index} disabled={locked} onClick={() => setEditing({ key: runKey, kind: 'link', index, url: link.url, label: link.label ?? '' })}><Pencil aria-hidden />Edit</button>}
          </div>
          {linkEditor(index)}
        </div>
      ))}
      {extraSlides.map((slide) => (
        <div key={slide.id}>
          <div className="r1" data-run-extra="slide" data-run-extra-slide={slide.id}>
            <div className="thumb" aria-hidden><i /><i /><i /></div>
            <div className="t"><b>{slide.title}</b><small data-run-extra-placed={slide.placed}>{extraSlidePlacement(slide)}</small></div>
            {open?.kind === 'slide' && open.id === slide.id
              ? <span className="tw-sess-pill blue"><Pencil aria-hidden />Editing</span>
              : <button type="button" className="tw-sess-btn sm" data-run-extra-edit-slide={slide.id} disabled={locked}
                onClick={() => setEditing({ key: runKey, kind: 'slide', id: slide.id, title: slide.title, text: slide.text, after: slide.after })}><Pencil aria-hidden />Edit</button>}
          </div>
          {slideEditor(slide.id)}
        </div>
      ))}
      {!extras?.intro ? introEditor : null}
      {linkEditor(-1)}
      {slideEditor('')}
      {slideState?.key === runKey && slideState.error && <div className="tw-extra-note" data-run-extra-slides-error>{slideState.error}</div>}
      {legacyOutline && <div className="tw-extra-note" data-run-extra-slides-legacy>{extraSlides.length ? EXTRA_SLIDES_NOT_SHOWN : EXTRA_SLIDES_NEED_NEW_FORMAT}</div>}
      <div className="r1 add" data-run-extras-add>
        <span className="lab">Add</span>
        <button type="button" className="tw-sess-btn sm" data-run-extra-add="intro" disabled={locked || Boolean(extras?.intro) || open !== null}
          onClick={() => setEditing({ key: runKey, kind: 'intro', text: '' })}><MessageSquareText aria-hidden />Intro note</button>
        <button type="button" className="tw-sess-btn sm" data-run-extra-add="link" disabled={locked || links.length >= RUN_EXTRAS_LIMITS.links || open !== null}
          title={links.length >= RUN_EXTRAS_LIMITS.links ? `Up to ${RUN_EXTRAS_LIMITS.links} links` : undefined}
          onClick={() => setEditing({ key: runKey, kind: 'link', index: -1, url: '', label: '' })}><Link2 aria-hidden />Link</button>
        <button type="button" className="tw-sess-btn sm" data-run-extra-add="slide" disabled={locked || !slides || legacyOutline || extraSlides.length >= SLIDE_LIMITS.slides || open !== null}
          title={legacyOutline ? EXTRA_SLIDES_NEED_NEW_FORMAT : extraSlides.length >= SLIDE_LIMITS.slides ? `Up to ${SLIDE_LIMITS.slides} extra slides` : undefined}
          onClick={() => setEditing({ key: runKey, kind: 'slide', id: '', title: '', text: '', after: choices[0]?.id ?? '' })}><Presentation aria-hidden />Slide</button>
      </div>
    </section>
  )
}
