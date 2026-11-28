// Run on the laptop with dependencies and generated compiler assets in both checkouts.
// TW_LIBRARY_ROOT=<read-only vault> node scripts/release/compare-library.mjs <baseline checkout>
// Pass --allow-table-and-mindmap to permit those two render changes.
// Pass --signatures for one before/after structural signature per changed section, followed by the counts.
// By default only the counts are printed. Both compilers receive the same source and file scope.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const libraryRoot = process.env.TW_LIBRARY_ROOT
const [, , baselineRoot, ...flags] = process.argv
const allowTableAndMindmap = flags.includes('--allow-table-and-mindmap')
const showSignatures = flags.includes('--signatures')

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function loadCheckout(root) {
  const load = (file) => import(pathToFileURL(join(root, file)).href)
  const [scan, refs, compiler, sections] = await Promise.all([
    load('src/main/talk-scan.mjs'),
    load('src/main/image-refs.ts'),
    load('compiler/scripts/lib/08-source-adapters.mjs'),
    load('compiler/scripts/lib/04-html-extraction.mjs'),
  ])
  const paths = scan.scanTalkFoldersSync(libraryRoot).map(({ dir, outlineName }) => {
    const path = join(dir, outlineName)
    return [relative(libraryRoot, path), path]
  })
  // These sheets change table paint without changing the section markup or picture key.
  const tableStyles = await Promise.all(['table.css', 'zz-scene-stats-chart-table.css'].map(async name =>
    digest(await readFile(join(root, 'compiler/assets/styles/skin', name)))))
  return {
    paths: new Map(paths),
    async compile(path, text, sourceStat) {
      const outline = refs.resolveImageRefs(text, libraryRoot, path)
      const model = await compiler.prepareSource(path, outline, null, sourceStat, undefined, {
        ...compiler.THUMBNAIL_MEDIA_OPTIONS,
        allowedAssetRoots: [libraryRoot],
      })
      const slides = sections.findSlideSections(model.fullHtml)
      if (slides.length !== model.pictureKeys.length) throw new Error('Section and picture counts differ.')
      return slides.map(({ html }, index) => {
        const opener = html.slice(0, html.indexOf('>'))
        const hasTable = /<table class="slide-table[ "]/.test(html)
        const layout = opener.includes(' data-layout="mindmap"') ? 'mindmap' : hasTable ? 'table' : 'other'
        return {
          id: opener.match(/ data-id="([^"]*)"/)?.[1],
          layout,
          markup: digest(html),
          picture: model.pictureKeys[index],
          tableStyle: hasTable ? tableStyles.join(':') : null,
          ...(showSignatures ? { html, sourceMarkdown: model.slides?.[index]?.sourceMarkdown } : {}),
        }
      })
    },
  }
}

async function compare() {
  if (!libraryRoot || !baselineRoot || flags.length !== Number(allowTableAndMindmap) + Number(showSignatures)) {
    console.error('Set TW_LIBRARY_ROOT and pass the baseline checkout [--allow-table-and-mindmap] [--signatures].')
    return 2
  }
  if (!(await stat(libraryRoot)).isDirectory()) return 2

  const [baseline, candidate] = await Promise.all([loadCheckout(baselineRoot), loadCheckout(candidateRoot)])
  const sectionSignature = showSignatures ? (await import('./section-signature.mjs')).sectionSignature : null
  const paths = new Set([...baseline.paths.keys(), ...candidate.paths.keys()])
  const counts = {
    baselineTalks: baseline.paths.size,
    candidateTalks: candidate.paths.size,
    baselineSections: 0,
    candidateSections: 0,
    changedSections: 0,
    changedTableSections: 0,
    changedMindmapSections: 0,
    changedOtherSections: 0,
    changedPictureKeys: 0,
    unmatchedTalks: 0,
    unmatchedSections: 0,
    errors: 0,
  }
  let talk = 0
  for (const key of paths) {
    talk += 1
    const beforePath = baseline.paths.get(key)
    const afterPath = candidate.paths.get(key)
    if (!beforePath || !afterPath) counts.unmatchedTalks += 1

    try {
      const path = beforePath ?? afterPath
      const [text, sourceStat] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const before = beforePath ? await baseline.compile(beforePath, text, sourceStat) : []
      const after = afterPath ? await candidate.compile(afterPath, text, sourceStat) : []
      counts.baselineSections += before.length
      counts.candidateSections += after.length
      counts.unmatchedSections += Math.abs(before.length - after.length)
      for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
        const oldSection = before[index]
        const newSection = after[index]
        if (!oldSection.id || oldSection.id !== newSection.id) {
          counts.unmatchedSections += 1
          continue
        }
        const pictureChanged = oldSection.picture !== newSection.picture
        counts.changedPictureKeys += Number(pictureChanged)
        if (oldSection.markup === newSection.markup && !pictureChanged &&
            oldSection.tableStyle === newSection.tableStyle) continue

        counts.changedSections += 1
        if (oldSection.layout === 'table' && newSection.layout === 'table') counts.changedTableSections += 1
        else if (oldSection.layout === 'mindmap' && newSection.layout === 'mindmap') counts.changedMindmapSections += 1
        else counts.changedOtherSections += 1
        if (sectionSignature) {
          console.log(JSON.stringify({
            talk,
            section: index + 1,
            before: sectionSignature(oldSection),
            after: sectionSignature(newSection),
          }))
        }
      }
    } catch {
      // Exceptions can contain source text or file names.
      counts.errors += 1
    }
  }
  console.log(JSON.stringify(counts))
  const { changedSections, changedOtherSections, unmatchedTalks, unmatchedSections, errors } = counts
  const unexpectedChanges = allowTableAndMindmap ? changedOtherSections : changedSections
  return paths.size > 0 && !(unexpectedChanges || unmatchedTalks || unmatchedSections || errors) ? 0 : 1
}

try {
  process.exitCode = await compare()
} catch {
  console.error('Library comparison could not start.')
  process.exitCode = 2
}
