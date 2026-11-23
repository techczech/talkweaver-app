import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHandoutPages } from '../src/main/handout-pages.ts'
import { publicationFilesWarning, publicationMediaReview } from '../src/shared/publication-files.ts'
import { grantedPublishing } from './lib/publishing-fakes.mjs'
import { testNetworkPermit } from '../src/main/test-network-guard.ts'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const compilerDir = join(repo, 'compiler/scripts')
function fixture(t, text) {
  const root = mkdtempSync(join(tmpdir(), 'tw-publication-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marker = 'publication-files-fixture'
  assert.equal(testNetworkPermit({packaged:false,env:{TW_E2E:'1',TW_E2E_CLOUDFLARE_API_BASE_URL:'http://127.0.0.1:9/client/v4',TW_E2E_PROFILE_MARKER:marker},userData:root,tempDirs:[tmpdir()],realpath:p=>p,readMarker:()=>marker}).state,'granted')
  const path = join(root,'example-outline.md')
  writeFileSync(path,text)
  const job = {kind:'preflight',compilerDir,outlinePath:path,text,assetRoots:[root]}
  return {root,path,job}
}
const source = ref => `---\ntitle: Synthetic example\n---\n\n## Interactive example {id=ab12}\n\n[Simulation: ${ref}]\n`

async function buildFixture(f) {
  const siteDir = join(f.root, 'built-site')
  return buildHandoutPages({
    kind: 'talk', compilerDir, talkOutDir: join(siteDir, 'example'), siteDir, slug: 'example',
    live: '', url: 'https://example.test/example/', qr: '', downloadFile: 'download.html', handoutFile: 'example.html',
    outlinePath: f.path, text: f.job.text, outline: f.job.text, assetRoots: [f.root], homeDetails: {},
  }, html => html)
}

test('real compiler preflight names an absent widget before publishing starts', async t => {
  const f=fixture(t,source('widgets/missing.html'))
  const check=await buildHandoutPages(f.job,()=>{throw Error('preflight must never build or slim HTML')})
  assert.equal(check.publicationFiles.checked,1)
  assert.equal(check.publicationFiles.findings.length,1)
  assert.equal(check.publicationFiles.findings[0].file,'widgets/missing.html')
  assert.equal(check.publicationFiles.findings[0].reason,'missing')
  assert.equal(publicationFilesWarning(check.publicationFiles).fix.action,'get-library-files')
})

test('once the widget arrives the same real build and fake Cloudflare path publishes it', async t => {
  const f=fixture(t,source('widgets/arrives.html'))
  const before=await buildHandoutPages(f.job,html=>html)
  assert.equal(before.publicationFiles.findings.length,1)
  mkdirSync(join(f.root,'widgets'))
  writeFileSync(join(f.root,'widgets/arrives.html'),'<!doctype html><title>Widget</title><p>Synthetic widget content</p>')
  const ready=await buildHandoutPages(f.job,html=>html)
  assert.equal(ready.publicationFiles.findings.length,0)
  const publishing=grantedPublishing({siteDir:join(f.root,'site'),live:async()=>({baseUrl:''})})
  const result=await publishing.publish({entry:'talk',prepare:async build=>{
    const talkOutDir=build.makeFolder(join(build.dir,'example'))
    const made=await buildHandoutPages({kind:'talk',compilerDir,talkOutDir,siteDir:build.dir,slug:'example',live:'',url:build.link('https://example.test/example/'),qr:'',downloadFile:'download.html',handoutFile:'example.html',outlinePath:f.path,text:f.job.text,outline:f.job.text,assetRoots:[f.root],homeDetails:{}},html=>html)
    return {ok:true,built:made}
  }})
  assert.equal(result.ok,true,JSON.stringify(result))
  assert.ok(publishing.api.production('acct','talks').files['/example/index.html'])
  assert.match(readFileSync(join(f.root,'site/example/example.html'),'utf8'),/Synthetic widget content/)
})

test('a symlink outside the allowed roots is refused without adopting its bytes',async t=>{
  const f=fixture(t,source('outside.html'))
  const other = fixture(t, '')
  const outside = join(other.root, 'private.html')
  writeFileSync(outside, '<p>synthetic private widget body</p>')
  symlinkSync(outside,join(f.root,'outside.html'))
  const check=await buildHandoutPages(f.job,html=>html)
  assert.equal(check.publicationFiles.findings[0].reason,'outside')
  assert.equal(publicationFilesWarning(check.publicationFiles).fix.action,'get-library-files')
  assert.match(publicationFilesWarning(check.publicationFiles).detail, /outside the allowed media folders/)
  const built = await buildFixture(f)
  assert.ok(built.warnings.some(warning => warning.includes('asset-outside-vault')))
  const handout = readFileSync(join(f.root, 'built-site/example/example.html'), 'utf8')
  assert.doesNotMatch(handout, /synthetic private widget body|private\.html/)
  assert.match(handout, /outside\.html/)
})

test('remote widgets are not treated as missing local files or fetched by preflight',async t=>{
  const f=fixture(t,source('https://example.invalid/widget'))
  const check=await buildHandoutPages(f.job,html=>html)
  assert.deepEqual(check.publicationFiles,{checked:0,findings:[]})
})

test('a still-downloading file and an overdue check are advisory', () => {
  const check = { checked: 1, findings: [{ file: 'online.html', slide: 'abc', reason: 'not-downloaded' }] }
  const result = publicationMediaReview(check, [])
  assert.equal(result.prompt, undefined)
  assert.match(result.notices[0], /online\.html — still downloading/)
  assert.equal(publicationMediaReview(undefined, ['Some media may still be downloading.']).prompt, undefined)
  const rechecked = publicationMediaReview({ checked: 1, findings: [] }, [], 'recheck-media')
  assert.equal(rechecked.prompt?.kind, 'media-ready')
})


test('the real compiler publishes placeholders for unreadable local media', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = fixture(t, source('unreadable.html') + '\n## Film {id=ef34}\n\n[Video: unavailable.mp4]\n')
  for (const name of ['unreadable.html', 'unavailable.mp4']) {
    const path = join(f.root, name)
    writeFileSync(path, 'synthetic unavailable bytes')
    chmodSync(path, 0o000)
  }
  const built = await buildFixture(f)
  for (const name of ['unreadable.html', 'unavailable.mp4']) {
    assert.ok(built.warnings.some(warning => warning.includes(name)), `the compiler warns about ${name}`)
  }
  const handout = readFileSync(join(f.root, 'built-site/example/example.html'), 'utf8')
  assert.doesNotMatch(handout, /synthetic unavailable bytes/)
})
