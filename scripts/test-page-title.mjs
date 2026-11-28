import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { registerTalkIpc } from '../src/main/talk-ipc.ts'
import { buildHandoutPages } from '../src/main/handout-pages.ts'
import { pageTitleOf } from '../src/shared/page-title.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

assert.equal(pageTitleOf({ meta: { title: 'Allotment society update' }, title: 'allotment' }, 'allotment'), 'Allotment society update')
assert.equal(pageTitleOf({ title: 'allotment' }, 'allotment'), 'allotment')
assert.equal(pageTitleOf({ meta: { title: '  ' }, title: '  A model title  ' }, 'slug'), 'A model title')

const scratch = mkdtempSync(join(tmpdir(), 'tw-page-title-'))
const compilerDir = resolve(import.meta.dirname, '../compiler/scripts')
try {
  const handlers = new Map()
  registerTalkIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    outlineRefused: () => null,
    getCompilerPath: () => compilerDir,
    pictureTextForCompile: () => undefined,
    timerSettings: () => undefined,
    ledgerSeal: async () => {},
    localHandoutWorkerBaseUrl: () => '',
    prepareTalk: async (path, text) => {
      const slug = basename(path, '-outline.md')
      return { slug, model: await prepareSource(path, text, slug, statSync(path)) }
    },
  })

  const fixtures = [
    ['allotment', 'title: "Allotment **society** update"', 'Allotment society update'],
    ['workshop', "title: 'Clay & **Glazes**'", 'Clay &amp; Glazes'],
    ['legacy', '', 'legacy'],
  ]
  for (const [slug, frontmatter, expected] of fixtures) {
    const folder = join(scratch, slug)
    mkdirSync(folder)
    const path = join(folder, slug + '-outline.md')
    const content = (frontmatter ? `---\n${frontmatter}\n---\n\n` : '') + '## Agenda\n\n### Next meeting\n\n- Find a room\n'
    writeFileSync(path, content)

    const built = await handlers.get('talk:build')(null, path, content)
    const exported = await handlers.get('talk:export-handout')(null, path, content)
    const variants = await handlers.get('talk:build-variants')(null, path, content)
    for (const result of [built, exported, variants]) assert.ok(result.success, result.error)

    const siteDir = join(folder, 'site')
    const talkOutDir = join(siteDir, slug)
    mkdirSync(talkOutDir, { recursive: true })
    await buildHandoutPages({
      kind: 'talk', compilerDir, outlinePath: path, text: content, outline: content,
      assetRoots: [folder], siteDir, talkOutDir, slug,
      url: 'https://example.test/' + slug, qr: '', live: '', downloadFile: 'download.html', handoutFile: slug + '.html',
    }, html => html)

    for (const output of [built.outPath, exported.path, ...variants.outPaths, join(talkOutDir, slug + '.html')]) {
      const html = readFileSync(output, 'utf8')
      assert.ok(html.includes(`<title>${expected}</title>`), `${output}: document title`)
      assert.ok(html.includes(`<meta name="deck-title" content="${expected}">`), `${output}: deck-title metadata`)
    }
    console.log(`${slug}: title and metadata verified in both full builds, both share variants, exported and published handouts`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
