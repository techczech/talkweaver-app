// The compare screen (several-vaults ticket 10; LOCKED-conflict frames 2, 3 and 6): it fills the
// window. Step 1 keeps one whole version; step 2 ticks the differing slides of the other version to
// pull in. Merge writes once (main: conflict-compare.ts); Back to the talk and Cancel write nothing.
// While the screen is open it asks main every 1.5 s whether either file changed; if one did, Merge is
// disabled and "Start again" reloads both versions at step 1. Several copies: one at a time, oldest
// first (main picks); after a merge the next one loads.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, TriangleAlert } from 'lucide-react'
import type { ConflictCompareLoad, ConflictSide, VaultView } from '../../../preload/index'
import { notify } from '../lib/notify'
import {
  type CompareSlideView, differenceCounts, keepLabel, mergeLabel, savedLabel, serviceLine, sideDiff, slideLines, slidesCount, staleMessage
} from './conflictCompareModel'

type Loaded = Extract<ConflictCompareLoad, { ok: true }>
type Keep = 'mine' | 'theirs'

const CHECK_MS = 1500

/** Real slide pictures for one compared version (main compiles the text it compared, on the uncached
 *  'variant' lane), keyed by slide id; a slide without one is drawn as a card. */
function usePictures(token: string | null, side: 'mine' | 'theirs'): Record<string, string> {
  const [pics, setPics] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    setPics({})
    if (!token) return
    void window.tw.conflict.pictures(token, side).then((out) => { if (live && out) setPics(out) }).catch(() => { /* cards only */ })
    return () => { live = false }
  }, [token, side])
  return pics
}

function SlideCard({ slide, pic, number }: { slide: CompareSlideView; pic?: string; number: number }) {
  if (pic) return <img className="cc-slide cc-slide--pic" src={pic} alt={slide.title} draggable={false} />
  const { title, lines } = slideLines(slide.text)
  return (
    <div className="cc-slide" aria-label={title}>
      <div className="cc-slide-in">
        <span className="cc-slide-k">{String(number).padStart(2, '0')}</span>
        <b>{title}</b>
        {lines.map((l, i) => <span key={i} className="cc-slide-li">{l}</span>)}
      </div>
    </div>
  )
}

function VersionCard({ side, selected, onSelect, pics, data }: { side: ConflictSide; selected: boolean; onSelect: () => void; pics: Record<string, string>; data: string }) {
  return (
    <button type="button" className={`cc-ver${selected ? ' cc-ver--sel' : ''}`} onClick={onSelect} data-conflict-version={data} aria-pressed={selected}>
      <div className="cc-ver-head">
        <span className="cc-radio" />
        <div className="cc-ver-name">
          <b>{side.label}</b>
          <span>{savedLabel(side.savedAt)} · {side.where === 'this Mac' || side.where.startsWith('Git') ? side.where : 'the copy'}</span>
        </div>
        <span className="cc-ver-count">{slidesCount(side.slides.length)}</span>
      </div>
      <div className="cc-mini">
        {side.slides.map((s, i) => (
          <div key={i} className={s.differs ? 'cc-mini-d' : ''}>
            <SlideCard slide={s} pic={s.id ? pics[s.id] : undefined} number={i + 1} />
            <div className={`cc-mini-n${s.differs ? ' cc-mini-dn' : ''}`}>{i + 1}{s.differs ? (s.match === -1 ? ' only here' : ' differs') : ''}</div>
          </div>
        ))}
      </div>
    </button>
  )
}

function DiffColumn({ rows, changedClass }: { rows: ReturnType<typeof sideDiff>; changedClass: string }) {
  if (!rows.length) return <div className="cc-diff"><div className="cc-diff-same">(no lines)</div></div>
  return (
    <div className="cc-diff">
      {rows.map((r, i) => (
        <div key={i} className={r.kind === 'changed' ? changedClass : r.kind === 'gap' ? 'cc-diff-gap' : 'cc-diff-same'}>
          {r.kind === 'changed' ? (changedClass === 'cc-diff-del' ? '− ' : '+ ') : '  '}{r.text}
        </div>
      ))}
    </div>
  )
}

