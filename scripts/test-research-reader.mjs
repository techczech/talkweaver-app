import assert from 'node:assert/strict'
import { renderInline } from '../compiler/scripts/lib/00-inline-render.mjs'
import { renderScriptInline } from '../compiler/scripts/lib/slide-script-render.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { insertSlideAfterCaret } from '../src/shared/old-slide.ts'
import { join } from 'node:path'
import * as reader from '../src/main/research-reader.ts'
import { researchSourceLabel, researchInsertText, researchSlideText } from '../src/shared/research.ts'
import { RESEARCH_INSERT_VERB, RESEARCH_MAKE_SLIDE_VERB, AGENT_VERBS, researchReadHandler } from '../src/main/agent-verbs.ts'
const root = mkdtempSync(join(tmpdir(), 'tw-reader-'))
const vault = join(root, 'vault'), talk = join(vault, 'talk'), other = join(vault, 'other'), bin = join(root, 'bin')
for (const dir of [join(talk, 'research'), join(other, 'research'), bin]) mkdirSync(dir, { recursive: true })
for (const dir of [talk, other]) writeFileSync(join(dir, `${dir.split('/').at(-1)}-outline.md`), '# Talk\n\n## One\n\n[Research](research/item.md)\n')
const stub = (title, extra = '') => `---\ntitle: ${title}\nkind: table\ncreated: 2026-10-20T12:00:00Z\nby: agent\nprompt: Count things\nsources:\n  - url: https://example.org/report\n${extra}---\n| A | B |\n| --- | --- |\n| 1 | 2 |\n`
const file = join(talk, 'research/item.md')
writeFileSync(file, stub('Counts', 'artefact: research/widget.html\n'))
writeFileSync(join(talk, 'research/widget.html'), '<script>parent.hacked=true</script><p>Widget</p>')
writeFileSync(join(other, 'research/other.md'), stub('Elsewhere'))
writeFileSync(join(talk, 'research/broken.md'), '---\ntitle: [broken\n---\n')
writeFileSync(join(talk, 'research/large.md'), 'x'.repeat(300 * 1024))
writeFileSync(join(root, 'secret.md'), stub('Outside'))
symlinkSync(join(root, 'secret.md'), join(talk, 'research/escape.md'))
const fake = join(bin, 'scout')
writeFileSync(fake, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(process.env.SAME){console.log(JSON.stringify({hits:JSON.parse(process.env.SAME),skipped:0}));return};if(process.env.EMPTY){console.log(JSON.stringify(a[0]==='capture'?{hits:[],skipped:0}:{results:[]}));process.exit(1)};if(process.env.WAIT){setTimeout(()=>{},5000);return};if(process.env.JUNK){console.log('not json');return};if(process.env.FAIL){console.error('private diagnostic');process.exit(2)};if(a[0]==='corpora'){console.log(JSON.stringify({corpora:[{root:${JSON.stringify(join(root, 'archive'))}}]}));return};if(a[0]==='capture')console.log(JSON.stringify({hits:[{file:${JSON.stringify(join(talk, 'talk-outline.md'))},line:5,text:'research/item.md'},{file:${JSON.stringify(join(root, 'secret.md'))},line:1,text:'private'}],skipped:0}));else console.log(JSON.stringify({results:[{path:${JSON.stringify(file)},title:'Counts',hits:[{quote:'Counts'}]},{path:${JSON.stringify(join(other, 'research/other.md'))},title:'Elsewhere',hits:[{quote:'Elsewhere'}]},{path:${JSON.stringify(join(root, 'secret.md'))},title:'Registered archive',corpus:'archive',hits:[{quote:'Public snippet'}]}]}));`)
chmodSync(fake, 0o755)
const deps = { vaultRoot: vault, vaultRoots: [vault], env: { PATH: `${bin}:${process.env.PATH}` }, home: root, log: () => {} }
try {
  assert.equal(typeof reader.listResearch, 'function', 'reader has a list seam')
  const listed = await reader.listResearch({ talkDir: talk }, deps)
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.items.map(i => i.title), ['Counts'])
  assert.equal(listed.skipped, 3, 'malformed, oversize and symlink stubs are skipped and counted')
  const item = listed.items[0]
  assert.equal(item.prompt, 'Count things')
  assert.deepEqual(item.sources, ['url:https://example.org/report'])
  assert.equal(item.artefacts[0].data, undefined, 'list does not load artefact bytes')
  const opened = await reader.listResearch({ talkDir: talk, file }, deps)
  assert.match(opened.items[0].artefacts[0].data, /parent.hacked/)
  assert.equal((await reader.listResearch({ talkDir: root }, deps)).ok, false)
  assert.equal((await reader.listResearch({ talkDir: talk, file: join(root, 'secret.md') }, deps)).ok, false)
  assert.equal((await reader.listResearch({ talkDir: talk, file: join(talk, 'research/escape.md') }, deps)).ok, false)
  const linkTalk = join(vault, 'linked'); symlinkSync(root, linkTalk)
  assert.equal((await reader.listResearch({ talkDir: linkTalk }, deps)).ok, false)
  const emptyDeps = { ...deps, env: { ...deps.env, EMPTY: '1' } }
  const emptyUses = await reader.whereUsedResearch({ talkDir: talk, file }, emptyDeps)
  assert.deepEqual(emptyUses, { ok: true, uses: [], skipped: 0 }, 'exit 1 JSON means Not used yet')
  const emptySearch = await reader.searchResearch({ talkDir: talk, query: 'absent', scope: 'talk' }, emptyDeps)
  assert.equal(emptySearch.ok, true)
  assert.deepEqual(emptySearch.items, [], 'exit 1 JSON means no results')
  assert.doesNotMatch(researchInsertText({ ...item, body: '# Heading\n## Nested\n### Slide' }), /^#{1,6} /m)
  const adoption = join(talk, 'research/adoption-table.md'), otherAdoption = join(other, 'research/adoption-table.md')
  writeFileSync(adoption, stub('Adoption')); writeFileSync(otherAdoption, stub('Other adoption'))
  writeFileSync(join(talk, 'adoption-outline.md'), '# Talk\n\n## First\n\n[Research: Counts \\[all\\]](research/adoption-table.md)\n[Wrong](../other/research/adoption-table.md)\nadoption-table.md\n[Encoded](research/adoption%2Dtable.md)\n')
  writeFileSync(join(other, 'adoption-outline.md'), '# Talk\n\n## Other\n\n[Research](research/adoption-table.md)\n')
  const hits = [5,6,7,8].map(line => ({file:join(talk,'adoption-outline.md'),line})).concat({file:join(other,'adoption-outline.md'),line:5})
  const same = await reader.whereUsedResearch({ talkDir: talk, file: adoption }, { ...deps, env: { ...deps.env, SAME: JSON.stringify(hits) } })
  assert.equal(same.ok, true); assert.equal(same.uses.length, 1, 'only exact links in this talk count, deduplicated per slide')
  const bracketOnly = await reader.whereUsedResearch({ talkDir: talk, file: adoption }, { ...deps, env: { ...deps.env, SAME: JSON.stringify([{file:join(talk,'adoption-outline.md'),line:5}]) } })
  assert.equal(bracketOnly.uses.length, 1, 'escaped brackets in the link title still identify the research use')
  const falseHits = await reader.whereUsedResearch({ talkDir: talk, file: adoption }, { ...deps, env: { ...deps.env, SAME: JSON.stringify(hits.filter(h => h.line !== 5 && h.line !== 8)) } })
  assert.deepEqual(falseHits.uses, [], 'same basename, prose and other talks are not uses')
  rmSync(adoption); rmSync(otherAdoption)
  const alias = join(vault, 'talk-alias'); symlinkSync(talk, alias)
  assert.equal((await reader.listResearch({ talkDir: alias, file }, deps)).items[0].inCurrentTalk, true, 'main compares canonical talk identity')
  const inserted = [], insertDeps = { ...deps, activeTalkDir: () => alias, insertResearch: async (file, slide) => { inserted.push({file, slide}); return {ok:true} } }
  assert.equal((await RESEARCH_INSERT_VERB.run({file}, insertDeps)).ok, true)
  assert.equal((await RESEARCH_MAKE_SLIDE_VERB.run({file}, insertDeps)).ok, true)
  assert.deepEqual(inserted, [{file:realpathSync(file),slide:false},{file:realpathSync(file),slide:true}])
  assert.equal((await RESEARCH_INSERT_VERB.run({file:join(other,'research/other.md')}, insertDeps)).ok, false)
  assert.equal((await RESEARCH_INSERT_VERB.run({file}, deps)).ok, false, 'no active editor means no insertion')
  rmSync(alias)
  assert.equal(researchSourceLabel('scout:reading-highlights:readings/hebb.md:12'), 'reading highlights · hebb.md · line 12')
  assert.equal(researchSourceLabel('file:/private/source/report.pdf'), 'report.pdf')
  assert.equal(researchSourceLabel('https://example.org/report'), 'https://example.org/report')
  const aborted = new AbortController()
  const pending = reader.whereUsedResearch({talkDir:talk,file}, {...deps,signal:aborted.signal,env:{...deps.env,WAIT:'1'}})
  setTimeout(() => aborted.abort(), 80)
  const start = Date.now(); assert.equal((await pending).ok, false); assert.ok(Date.now()-start < 2000, 'abort kills Scout before its five-second wait')
  const searchAbort = new AbortController()
  const searching = reader.searchResearch({talkDir:talk,query:'wait',scope:'research'}, {...deps,signal:searchAbort.signal,env:{...deps.env,WAIT:'1'}})
  setTimeout(() => searchAbort.abort(), 80)
  const searchStart = Date.now(); assert.equal((await searching).ok, false); assert.ok(Date.now()-searchStart < 2000, 'superseded search kills Scout')
  const usages = await reader.whereUsedResearch({ talkDir: talk, file }, deps)
  assert.equal(usages.ok, true)
  assert.equal(usages.uses.length, 1, 'only usages in open vaults survive')
  assert.equal(usages.uses[0].slideTitle, 'One')
  assert.equal(usages.uses[0].slideLine, 3)
  for (const [scope, count] of [['talk', 1], ['research', 2], ['everything', 3]]) {
    const found = await reader.searchResearch({ talkDir: talk, query: 'counts', scope }, deps)
    assert.equal(found.ok, true)
    assert.equal(found.items.length, count, `${scope} is applied to Scout results`)
  }
  assert.equal((await reader.searchResearch({ talkDir: talk, query: 'x', scope: 'outside' }, deps)).ok, false)
  const logged = []
  const failed = await reader.searchResearch({ talkDir: talk, query: 'x', scope: 'talk' }, { ...deps, env: { ...deps.env, FAIL: '1' }, log: m => logged.push(m) })
  assert.equal(failed.ok, false)
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostic/)
  assert.match(logged.join(), /private diagnostic/)
  const all = await reader.searchResearch({ talkDir: talk, query: '', scope: 'research' }, deps)
  assert.equal(all.items.length, 2, 'empty All research includes every talk even before indexing')
  const unopened = await reader.searchResearch({ talkDir: talk, query: 'counts', scope: 'research' }, { ...deps, vaultRoots: [other] })
  assert.equal(unopened.ok, false, 'the current talk must belong to an open vault')
  const archived = join(root, 'archive'); mkdirSync(archived)
  const archiveFile = join(archived, 'source.txt'); writeFileSync(archiveFile, 'Archive source')
  const revealed = []
  const revealDeps = { ...deps, reveal: path => revealed.push(path) }
  assert.equal((await reader.revealResearchSource({ file }, revealDeps)).ok, true)
  assert.equal((await reader.revealResearchSource({ file: archiveFile }, revealDeps)).ok, true)
  assert.deepEqual(revealed, [realpathSync(file), realpathSync(archiveFile)])
  assert.equal((await reader.revealResearchSource({ file: join(root, 'secret.md') }, revealDeps)).ok, false)
  const timeout = await reader.searchResearch({ talkDir: talk, query: 'x', scope: 'talk' }, { ...deps, timeoutMs: 50, env: { ...deps.env, WAIT: '1' } })
  assert.equal(timeout.ok, false, 'Scout is killed at the deadline')
  const junk = await reader.searchResearch({ talkDir: talk, query: 'x', scope: 'talk' }, { ...deps, env: { ...deps.env, JUNK: '1' } })
  assert.equal(junk.ok, false, 'malformed Scout replies are not treated as empty results')
  const oversizedArtefact = join(talk, 'research/huge.html')
  writeFileSync(oversizedArtefact, 'x'.repeat(8 * 1024 * 1024 + 1))
  const capStub = join(talk, 'research/cap.md')
  writeFileSync(capStub, stub('Bounded', 'artefact: research/huge.html\n'))
  assert.equal((await reader.listResearch({ talkDir: talk, file: capStub }, deps)).items[0].artefacts.length, 0)
  rmSync(capStub)
  const symlinkStub = join(talk, 'research/link.md')
  symlinkSync(join(root, 'secret.md'), join(talk, 'research/linked.html'))
  writeFileSync(symlinkStub, stub('Linked artefact', 'artefact: research/linked.html\n'))
  assert.equal((await reader.listResearch({ talkDir: talk, file: symlinkStub }, deps)).items[0].artefacts.length, 0)
  rmSync(symlinkStub)
  const otherResearch = join(other, 'research')
  rmSync(otherResearch, { recursive: true }); symlinkSync(join(talk, 'research'), otherResearch)
  assert.equal((await reader.listResearch({ talkDir: other }, deps)).ok, false, 'a symlink research folder is refused')
  rmSync(otherResearch); mkdirSync(otherResearch); writeFileSync(join(otherResearch, 'other.md'), stub('Elsewhere'))
  assert.equal(researchInsertText({ ...item, artefacts: [], body: '```md\n![Example](chart.png)\n```' }).includes('![Example](chart.png)'), true, 'fenced code is preserved verbatim')
  const text = researchInsertText(item)
  for (const render of [renderInline, renderScriptInline]) {
    assert.equal(render('[Research: Counts](research/item.md)'), 'Research: Counts', 'published research backlinks are plain text')
    assert.match(render('[External](https://example.org)'), /href=/)
  }
  assert.match(text, /Source:.*https:\/\/example.org\/report/)
  assert.match(text, /\[Research: Counts\]\(research\/item.md\)/)
  assert.match(text, /\| 1 \| 2 \|/)
  assert.match(researchSlideText(item), /^## Counts\n/)
  assert.match(text, /\[Embed: research\/widget.html\]/)
  assert.match(researchInsertText({ ...item, body: '![Chart](chart.png)', artefacts: [] }), /!\[Chart\]\(research\/chart.png\)/)
  const before = '# Talk\n\n## First\n\nWriting here\n\n## Last\n\nKeep this text\n'
  for (const body of ['| A | B |\n| --- | --- |\n| 1 | 2 |', '> A quotation\n> — Source', '```chart=bar\n- One: 10\n- Two: 20\n```', '[Embed: widget.html]']) {
    const placed = insertSlideAfterCaret({ text: before, caret: before.indexOf('Writing'), slide: researchSlideText({ ...item, body }) })
    assert.equal(placed.ok, true, body)
    assert.ok(placed.text.indexOf('## Counts') > placed.text.indexOf('Writing here'))
    assert.ok(placed.text.indexOf('## Counts') < placed.text.indexOf('## Last'))
    assert.match(placed.text, /Keep this text/)
  }
  for (const id of ['research.list', 'research.whereUsed', 'research.search']) assert.ok(AGENT_VERBS.find(v => v.id === id), `${id} registered`)
  const viaIpc = await researchReadHandler('research.list', { talkDir: talk }, { ...deps, vaultRootFor: () => vault })
  assert.deepEqual(viaIpc, listed)
  for (const id of ['research.list', 'research.whereUsed', 'research.search']) {
    const verb = AGENT_VERBS.find(v => v.id === id), original = verb.run
    verb.run = async () => ({ ok: false, error: { code: 'stub', message: id } })
    try { assert.equal((await researchReadHandler(id, { talkDir: talk }, { ...deps, vaultRootFor: () => vault })).error.message, id) } finally { verb.run = original }
  }
  console.log('Research reader: containment, symlinks, malformed frontmatter, size caps, previews, scopes, usages, provenance and shared verbs pass')
} finally { rmSync(root, { recursive: true, force: true }) }
