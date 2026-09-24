import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const taskRequire = createRequire(import.meta.url)
const outfileFlag = process.argv.indexOf('--outfile')
if (outfileFlag >= 0 && !process.argv[outfileFlag + 1]) {
  throw new Error('--outfile requires a path')
}
const defaultOutfile = resolve(repo, 'compiler/assets/vendor/svg-sanitiser.mjs')
const outfile = outfileFlag >= 0
  ? resolve(repo, process.argv[outfileFlag + 1])
  : defaultOutfile
const jsdomBrowserDir = resolve(
  repo,
  'compiler/assets/vendor/jsdom/lib/jsdom/browser'
)

await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: {
    sourcefile: 'compiler-svg-sanitiser-entry.mjs',
    resolveDir: repo,
    contents: `
      import { JSDOM } from 'jsdom'

      const svgSanitiserDom = new JSDOM('')
      const previousWindow = globalThis.window
      globalThis.window = svgSanitiserDom.window
      const { sanitiseSvg } = await import('./src/shared/objects/sanitise-svg.ts')
      if (typeof previousWindow === 'undefined') delete globalThis.window
      else globalThis.window = previousWindow

      export function sanitiseSvgForCompiler(source) {
        const previousDomParser = globalThis.DOMParser
        globalThis.DOMParser = svgSanitiserDom.window.DOMParser
        try {
          return sanitiseSvg(source)
        } finally {
          if (typeof previousDomParser === 'undefined') delete globalThis.DOMParser
          else globalThis.DOMParser = previousDomParser
        }
      }
    `
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  external: ['canvas'],
  plugins: [
    {
      name: 'inline-css-tree-data',
      setup(buildContext) {
        buildContext.onLoad(
          { filter: /css-tree\/lib\/data\.js$/ },
          async ({ path }) => {
            let contents = await readFile(path, 'utf8')
            const dataDir = resolve(dirname(path), '../../mdn-data/css')
            const replacements = [
              ['mdnAtrules', 'at-rules.json'],
              ['mdnProperties', 'properties.json'],
              ['mdnSyntaxes', 'syntaxes.json']
            ]
            contents = contents
              .replace("import { createRequire } from 'module';\n", '')
              .replace('const require = createRequire(import.meta.url);\n', '')
            for (const [binding, filename] of replacements) {
              const json = JSON.stringify(
                JSON.parse(await readFile(resolve(dataDir, filename), 'utf8'))
              )
                .replaceAll('\u2028', '\\u2028')
                .replaceAll('\u2029', '\\u2029')
              contents = contents.replace(
                `const ${binding} = require('mdn-data/css/${filename}');`,
                () => `const ${binding} = ${json};`
              )
            }
            if (contents.includes("require('mdn-data/")) {
              throw new Error('Failed to inline css-tree mdn-data JSON')
            }
            return { contents, loader: 'js' }
          }
        )
        buildContext.onLoad(
          { filter: /css-tree\/lib\/data-patch\.js$/ },
          async ({ path }) => {
            const patch = await readFile(
              resolve(dirname(path), '../data/patch.json'),
              'utf8'
            )
            return {
              contents: `const patch = ${patch}; export default patch;`,
              loader: 'js'
            }
          }
        )
        buildContext.onLoad(
          { filter: /css-tree\/lib\/version\.js$/ },
          async ({ path }) => {
            const packageJson = JSON.parse(
              await readFile(resolve(dirname(path), '../package.json'), 'utf8')
            )
            return {
              contents: `export const version = ${JSON.stringify(packageJson.version)};`,
              loader: 'js'
            }
          }
        )
      }
    }
  ],
  banner: {
    js: [
      'import { createRequire } from "node:module";',
      'import { dirname as pathDirname, join as pathJoin } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const require = createRequire(import.meta.url);',
      'const __dirname = pathJoin(pathDirname(fileURLToPath(import.meta.url)), "jsdom/lib/jsdom/living/css/helpers");'
    ].join(' ')
  }
})

if (outfile === defaultOutfile) {
  await mkdir(jsdomBrowserDir, { recursive: true })
  await copyFile(
    resolve(
      dirname(taskRequire.resolve('jsdom')),
      'jsdom/browser/default-stylesheet.css'
    ),
    resolve(jsdomBrowserDir, 'default-stylesheet.css')
  )
}

console.log(`compiler SVG sanitiser bundle: ${relative(repo, outfile)}`)