export default function ConflictCompare({ outlinePath, vault, onClose, onMerged }: {
  outlinePath: string
  vault: VaultView | null
  onClose: () => void
  onMerged: (outlinePath: string, text: string) => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [keep, setKeep] = useState<Keep>('mine')
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [stale, setStale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tokenRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    setLoaded(null); setError(null); setStep(1); setKeep('mine'); setTicked(new Set()); setStale(null)
    if (tokenRef.current) { void window.tw.conflict.cancel(tokenRef.current); tokenRef.current = null }
    const r = await window.tw.conflict.load(outlinePath)
    if (!r.ok) { setError(r.error); return }
    tokenRef.current = r.token
    setLoaded(r)
  }, [outlinePath])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { if (tokenRef.current) void window.tw.conflict.cancel(tokenRef.current) }, [])

  // Either file saved again while comparing: Merge off, Start again on.
  useEffect(() => {
    if (!loaded || stale) return
    const id = setInterval(() => {
      const token = tokenRef.current
      if (!token) return
      void window.tw.conflict.check(token).then((c) => { if (c.stale) setStale(staleMessage(c.label, c.at)) }).catch(() => {})
    }, CHECK_MS)
    return () => clearInterval(id)
  }, [loaded, stale])

  const cancel = useCallback(() => {
    if (busy) return
    if (tokenRef.current) { void window.tw.conflict.cancel(tokenRef.current); tokenRef.current = null }
    onClose()
  }, [busy, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancel])

  const minePics = usePictures(loaded?.token ?? null, 'mine')
  const theirsPics = usePictures(loaded?.token ?? null, 'theirs')

  const kept = loaded ? (keep === 'mine' ? loaded.mine : loaded.theirs) : null
  const other = loaded ? (keep === 'mine' ? loaded.theirs : loaded.mine) : null
  const keptPics = keep === 'mine' ? minePics : theirsPics
  const otherPics = keep === 'mine' ? theirsPics : minePics
  const pullable = other ? other.slides.map((s, i) => ({ s, i })).filter(({ s }) => s.differs) : []
  const counts = loaded ? differenceCounts(loaded.mine.slides, loaded.theirs.slides) : { differ: 0, same: 0 }

  async function merge(): Promise<void> {
    const token = tokenRef.current
    if (!token || busy || stale) return
    setBusy(true)
    let r
    try { r = await window.tw.conflict.merge(token, { keep, pull: [...ticked].sort((a, b) => a - b) }) } catch (e) { r = { ok: false as const, error: String((e as Error)?.message ?? e) } }
    setBusy(false)
    if (!r.ok) {
      if (r.stale) { setStale(r.error); return }
      notify(r.error, 'error')
      return
    }
    tokenRef.current = null
    notify(r.summary, 'success')
    onMerged(outlinePath, r.text)
    if (loaded && loaded.remaining > 1) { void load(); return }
    onClose()
  }

  const vaultBadge = vault ? <span className="cc-vb" style={{ ['--c' as string]: vault.color }}>{vault.initial}</span> : null
  const title = loaded?.title ?? ''

  return (
    <div className="cc-screen" data-conflict-compare-screen role="dialog" aria-label={`Two versions of ${title}`}>
      <header className="cc-top">
        <button type="button" className="cc-back" onClick={cancel} data-conflict-back><ArrowLeft size={14} /> Back to the talk</button>
        {vaultBadge}
        <div className="cc-top-text">
          <div className="cc-top-title">Two versions of {title || '…'}</div>
          <div className="cc-top-sub">{vault ? `${vault.name} vault · ` : ''}{loaded ? serviceLine(loaded.service) : ''}{loaded && loaded.remaining > 1 ? ` · ${loaded.remaining} copies to compare, oldest first` : ''}</div>
        </div>
        <div className="cc-steps">
          <span className={`cc-s ${step === 1 ? 'cc-s--on' : 'cc-s--done'}`}><i>{step === 1 ? '1' : <Check size={12} />}</i>Keep one version</span>
          <span className="cc-bar" />
          <span className={`cc-s ${step === 2 ? 'cc-s--on' : ''}`}><i>2</i>Pull in slides</span>
        </div>
      </header>

      {stale && (
        <div className="cc-stale" data-conflict-stale>
          <TriangleAlert size={16} />
          <span>{stale}</span>
          <button type="button" className="cc-btn cc-btn--primary" onClick={() => { void load() }} data-conflict-start-again>Start again</button>
        </div>
      )}

      <main className={`cc-main${stale ? ' cc-main--stale' : ''}`}>
        {error && <div className="cc-error" data-conflict-error>{error}</div>}
        {!loaded && !error && <div className="cc-loading">Reading both versions…</div>}
        {loaded && step === 1 && (
          <section data-conflict-step="1">
            <div className="cc-eyebrow">Step 1</div>
            <h2 className="cc-h">Which version do you keep?</h2>
            <p className="cc-p">
              Keep one whole version. In the next step you can pull in slides from the other.
              {' '}The {counts.differ === 1 ? 'slide that differs is' : `${counts.differ} slides that differ are`} outlined in amber; {counts.same === 1 ? 'the other is' : `the other ${counts.same} are`} the same in both.
            </p>
            <div className="cc-vers">
              <VersionCard side={loaded.mine} selected={keep === 'mine'} onSelect={() => { setKeep('mine'); setTicked(new Set()) }} pics={minePics} data="mine" />
              <VersionCard side={loaded.theirs} selected={keep === 'theirs'} onSelect={() => { setKeep('theirs'); setTicked(new Set()) }} pics={theirsPics} data="theirs" />
            </div>
          </section>
        )}
        {loaded && step === 2 && kept && other && (
          <section data-conflict-step="2">
            <div className="cc-eyebrow">Step 2</div>
            <div className="cc-h2row">
              <h2 className="cc-h">Slides from {other.label} to add in</h2>
              <span className="cc-keeping"><em>Keeping</em> <b>{kept.label}</b> · {savedLabel(kept.savedAt).replace(/^Today/, 'today')} · {slidesCount(kept.slides.length)}</span>
            </div>
            <p className="cc-p">
              Only the {pullable.length === 1 ? 'slide that differs is' : `${pullable.length} slides that differ are`} listed; {counts.same} {counts.same === 1 ? 'is' : 'are'} the same.
              {' '}Tick a slide to add {other.label}’s version of it after the one you keep, for you to tidy.
              {loaded.headDiffers ? ` The front matter differs too: ${kept.label}’s is kept, and ${other.label}’s stays in the version moved to the Trash.` : ''}
            </p>
            {pullable.length === 0 && <div className="cc-none">No slide differs; only the front matter or spacing does. Merge keeps {kept.label} as it is.</div>}
            <div className="cc-picks">
              {pullable.map(({ s, i }) => {
                const on = ticked.has(i)
                const counterpart = s.match >= 0 ? kept.slides[s.match] : null
                const keptKind = keep === 'mine' ? 'del' : 'add'
                const otherKind = keep === 'mine' ? 'add' : 'del'
                return (
                  <label key={i} className={`cc-pick${on ? ' cc-pick--on' : ''}`} data-conflict-pick={i}>
                    <input type="checkbox" checked={on} disabled={!!stale} onChange={() => setTicked((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })} />
                    <div className="cc-pick-body">
                      <div className="cc-pick-title">Slide {counterpart ? s.match + 1 : i + 1} · {counterpart ? counterpart.title : s.title} <span className="cc-badge">{counterpart ? 'differs' : `only in ${other.label}`}</span></div>
                      <div className="cc-pick-cols">
                        <div className="cc-pick-col">
                          <div className="cc-col-h"><em>Keeping</em> {kept.label}</div>
                          <div className="cc-pair">
                            {counterpart ? <SlideCard slide={counterpart} pic={counterpart.id ? keptPics[counterpart.id] : undefined} number={s.match + 1} /> : <div className="cc-slide cc-slide--none">Not in {kept.label}</div>}
                            <DiffColumn rows={sideDiff(s.diff, keptKind)} changedClass={keptKind === 'del' ? 'cc-diff-del' : 'cc-diff-add'} />
                          </div>
                        </div>
                        <div className="cc-pick-col">
                          <div className="cc-col-h"><em>Can pull in</em> {other.label}</div>
                          <div className="cc-pair">
                            <SlideCard slide={s} pic={s.id ? otherPics[s.id] : undefined} number={i + 1} />
                            <DiffColumn rows={sideDiff(s.diff, otherKind)} changedClass={otherKind === 'del' ? 'cc-diff-del' : 'cc-diff-add'} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </section>
        )}
      </main>

      <footer className="cc-foot">
        {step === 1 ? (
          <>
            <span className="cc-foot-note">Nothing changes until you press Merge in step 2.</span>
            <button type="button" className="cc-btn" onClick={cancel} data-conflict-cancel>Cancel</button>
            <button type="button" className="cc-btn cc-btn--primary" disabled={!loaded || !!stale} onClick={() => setStep(2)} data-conflict-keep>
              {keepLabel(keep === 'mine' ? 'Mine' : loaded?.theirs.label ?? '')}
            </button>
          </>
        ) : (
          <>
            <span className="cc-foot-note">
              Each ticked slide is added after the one you keep.<br />
              {loaded?.kind === 'git' ? 'After the merge the version with the conflict markers goes to the Trash.' : 'After the merge the conflict copy is removed.'}
            </span>
            {stale
              ? <button type="button" className="cc-btn" onClick={cancel} data-conflict-cancel>Back to the talk</button>
              : <button type="button" className="cc-btn" onClick={() => setStep(1)} data-conflict-step-back>Back</button>}
            <button type="button" className="cc-btn cc-btn--primary" disabled={busy || !!stale} onClick={() => { void merge() }} data-conflict-merge>
              {mergeLabel(ticked.size)}
            </button>
          </>
        )}
      </footer>
    </div>
  )
}
