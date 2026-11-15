// Section colours on the journey talk, compiled by this checkout's compiler and shown in Playwright's bundled
// Chromium: the talk with no `section-colours:` line, with `off`, and with a two-colour list, each with the two
// `{section-colour=…}` overrides (talk.mjs). Checks each section divider's lead against section-leads.mjs's rules,
// no section-colour warning, and the app's own unresolved-trigger check (Present is blocked by one); one picture
// per divider and variant.
//   node scripts/journeys/section-colours.mjs   (evidence: artefacts/journey/section-colours/)
import { writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, pause, hardLimit, runFolders, ledger, writeJson, launchChromium } from './lib.mjs'
import { makeVault, outline, SLUG, SECTION_OVERRIDES } from './talk.mjs'
import { unresolvedTriggerBlock } from '../../src/shared/layout-doctor.ts'

hardLimit(Number(process.env.TW_LIMIT_MS || 240000), 'section-colours')
const { out, state } = runFolders('section-colours')
const { record, harness } = ledger(out, 'section-colours')
const { talkDir, outlinePath } = makeVault(state)
const { prepareSource } = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/08-source-adapters.mjs')))
// Five sections in order; the second and fourth carry the overrides.
const withOverrides = (leads) => leads.map((l, i) => (i === 1 ? SECTION_OVERRIDES['on-the-path'] : i === 3 ? SECTION_OVERRIDES['tools-for-the-group'] : l))
const variants = {
  'no-line': { line: undefined, want: withOverrides(['blue', 'amber', 'light', 'deep-blue', 'light-amber']) },
  off: { line: 'off', want: withOverrides(['blue', 'blue', 'blue', 'blue', 'blue']) },
  list: { line: 'light-amber, deep-blue', want: withOverrides(['light-amber', 'deep-blue', 'light-amber', 'deep-blue', 'light-amber']) },
}
const browser = await launchChromium()
const report = {}
try {
  for (const [name, { line, want }] of Object.entries(variants)) {
    const text = outline({ sectionColours: true, line })
    writeFileSync(outlinePath, text)
    const model = await prepareSource(outlinePath, text, SLUG, statSync(outlinePath), undefined, { allowedAssetRoots: [talkDir] })
    const deck = join(talkDir, `deck-${name}.html`); writeFileSync(deck, String(model.fullHtml))
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
    try {
      await page.goto(pathToFileURL(deck).href + '?audience=1'); await page.evaluate(() => document.fonts.ready); await pause(600)
      const dividers = await page.evaluate(() => [...document.querySelectorAll('.slide')].filter((s) => s.dataset.role === 'section-title').map((s) => ({ id: s.dataset.id, lead: s.dataset.lead || null })))
      for (const d of dividers) { await page.evaluate((id) => { location.hash = id }, d.id); await pause(500); await page.screenshot({ path: join(out, `${name}-${d.id}.png`) }) }
      const block = unresolvedTriggerBlock(text)
      const warnings = (model.warnings || []).map(String).filter((w) => /section/i.test(w))
      const leads = dividers.map((d) => d.lead)
      report[name] = { line: line ?? '(none)', dividers, warnings, presentBlocked: block ? block.message : null }
      record(`sc.${name}.leads`, JSON.stringify(leads) === JSON.stringify(want), `shown ${JSON.stringify(leads)}; expected ${JSON.stringify(want)}`, `artefacts/journey/section-colours/${name}-*.png`, { leads, want })
      record(`sc.${name}.no-warning`, warnings.length === 0, warnings.join(', '), '', { warnings })
      record(`sc.${name}.present-open`, !block, block ? block.message : '', '', { block: block ? block.message : null })
    } finally { await page.close() }
  }
} catch (e) {
  harness(String(e?.stack || e).slice(0, 900))
} finally { await browser.close() }
writeJson(join(out, 'section-colours.json'), report)
