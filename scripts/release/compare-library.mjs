// Run on the laptop with dependencies and generated compiler assets in both checkouts.
// TW_LIBRARY_ROOT=<read-only vault> node scripts/release/compare-library.mjs <baseline checkout>
// Output is counts only. The compiler receives the same source and file scope on both sides.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const libraryRoot = process.env.TW_LIBRARY_ROOT
const baselineRoot = process.argv[2]

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
      return slides.map(({ html }, index) => ({
        markup: createHash('sha256').update(html).digest('hex'),
        picture: model.pictureKeys[index],
      }))
    },
  }
}

async function compare() {
  if (!libraryRoot || !baselineRoot || process.argv.length !== 3) {
    console.error('Set TW_LIBRARY_ROOT and pass the baseline checkout as the only argument.')
    return 2
  }
  if (!(await stat(libraryRoot)).isDirectory()) return 2

  const [baseline, candidate] = await Promise.all([loadCheckout(baselineRoot), loadCheckout(candidateRoot)])
  const paths = new Set([...baseline.paths.keys(), ...candidate.paths.keys()])
  const counts = {
    baselineTalks: baseline.paths.size,
    candidateTalks: candidate.paths.size,
    baselineSections: 0,
    candidateSections: 0,
    changedSections: 0,
    changedPictureKeys: 0,
    unmatchedTalks: 0,
    unmatchedSections: 0,
    errors: 0,
  }
  for (const key of paths) {
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
        counts.changedSections += Number(before[index].markup !== after[index].markup)
        counts.changedPictureKeys += Number(before[index].picture !== after[index].picture)
      }
    } catch {
      // Exceptions can contain source text or file names.
      counts.errors += 1
    }
  }
  console.log(JSON.stringify(counts))
  const { changedSections, changedPictureKeys, unmatchedTalks, unmatchedSections, errors } = counts
  return paths.size > 0 && !(changedSections || changedPictureKeys || unmatchedTalks || unmatchedSections || errors) ? 0 : 1
}

try {
  process.exitCode = await compare()
} catch {
  console.error('Library comparison could not start.')
  process.exitCode = 2
}
