// tour-summary.md and contact-sheet.html, built from tour-report.json (used by e2e/diagnose-surface-tour.mjs).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATUSES = ['opened', 'skipped', 'could-not-open', 'precondition-missing']
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const count = (list, key) => list.reduce((m, e) => { const k = key(e); m[k] = m[k] ?? { total: 0 }; m[k].total += 1; m[k][e.status] = (m[k][e.status] ?? 0) + 1; return m }, {})

export function writeSummary(out, surfaces, report) {
  const entries = report.entries
  const byId = new Map(surfaces.map((s) => [s.id, s]))
  const status = (e) => e.status
  const total = entries.length
  const tally = STATUSES.map((s) => [s, entries.filter((e) => status(e) === s).length])
  const nonSkipped = total - (tally.find(([s]) => s === 'skipped')?.[1] ?? 0)
  const opened = tally.find(([s]) => s === 'opened')?.[1] ?? 0
  const lines = []
  lines.push('---', 'title: "TalkWeaver surface tour: summary"', `date: ${String(report.generated).slice(0, 10)}`, 'phase: screenshot-tour', '---', '')
  lines.push('# Surface tour summary', '')
  lines.push(`Generated ${report.generated} from \`tour-report.json\`. App version reported by the running app: ${report.app_version ?? 'unknown'}. Window ${report.window}, light theme (dark pass: the window surfaces only).`, '')
  lines.push('A surface counts as **opened** only when something new was on screen after the action (a new window, dialog, menu or panel text), or the recipe\'s own check passed. A failed attempt keeps its screenshot as evidence, marked in the report, and is **could-not-open**.', '')
  lines.push('## Counts', '', '| Status | Surfaces |', '|---|---|')
  for (const [s, n] of tally) lines.push(`| ${s} | ${n} |`)
  lines.push(`| total | ${total} |`, '')
  lines.push(`Opened ${opened} of ${nonSkipped} non-skipped surfaces (${nonSkipped ? Math.round((opened / nonSkipped) * 100) : 0}%).`, '')

  const table = (title, groups) => {
    lines.push(`## ${title}`, '', '| Name | Total | Opened | Skipped | Could not open | Precondition missing |', '|---|---|---|---|---|---|')
    for (const [name, c] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${name} | ${c.total} | ${c.opened ?? 0} | ${c.skipped ?? 0} | ${c['could-not-open'] ?? 0} | ${c['precondition-missing'] ?? 0} |`)
    }
    lines.push('')
  }
  table('By feature', count(entries, (e) => e.feature))
  table('By surface type', count(entries, (e) => e.surface_type))

  const group = (title, rows, withReason = true) => {
    lines.push(`## ${title} (${rows.length})`, '')
    if (!rows.length) { lines.push('None.', ''); return }
    lines.push('| Id | Type | Feature | Method tried | Reason |', '|---|---|---|---|---|')
    for (const e of rows) lines.push(`| ${e.id} | ${e.surface_type} | ${e.feature} | ${(e.method ?? '').replace(/\|/g, '/')} | ${String(withReason ? e.reason ?? '' : '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`)
    lines.push('')
  }
  group('Could not open', entries.filter((e) => e.status === 'could-not-open'))
  group('Precondition missing', entries.filter((e) => e.status === 'precondition-missing'))
  group('Skipped', entries.filter((e) => e.status === 'skipped'))

  lines.push('## Appeared but not in surfaces.json', '')
  const unexpected = report.unexpected ?? []
  if (!unexpected.length) lines.push('Nothing unexpected was recorded.', '')
  else {
    lines.push('| After surface | What | Text seen |', '|---|---|---|')
    for (const u of unexpected) lines.push(`| ${u.after} | ${u.kind} | ${String(u.text ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`)
    lines.push('')
  }
  if (report.extra_surfaces?.length) {
    lines.push('### Additional surfaces seen while touring', '')
    for (const x of report.extra_surfaces) lines.push(`- ${x.note} (${x.shot ? `\`${x.shot}\`` : 'no screenshot'})`)
    lines.push('')
  }
  if (report.dark?.length) {
    lines.push('## Dark-theme pass (the window surfaces)', '', '| Id | Status | Screenshot |', '|---|---|---|')
    for (const e of report.dark) lines.push(`| ${e.id} | ${e.status}${e.reason ? ` (${e.reason.slice(0, 80)})` : ''} | ${e.screenshot ?? ''} |`)
    lines.push('')
  }
  if (report.page_errors?.length) {
    lines.push('## Page errors noticed while touring', '')
    for (const e of report.page_errors) lines.push(`- ${e.replace(/\n/g, ' ')}`)
    lines.push('')
  }
  void byId
  writeFileSync(join(out, 'tour-summary.md'), lines.join('\n'))
}

export function writeContactSheet(out, surfaces, report) {
  const entries = report.entries.filter((e) => e.screenshot)
  const features = [...new Set(entries.map((e) => e.feature))].sort()
  const types = ['window', 'modal', 'docked panel', 'float', 'menu', 'inline']
  const cards = (list) => list.map((e) => `<a class="card ${e.status}" href="${esc(e.screenshot)}" target="_blank" title="${esc(e.note)}"><img loading="lazy" src="${esc(e.screenshot)}" alt="${esc(e.title)}"><span class="cap"><b>${esc(e.id)}</b> ${esc(e.title)}<br><i>${esc(e.surface_type)}</i>${e.status !== 'opened' ? ` <em>${esc(e.status)}: not the surface</em>` : ''}</span></a>`).join('\n')
  const body = features.map((f) => {
    const inF = entries.filter((e) => e.feature === f)
    const typeGroups = [...types, ...new Set(inF.map((e) => e.surface_type).filter((x) => !types.includes(x)))]
      .map((ty) => ({ ty, list: inF.filter((e) => e.surface_type === ty) })).filter((g) => g.list.length)
    return `<section><h2>${esc(f)} <small>${inF.length}</small></h2>${typeGroups.map((g) => `<h3>${esc(g.ty)}</h3><div class="grid">${cards(g.list)}</div>`).join('\n')}</section>`
  }).join('\n')
  const noShot = report.entries.filter((e) => !e.screenshot)
  const missing = noShot.length ? `<section><h2>No screenshot <small>${noShot.length}</small></h2><ul>${noShot.map((e) => `<li><b>${esc(e.id)}</b> (${esc(e.feature)}, ${esc(e.surface_type)}): ${esc(e.status)}${e.reason ? ' — ' + esc(e.reason) : ''}</li>`).join('')}</ul></section>` : ''
  const dark = (report.dark ?? []).filter((e) => e.screenshot)
  const darkSection = dark.length ? `<section><h2>Dark theme <small>${dark.length}</small></h2><div class="grid">${cards(dark)}</div></section>` : ''
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>TalkWeaver surface tour: contact sheet</title>
<style>
body{font:14px/1.4 -apple-system,system-ui,sans-serif;margin:0;padding:16px 24px;background:#f4f4f2;color:#222}
h1{margin:0 0 4px}h2{margin:28px 0 4px;border-bottom:2px solid #bbb;padding-bottom:2px}h2 small{font-weight:400;color:#777}h3{margin:14px 0 6px;color:#555;text-transform:capitalize}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.card{display:block;background:#fff;border:1px solid #ccc;border-radius:6px;overflow:hidden;color:inherit;text-decoration:none}
.card img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top left;background:#ddd}
.card .cap{display:block;padding:5px 8px;font-size:12px}.card .cap i{color:#777}.card em{color:#b00020;font-style:normal}
.card.could-not-open,.card.precondition-missing{border-color:#b00020;opacity:.75}
.card:hover{border-color:#06c;box-shadow:0 0 0 2px #06c3}
</style></head><body>
<h1>TalkWeaver surface tour</h1>
<p>${esc(report.generated)} · app ${esc(report.app_version ?? '?')} · ${esc(report.window)} · ${entries.length} thumbnails. Grouped by feature, then surface type. Click a card for the full image. Red cards are failed attempts: the picture does not show the surface.</p>
${body}${darkSection}${missing}
</body></html>`
  writeFileSync(join(out, 'contact-sheet.html'), html)
}
