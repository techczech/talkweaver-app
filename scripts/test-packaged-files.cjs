'use strict'
// Exercise electron-builder's real config normalisation and file-set collector: counting raw
// globs would flag harmless OR matches and miss collisions between independent FileSets.
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { join, dirname, relative } = require('node:path')
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config')
const { getNodeModuleFileMatcher, getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier')
const repo = join(__dirname, '..')
const scratch = mkdtempSync(join(repo, '.tw-packaged-files-'))
const paths = ['package.json', 'out/main/index.js', 'out/preload/index.js',
  'out/renderer/index.html', 'out/renderer/settings.html', 'out/renderer/capture-embed.html',
  'out/renderer/assets/index.js', 'out/renderer/assets/index.css', 'out/renderer/assets/nested/font.woff2']
async function collect(build, platform) {
  const config = doMergeConfigs([structuredClone(build)])
  const packager = { info: { config, projectDir: scratch, buildResourcesDir: 'build',
    areNodeModulesHandledExternally: false, debugLogger: { isEnabled: false } } }
  const matchers = getMainFileMatchers(scratch, join(scratch, 'staged'), x => x,
    config[platform] || {}, packager, join(scratch, 'release'), false)
  const sets = await computeFileSets(matchers, null, packager, false)
  return sets.flatMap(set => set.files.map(file => relative(scratch, join(set.destination, relative(set.src, file)))))
}
;(async () => {
  try {
    for (const file of [...paths, 'src/not-shipped.ts', 'docs/not-shipped.md']) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true })
      writeFileSync(join(scratch, file), 'fixture')
    }
    const build = JSON.parse(readFileSync(join(repo, 'package.json'))).build
    for (const platform of ['mac', 'win', 'linux']) {
      const files = await collect(build, platform)
      const duplicates = files.filter((file, i) => files.indexOf(file) !== i)
      assert.deepEqual(duplicates, [], `${platform}: duplicate packaging destinations`)
      assert.deepEqual(files.sort(), paths.map(file => join('staged', file)).sort(), `${platform}: required files only`)
    }
    // Production dependency exclusions must keep applying after moving the root FileSet.
    for (const [platform, excluded] of Object.entries({
      mac: ['linux/x64', 'win32/x64', 'darwin/x64'],
      win: ['linux/x64', 'darwin/arm64']
    })) {
      const filter = getNodeModuleFileMatcher(scratch, join(scratch, 'staged'), x => x,
        build[platform], { config: build, debugLogger: { isEnabled: false } }).createFilter()
      const stat = { isDirectory: () => false }
      for (const target of excluded) assert.equal(filter(join(scratch, 'node_modules/onnxruntime-node/bin/napi-v6', target, 'onnxruntime.node'), stat), false)
      assert.equal(filter(join(scratch, 'node_modules/workerd/bin/workerd'), stat), false)
      const supported = platform === 'mac' ? 'darwin/arm64' : 'win32/x64'
      assert.equal(filter(join(scratch, 'node_modules/onnxruntime-node/bin/napi-v6', supported, 'onnxruntime.node'), stat), true)
    }
    // Mutation guard: restoring a second independent root FileSet must be detected.
    const broken = structuredClone(build)
    broken.files = ['out/**/*', 'package.json']
    const files = await collect(broken, 'mac')
    assert(files.length > new Set(files).size, 'collector must expose overlapping FileSets')
    console.log('PASS packaged files: mac/win/linux unique destinations, required nested assets, source exclusion, overlap mutation')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
