import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const presenterTemplateSource = 'assets/templates/presenter-popup-single-html.html'
export const presenterTemplateOutput = 'assets/templates/presenter-popup-single-html.generated.html'

// Inputs to build-shortcut-help.mjs, relative to the compiler root.
const shortcutHelpInputs = [
  '../scripts/build-shortcut-help.mjs',
  '../src/shared/shortcut-registry.ts',
  '../src/shared/presenter-controls.ts',
  '../src/shared/presenter-palette.ts',
  '../src/shared/task-groups.ts',
  'assets/icons/lucide.json',
  'assets/runtime/audience-reactions.js',
]

export class PresenterTemplateError extends Error {}

export function deckStylesheetPaths(stylesDir) {
  return readdirSync(stylesDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

export function readPresenterTemplate(compilerRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const path = join(compilerRoot, presenterTemplateOutput)
  const generated = statSync(path, { throwIfNoEntry: false })
  const fail = (reason) => {
    throw new PresenterTemplateError(`Presenter template ${reason}: ${path}. Run npm run generate:deck-styles.`)
  }
  if (!generated?.isFile()) fail('is missing')

  // The packaged compiler ships the finished template alone. Installer copies can reset mtimes.
  const source = statSync(join(compilerRoot, presenterTemplateSource), { throwIfNoEntry: false })
  if (source) {
    const styles = deckStylesheetPaths(join(compilerRoot, 'assets/styles'))
    const helpInputs = shortcutHelpInputs.map((file) => join(compilerRoot, file))
    if (source.mtimeMs > generated.mtimeMs ||
        styles.some((file) => statSync(file).mtimeMs > generated.mtimeMs) ||
        helpInputs.some((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs > generated.mtimeMs)) {
      fail('is stale')
    }
  }
  return readFileSync(path, 'utf8')
}
