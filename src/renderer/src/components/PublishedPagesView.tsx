import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, CalendarCheck, CalendarDays, Copy, EyeOff, FileText, Globe, Link as LinkIcon, RotateCw, TriangleAlert } from 'lucide-react'
import { LIST_LOAD_ERROR, publishedPages, shownLink, type PublishedPageRow, type PublishedPagesInput } from '../../../shared/published-pages'
import { UnpublishRunConfirm } from './UnpublishRunConfirm'
import { useToolsActions } from '../lib/toolsActions'
import '../tools-rail.css'
import '../sessions-view.css'
import '../published-pages.css'

/**
 * The Published pages view (work-files ticket 22; locked mockup S8): every page that is live, from every
 * open vault, in one list: Run pages, then Talk handouts, each with its link, published date and
 * Unpublish. Rows come from src/shared/published-pages.ts over what main reads (`published:list`); a
 * Run's pre-work and post-work links are in its row's detail. Unpublish asks first: a Run goes through
 * ticket 17's path (`unpublishRunHandout`), a talk handout through `published:unpublish-talk`.
 */
export function PublishedPagesView({ onOpenRun }: { onOpenRun: (talkSlug: string, runId: string, vaultId: string) => void }): JSX.Element {
  const [input, setInput] = useState<PublishedPagesInput | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null)
  // The list did not arrive: said with Retry, never shown as an empty site (and never last time's rows as now).
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    try { setInput(await window.tw.published.list()); setLoadFailed(false) } catch { setLoadFailed(true) }
    setNow(new Date())
  }, [])
  useEffect(() => {
    void load()
    const again = (): void => { void load() }
    window.addEventListener('focus', again)
    const timer = window.setInterval(again, 60_000)
    return () => { window.removeEventListener('focus', again); window.clearInterval(timer) }
  }, [load])

  const list = useMemo(() => publishedPages(input ?? { runs: [], talks: [], site: { exists: true, folders: [] } }, now), [input, now])
  const row = selected && !loadFailed ? list.rows.find((candidate) => candidate.key === selected) ?? null : null
  const asked = confirming ? list.rows.find((candidate) => candidate.key === confirming) ?? null : null
  const loadError = loadFailed ? LIST_LOAD_ERROR : list.error
  const empty = input !== null && !loadError && list.total === 0

  // Tools command Open run (ticket 30): the detail's "Open run" button, offered while a Run's page is selected.
  useToolsActions({
    'tools-open-run': {
      enabled: row?.unpublish.kind === 'run',
      run: () => { const how = row?.unpublish; if (how?.kind === 'run') onOpenRun(how.talkSlug, how.runId, how.vaultId) }
    }
  })
  const say = (key: string, text: string): void => setNotice({ key, text })
  const copy = (key: string, url: string): void => { void navigator.clipboard?.writeText(url).catch(() => say(key, 'The link could not be copied.')) }
  const ask = (target: PublishedPageRow): void => { setSelected(target.key); setNotice(null); setConfirming(target.key) }
  const unpublish = async (target: PublishedPageRow): Promise<void> => {
    setNotice(null)
    setBusy(true)
    try {
      const how = target.unpublish
      const result = how.kind === 'run'
        // Ticket 17's path, unchanged, for the Run's own vault.
        ? await window.tw.history.unpublishRunHandout(how.talkSlug, how.runId, how.vaultId)
        : await window.tw.published.unpublishTalk(how.vaultId, how.outline)
      if (!result.success) say(target.key, result.error === 'run-not-found' ? 'That Run is no longer there.' : result.error ?? 'Unpublishing did not finish.')
    } catch { say(target.key, 'That did not go through. Try again.') }
    finally { setBusy(false); setConfirming(null); await load() }
  }

  return (
    <div className="tw-tools-view" data-tools-view="published">
      <section className="tw-tools-list" aria-label="Published pages">
        <header>
          <h2>Published pages</h2>
          {!loadError && list.total > 0 && <span className="tw-pub-n" data-published-count>{list.total}</span>}
        </header>
        {loadError ? (
          <div className="tw-tools-empty" role="alert" data-published-error>
            <TriangleAlert aria-hidden />
            <b>{loadError}</b>
            <button type="button" className="tw-sess-btn" data-published-retry onClick={() => { void load() }}><RotateCw aria-hidden />Retry</button>
          </div>
        ) : empty ? (
          <div className="tw-tools-empty" data-published-empty>
            <Globe aria-hidden />
            <b>Nothing is published</b>
          </div>
        ) : (
          <div className="tw-sess-body" data-published-list>
            {list.notice && (
              <p className="tw-pub-site-missing" role="status" data-published-notice-list>
                {list.notice} <button type="button" className="tw-sess-btn sm" data-published-retry onClick={() => { void load() }}><RotateCw aria-hidden />Retry</button>
              </p>
            )}
            {input !== null && !input.site.exists && list.total > 0 && (
              <p className="tw-pub-site-missing" role="status" data-published-site-missing>The copy of the site on this computer is missing.</p>
            )}
            {list.groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                <div className="tw-sess-group" data-published-group={group.id}>{group.label}</div>
                {group.rows.map((item) => {
                  const on = item.key === selected
                  const Icon = item.kind === 'run' ? CalendarDays : FileText
                  return (
                    <div key={item.key} className={`tw-pub-row${on ? ' on' : ''}`} data-published-row={item.key} data-published-site={item.site}>
                      <button type="button" className="tw-pub-pick" aria-current={on ? 'true' : undefined} onClick={() => { setSelected(item.key); setNotice(null) }}>
                        <span className="l1"><Icon aria-hidden /><span className="nm">{item.title}</span></span>
                        <span className="l2">{item.linkShown}</span>
                        <span className="l3">{item.published}{item.note && <span className="tw-pub-flag" title={item.note}><TriangleAlert aria-hidden />{item.site === 'unclear' ? 'Link unclear' : item.site === 'not-a-folder' ? 'Not a folder' : 'Not on this computer'}</span>}</span>
                      </button>
                      <button type="button" className="tw-sess-btn sm dng tw-pub-unpub" data-published-unpublish={item.key}
                        disabled={busy || item.unpublish.blocked !== null} title={item.unpublish.blocked ?? undefined} onClick={() => ask(item)}>
                        <EyeOff aria-hidden />Unpublish
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="tw-tools-detail" aria-label="Published pages detail">
        {row ? (
          <PageDetail row={row} notice={notice?.key === row.key ? notice.text : null} onCopy={(url) => copy(row.key, url)} onOpenRun={onOpenRun} />
        ) : (
          <div className="tw-tools-none"><Globe aria-hidden /><span>No page selected</span></div>
        )}
      </section>
      {asked && (
        <UnpublishRunConfirm title={asked.confirm.title} body={asked.confirm.body} busy={busy}
          onCancel={() => setConfirming(null)} onConfirm={() => { void unpublish(asked) }} />
      )}
    </div>
  )
}

function PageDetail({ row, notice, onCopy, onOpenRun }: { row: PublishedPageRow; notice: string | null; onCopy: (url: string) => void; onOpenRun: (talkSlug: string, runId: string, vaultId: string) => void }): JSX.Element {
  const how = row.unpublish
  return (
    <div className="tw-sess-detail" data-published-detail={row.key}>
      <div className="tw-sess-dhead">
        <div className="tw-sess-dtitle">
          <h1>{row.title}</h1>
          <div className="sub">{row.kind === 'run' ? <CalendarDays aria-hidden /> : <FileText aria-hidden />}<span>{row.sub}</span></div>
        </div>
        {how.kind === 'run'
          ? <button type="button" className="tw-sess-btn" data-published-open="run" onClick={() => onOpenRun(how.talkSlug, how.runId, how.vaultId)}><ArrowUpRight aria-hidden />Open run</button>
          : row.outlinePath
            ? <button type="button" className="tw-sess-btn" data-published-open="talk" onClick={() => { void window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath: row.outlinePath as string }) }}><ArrowUpRight aria-hidden />Open talk</button>
            : null}
      </div>
      <div className="tw-pub-cols">
        <section className="tw-run-sec tw-pub-page" data-published-page>
          <header><Globe aria-hidden /><span>Page</span></header>
          {notice && <div className="tw-run-notice" role="status" data-published-notice>{notice}</div>}
          {row.note && <div className="tw-pub-note" data-published-note={row.site}><TriangleAlert aria-hidden /><span>{row.note}</span></div>}
          {row.links.map((link) => (
            <div className="tw-pub-r1" key={link.kind} data-published-link={link.kind}>
              <LinkIcon className="soft" aria-hidden />
              <div className="t"><b>{link.label}</b><small className="mono">{shownLink(link.url)}</small></div>
              <button type="button" className="tw-sess-btn sm" title="Copy link" onClick={() => onCopy(link.url)}><Copy aria-hidden />Copy</button>
            </div>
          ))}
          <div className="tw-pub-r1" data-published-date>
            <CalendarCheck className="soft" aria-hidden />
            <div className="t"><b>Published</b><small>{row.published === 'Published' ? 'Date not recorded' : row.published.replace(/^Published /, '')}</small></div>
          </div>
        </section>
      </div>
    </div>
  )
}
