// Slides across vaults (several-vaults ticket 06). Seams: the cross-vault insert function
// (prepareCrossVaultInsert in src/main/cross-vault-insert.ts) and the provenance writer (the slide
// ledger's recordOutlineSave with originHints, 13-slide-ledger.mjs), driven with real files and the
// real compiler libs. Invariant 1: nothing written into the target vault names an absolute path or a
// path inside the source vault; provenance names the source vault (id + name) and slide id only.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { prepareCrossVaultInsert, assignTargetIds, cutUntravelledRefs, scrubSourceRoot } from '../src/main/cross-vault-insert.ts'
import { createProvenanceStore, originHintsFor } from '../src/main/provenance-store.ts'
import * as edit from '../compiler/scripts/lib/12-outline-edit.mjs'
import * as ledger from '../compiler/scripts/lib/13-slide-ledger.mjs'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const tools = {
  listSlideBlocks: (t) => edit.listSlideBlocks(t),
  stampMissingIds: (t, rng, o) => edit.stampMissingIds(t, rng, o),
  idLineIndex: (l, a, e) => ledger.idLineIndex(l, a, e),
  mintId: (rng, taken) => ledger.mintId(rng, taken),
  idsInVault: (root) => ledger.idsInVault(root)
}
const toWebp = async (buf) => buf // keep bytes: the test checks exact copies
const quiet = { toWebp, warn: () => {} }

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'tw-xvault-')))
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])

function makeVaults(tag) {
  const src = path.join(tmp, `${tag}-Personal Source`)
  const dst = path.join(tmp, `${tag}-Workshop Target`)
  const srcTalkDir = path.join(src, 'lectures-private', 'metaphor-talk-2026')
  const dstTalkDir = path.join(dst, 'workshops', 'ai-assessment')
  fs.mkdirSync(path.join(srcTalkDir, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(src, '_assets'), { recursive: true })
  fs.mkdirSync(dstTalkDir, { recursive: true })
  const srcOutline = path.join(srcTalkDir, 'metaphor-talk-2026-outline.md')
  const dstOutline = path.join(dstTalkDir, 'ai-assessment-outline.md')
  fs.writeFileSync(srcOutline, '---\ntitle: Metaphor talk 2026\n---\n\n### Metaphors are maps {id=abc12}\n\nBody.\n')
  fs.writeFileSync(dstOutline, '---\ntitle: AI and assessment\n---\n\n### Why assessment breaks {id=zzz99}\n\nBody.\n')
  return {
    src, dst, srcOutline, dstOutline,
    source: { id: `src-${tag}`, name: 'Personal', root: src },
    target: { id: `dst-${tag}`, name: 'AI and assessment workshop', root: dst }
  }
}

try {
  await test('insert copies media into the target pool and rewrites refs to pool ids', async () => {
    const v = makeVaults('media')
    fs.writeFileSync(path.join(path.dirname(v.srcOutline), 'assets', 'map.png'), 'map image bytes')
    fs.writeFileSync(path.join(v.src, '_assets', 'img-1234567.webp'), 'pooled bytes')
    fs.writeFileSync(path.join(v.src, '_assets', 'img-1234567.yml'), `id: img-1234567\nalt: "A map"\nsource: "${v.src}/lectures-private/raw.png"\nnote: "from ${v.src}"\n`)
    fs.writeFileSync(path.join(v.src, '_assets', 'vid-abcdef0.mp4'), 'clip bytes')
    fs.writeFileSync(path.join(v.src, '_assets', 'vid-abcdef0.png'), 'poster bytes')
    const md = [
      '### Metaphors are maps {id=abc12}', '',
      '![map](assets/map.png)', '![pooled](img-1234567)', '![clip](vid-abcdef0)', '![web](https://example.org/x.png)'
    ].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'Metaphor talk 2026', markdown: md }, tools, quiet)
    assert.equal(r.ok, true, r.error)
    const lines = r.markdown.split('\n')
    assert.match(lines[2], /^!\[map\]\(img-[0-9a-f]{7}\)$/)
    assert.equal(lines[3], '![pooled](img-1234567)')
    assert.equal(lines[4], '![clip](vid-abcdef0)')
    assert.equal(lines[5], '![web](https://example.org/x.png)')
    const pool = path.join(v.dst, '_assets')
    assert.equal(fs.readFileSync(path.join(pool, 'img-1234567.webp'), 'utf8'), 'pooled bytes')
    assert.equal(fs.readFileSync(path.join(pool, 'vid-abcdef0.mp4'), 'utf8'), 'clip bytes')
    assert.equal(fs.readFileSync(path.join(pool, 'vid-abcdef0.png'), 'utf8'), 'poster bytes', 'a clip travels with its poster')
    const sidecar = fs.readFileSync(path.join(pool, 'img-1234567.yml'), 'utf8')
    assert.match(sidecar, /alt: "A map"/, 'alt text travels')
    assert.ok(!sidecar.includes(v.src) && !sidecar.includes('lectures-private'), 'a source sidecar’s path fields never travel')
    assert.equal(r.materialized, 3)
  })

  await test('media outside the SOURCE vault is refused; an absolute path into it is cut to its file name', async () => {
    const v = makeVaults('contain')
    const outside = path.join(tmp, 'outside-contain')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.png'), 'OUTSIDE bytes')
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(path.dirname(v.srcOutline), 'assets', 'linked.png'))
    const missingAbs = path.join(v.src, 'lectures-private', 'gone.png')
    const md = ['### S {id=abc12}', '', '![l](assets/linked.png)', '![e](../../../outside-contain/secret.png)', `![m](${missingAbs})`].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: md }, tools, quiet)
    assert.equal(r.ok, true)
    assert.ok(r.markdown.includes('![l](linked.png)'), 'a symlink out of the source vault is not followed, and its path is cut')
    assert.ok(r.markdown.includes('![e](secret.png)'), 'a relative escape is cut to its file name')
    assert.ok(r.markdown.includes('![m](gone.png)'), 'an absolute path into the source vault loses its folders')
    assert.ok(!r.markdown.includes(v.src))
    const pool = path.join(v.dst, '_assets')
    for (const f of fs.existsSync(pool) ? walk(pool) : []) assert.ok(!fs.readFileSync(f, 'utf8').includes('OUTSIDE'), f)
    assert.equal(r.skipped, 3)
  })

  await test('media is never written outside the TARGET vault (a pool linked out is refused)', async () => {
    const v = makeVaults('target')
    const elsewhere = path.join(tmp, 'elsewhere-pool')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(v.dst, '_assets'))
    fs.writeFileSync(path.join(path.dirname(v.srcOutline), 'assets', 'a.png'), 'a bytes')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: '### S {id=abc12}\n\n![a](assets/a.png)' }, tools, quiet)
    assert.equal(r.ok, true)
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing lands in the folder the pool links to')
    assert.equal(r.materialized, 0)
  })

  await test('a source outline outside its vault, or a same-vault call, is refused', async () => {
    const v = makeVaults('refuse')
    const r1 = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: path.join(tmp, 'x-outline.md'), sourceTalkTitle: 'T', markdown: '### S' }, tools, quiet)
    assert.equal(r1.ok, false)
    const r2 = await prepareCrossVaultInsert({ source: v.source, target: v.source, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: '### S' }, tools, quiet)
    assert.equal(r2.ok, false)
  })

  await test('S1 probes: every target that did not travel is cut to its file name, never kept verbatim', async () => {
    const v = makeVaults('probes')
    fs.writeFileSync(path.join(v.src, 'lectures-private', 'doc.pdf'), 'pdf bytes')
    const probes = [
      ['![m](../other-talk/assets/missing.png)', '![m](missing.png)'],
      [`![p](${v.src}/lectures-private/doc.pdf)`, '![p](doc.pdf)'],
      [`[handout](${v.src}/lectures-private/doc.pdf)`, '[handout](doc.pdf)'],
      [`![f](file://${v.src}/lectures-private/pic.png)`, '![f](pic.png)'],
      ['![h](../../../etc/hosts.png)', '![h](hosts.png)'],
      [`[notes]: <${v.src}/lectures-private/notes.pdf> "Notes"`, '[notes]: notes.pdf "Notes"'],
      [`[t](<${v.src}/a b/talk.pdf> "Title")`, '[t](talk.pdf "Title")'],
      ['[up](../)', '[up]()'],
      ['[web](https://example.org/a/b.pdf) and [top](#intro) and [^1]: a footnote', '[web](https://example.org/a/b.pdf) and [top](#intro) and [^1]: a footnote']
    ]
    const md = ['### Probes {id=prb01}', '', ...probes.map(([from]) => from), '', '[gone]: ../'].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: md }, tools, quiet)
    assert.equal(r.ok, true, r.error)
    const lines = r.markdown.split('\n')
    probes.forEach(([from, to], i) => assert.equal(lines[2 + i], to, `probe: ${from}`))
    assert.ok(!r.markdown.includes('[gone]:'), 'a reference with no file name is dropped')
    for (const leak of [v.src, path.basename(v.src), 'lectures-private', 'other-talk', 'etc/', tmp]) assert.ok(!r.markdown.includes(leak), `markdown must not contain ${leak}`)
    assert.equal(cutUntravelledRefs('![x](img-1234567) ![y](vid-abcdef0)'), '![x](img-1234567) ![y](vid-abcdef0)', 'pool ids are kept')
  })

  await test('HTML targets: <img>, <a>, <video>, <source>, <iframe> get the markdown treatment', async () => {
    const v = makeVaults('html')
    const talkDir = path.dirname(v.srcOutline)
    fs.writeFileSync(path.join(talkDir, 'assets', 'clip.mp4'), 'html clip bytes')
    fs.writeFileSync(path.join(talkDir, 'assets', 'poster one.png'), 'html poster bytes')
    const probes = [
      [`<img src="${v.src}/lectures-private/photo.png" alt="x">`, '<img src="photo.png" alt="x">'],
      [`<img src="file://${v.src}/lectures-private/pic.png">`, '<img src="pic.png">'],
      ['<a href="../../other-talk/handout.pdf">handout</a>', '<a href="handout.pdf">handout</a>'],
      [`<a href="${v.src}/a folder/notes with spaces.pdf">notes</a>`, '<a href="notes with spaces.pdf">notes</a>'],
      [`<iframe src='${v.src}/lectures-private/embed.html'></iframe>`, "<iframe src='embed.html'></iframe>"],
      [`<video src=${v.src.replace(/ /g, '')}/x/v.webm></video>`, '<video src="v.webm"></video>'],
      ['<a href="https://example.org/a.pdf">web</a> <a href="mailto:a@b.c">m</a> <a href="#top">t</a> <img src="data:image/png;base64,AAAA">', '<a href="https://example.org/a.pdf">web</a> <a href="mailto:a@b.c">m</a> <a href="#top">t</a> <img src="data:image/png;base64,AAAA">'],
      ['<a href="../">up</a>', '<a href="">up</a>']
    ]
    const media = `<video src="assets/clip.mp4" poster='assets/poster one.png'><source src="assets/clip.mp4" type="video/mp4"></video>`
    const md = ['### HTML {id=htm01}', '', ...probes.map(([from]) => from), media].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: md }, tools, quiet)
    assert.equal(r.ok, true, r.error)
    const lines = r.markdown.split('\n')
    probes.forEach(([from, to], i) => assert.equal(lines[2 + i], to, `probe: ${from}`))
    const last = lines[2 + probes.length]
    assert.match(last, /^<video src="vid-[0-9a-f]{7}" poster='img-[0-9a-f]{7}'><source src="vid-[0-9a-f]{7}" type="video\/mp4"><\/video>$/, 'travelling HTML media is copied and pointed at the pool')
    const pool = fs.readdirSync(path.join(v.dst, '_assets'))
    assert.ok(pool.some((f) => /^vid-[0-9a-f]{7}\.mp4$/.test(f)) && pool.some((f) => /^img-[0-9a-f]{7}\.(png|webp)$/.test(f)), pool.join(','))
    for (const leak of [v.src, path.basename(v.src), 'lectures-private', 'other-talk', 'a folder', tmp]) assert.ok(!r.markdown.includes(leak), `markdown must not contain ${leak}`)
  })

  await test('F1/F2: a source root WITH A SPACE leaks through no form (markdown, ref-def, HTML, srcset, object, embed, audio, {bg=}, wiki, prose, encoded)', async () => {
    const v = makeVaults('space root')
    const R = v.src
    assert.ok(R.includes(' '), 'the source root has a space')
    const folder = `${R}/lectures-private`
    const forms = [
      `![img](${folder}/photo.png)`,
      `[link](${folder}/doc.pdf)`,
      `![f](file://${folder}/pic.png)`,
      `[ref]: ${folder}/old deck.pdf "Old deck"`,
      `[ref2]: ${folder}/plain notes.pdf`,
      `[ref3]: <${folder}/angle.pdf> (Angle)`,
      `<img src=${folder}/un quoted.png alt=x>`,
      `<a href="${folder}/q q.pdf">q</a>`,
      `<iframe src='${folder}/embed.html'></iframe>`,
      `<video src=${folder}/v.webm poster=${folder}/p.png></video>`,
      `<img srcset="${folder}/a.png 1x, ${folder}/b.png 2x" alt="s">`,
      `<object data="${folder}/o.pdf"></object>`,
      `<embed src="${folder}/e.svg">`,
      `<audio src="${folder}/a.mp3"></audio>`,
      `{bg=${folder}/bg.png}`,
      `[[${folder}/wiki page]]`,
      `See ${folder}/notes.pdf for more; the vault is ${R}.`,
      `file://${encodeURI(folder)}/enc.png and ${encodeURIComponent(folder + '/comp.png')}`,
      '![h](../../../etc/hosts.png)'
    ]
    const md = ['### Space {id=spc01}', '', ...forms].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: md }, tools, quiet)
    assert.equal(r.ok, true, r.error)
    const needles = [R, encodeURI(R), encodeURIComponent(R), path.basename(R), encodeURI(path.basename(R)), 'lectures-private', 'Personal Source', 'Personal%20Source', tmp, 'etc/']
    for (const n of needles) assert.ok(!r.markdown.includes(n), `output must not contain ${n}:\n${r.markdown}`)
    const lines = r.markdown.split('\n')
    assert.equal(lines[5], '[ref]: old deck.pdf "Old deck"', 'a ref-def target is the whole rest of the line, minus its title')
    assert.equal(lines[6], '[ref2]: plain notes.pdf')
    assert.equal(lines[7], '[ref3]: angle.pdf (Angle)')
    assert.equal(lines[8], '<img src="un quoted.png" alt=x>', 'an unquoted attribute runs to the next attribute')
    assert.equal(lines[12], '<img srcset="a.png 1x, b.png 2x" alt="s">')
    assert.equal(lines[16], '{bg=bg.png}')
    assert.equal(lines[18], 'See notes.pdf for more; the vault is .')
    assert.equal(scrubSourceRoot(`${R}2/other`, R), `${R}2/other`, 'a sibling folder whose name starts with the root is not touched')
  })

  await test('an id the target vault already knows is re-stamped; a free id is kept; an unstamped heading gets one', async () => {
    const v = makeVaults('ids')
    // zzz99 is in the target talk's outline; kkk11 has a version folder in the target's ledger.
    fs.mkdirSync(path.join(v.dst, '_SLIDE-VERSIONS', 'kkk11'), { recursive: true })
    const md = ['### One {id=zzz99}', '', 'a', '', '### Two {id=kkk11}', '', 'b', '', '### Three {id=fre55}', '', 'c', '', '### Four', '', 'd'].join('\n')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'T', markdown: md, extraTaken: ['liv01'] }, tools, quiet)
    assert.equal(r.ok, true)
    const [one, two, three, four] = r.slides
    assert.equal(one.sourceId, 'zzz99'); assert.notEqual(one.id, 'zzz99'); assert.equal(one.restamped, true)
    assert.equal(two.sourceId, 'kkk11'); assert.notEqual(two.id, 'kkk11'); assert.equal(two.restamped, true)
    assert.equal(three.id, 'fre55'); assert.equal(three.restamped, false)
    assert.equal(four.sourceId, ''); assert.match(four.id, /^[a-z0-9]{5}$/)
    assert.ok(r.markdown.includes(`{id=${one.id}}`) && !r.markdown.includes('{id=zzz99}'))
    assert.equal(new Set(r.slides.map((s) => s.id)).size, 4, 'ids are unique')
    for (const s of r.slides) {
      assert.deepEqual(Object.keys(s.origin).sort(), ['slide_id', 'vault_id', 'vault_name'], 'no inserted_by when the inserter has no name')
      assert.equal(s.origin.vault_id, v.source.id)
      assert.equal(s.privateRecord.source_outline_path, v.srcOutline, 'the path goes only to the private record')
    }
  })

  await test('ids promised to the talk’s live text are not reused (assignTargetIds)', () => {
    const r = assignTargetIds('### A {id=liv01}\n\nx', tools, ['liv01'])
    assert.notEqual(r.slides[0].id, 'liv01')
    assert.equal(r.slides[0].restamped, true)
  })

  await test('provenance writer: the version file carries origin only — no /-path, no source slug, no source folder', async () => {
    const v = makeVaults('prov')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'Metaphor talk 2026', markdown: '### Metaphors are maps {id=zzz99}\n\nA map keeps what matters.', insertedBy: 'Dominik Lukeš' }, tools, quiet)
    const slide = r.slides[0]
    const text = fs.readFileSync(v.dstOutline, 'utf8') + '\n' + r.markdown + '\n'
    fs.writeFileSync(v.dstOutline, text)
    const saved = ledger.recordOutlineSave(v.dst, v.dstOutline, text, { originHints: new Map([[slide.id, slide.origin]]) })
    assert.ok(saved.versioned.includes(slide.id))
    const dir = path.join(v.dst, '_SLIDE-VERSIONS', slide.id)
    const [file] = fs.readdirSync(dir)
    const body = fs.readFileSync(path.join(dir, file), 'utf8')
    const originLine = body.split('\n').find((l) => l.startsWith('origin: '))
    assert.ok(originLine, body)
    assert.deepEqual(JSON.parse(originLine.slice('origin: '.length)), { vault_id: v.source.id, vault_name: 'Personal', slide_id: 'zzz99', inserted_by: 'Dominik Lukeš' })
    assert.ok(!originLine.includes('/'), 'origin names no path')
    for (const leak of [v.src, path.basename(v.src), 'lectures-private', 'metaphor-talk-2026', tmp]) {
      assert.ok(!body.includes(leak), `version file must not contain ${leak}`)
    }
    assert.ok(!/^outline: \//m.test(body), 'the outline field stays vault-relative')
    // Origin survives a coalesced save and is read back from the oldest version.
    const edited = text.replace('A map keeps what matters.', 'A map keeps what matters, and leaves out the rest.')
    ledger.recordOutlineSave(v.dst, v.dstOutline, edited, {})
    assert.deepEqual(ledger.slideOrigin(v.dst, slide.id).origin, { vault_id: v.source.id, vault_name: 'Personal', slide_id: 'zzz99', inserted_by: 'Dominik Lukeš' })
    assert.equal(ledger.slideOrigin(v.dst, 'zzz99'), null, 'a slide made here has no origin')
    assert.equal(ledger.parseVersion('---\nid: a\norigin: not json\n---\nx').origin, null)
    assert.deepEqual(ledger.cleanOrigin({ vault_id: 'v', vault_name: 'N', slide_id: 's', talk: 't', outline: '/x', inserted_by: ' ' }), { vault_id: 'v', vault_name: 'N', slide_id: 's' }, 'only the whitelisted fields survive')
    const long = 'N'.repeat(300)
    const cleaned = ledger.cleanOrigin({ vault_id: 'v', vault_name: `Evil\n---\noutline: /x\u0007${long}`, slide_id: 's\r\n', inserted_by: 'A\tB' })
    assert.ok(!/[\u0000-\u001f]/.test(JSON.stringify(Object.values(cleaned))), 'no control characters or newlines survive')
    assert.ok(cleaned.vault_name.length <= 200 && cleaned.vault_name.startsWith('Evil --- outline'), cleaned.vault_name.slice(0, 40))
    assert.equal(ledger.formatVersion({ id: 'a', talk: 't', outline: 'o', savedAt: 0, origin: cleaned, markdown: '### A' }).split('\n').filter((l) => l.startsWith('origin:')).length, 1)
  })

  await test('S3: a promised origin survives a refused save and a restart (rebuilt from the private record)', async () => {
    const v = makeVaults('restart')
    const file = path.join(tmp, 'userData-restart', 'provenance.json')
    const r = await prepareCrossVaultInsert({ source: v.source, target: v.target, sourceOutlinePath: v.srcOutline, sourceTalkTitle: 'Metaphor talk 2026', markdown: '### Carried over {id=car01}\n\nText.', insertedBy: 'Dominik Lukeš' }, tools, quiet)
    const slide = r.slides[0]
    createProvenanceStore(file).record(v.target.id, slide.id, slide.privateRecord)
    // The session's promise is gone (the save was refused, the app restarted): a fresh store, no pending.
    const hints = originHintsFor(v.target.id, null, createProvenanceStore(file))
    const text = fs.readFileSync(v.dstOutline, 'utf8') + '\n' + r.markdown + '\n'
    fs.writeFileSync(v.dstOutline, text)
    ledger.recordOutlineSave(v.dst, v.dstOutline, text, { originHints: hints })
    assert.deepEqual(ledger.slideOrigin(v.dst, slide.id).origin, { vault_id: v.source.id, vault_name: 'Personal', slide_id: 'car01', inserted_by: 'Dominik Lukeš' })
    assert.equal(ledger.slideOrigin(v.dst, 'zzz99'), null, 'an id with no private record gets no origin')
    const body = fs.readdirSync(path.join(v.dst, '_SLIDE-VERSIONS', slide.id)).map((f) => fs.readFileSync(path.join(v.dst, '_SLIDE-VERSIONS', slide.id, f), 'utf8')).join('\n')
    for (const leak of [v.src, 'Metaphor talk 2026', 'lectures-private']) assert.ok(!body.includes(leak), `rebuilt origin must not carry ${leak}`)
    let reads = 0
    const counting = { entries: () => { reads += 1; return createProvenanceStore(file).entries() } }
    const once = originHintsFor(v.target.id, null, counting)
    once.get(slide.id); once.get('nope1'); once.get('nope2')
    assert.equal(reads, 1, 'provenance.json is read once per save, not per id')
    const promised = { vault_id: 'x', vault_name: 'X', slide_id: 'p' }
    assert.equal(originHintsFor(v.target.id, new Map([['car01', promised]]), createProvenanceStore(file)).get('car01'), promised, 'a session promise wins')
  })

  await test('private provenance lives in app data keyed by <targetVaultId>/<slideId>', () => {
    const store = createProvenanceStore(path.join(tmp, 'userData', 'provenance.json'))
    const rec = { source_vault_id: 's', source_vault_name: 'Personal', source_slide_id: 'abc12', source_talk_title: 'Metaphor talk 2026', source_outline_path: '/x/y-outline.md', inserted_at: '2026-09-30T09:31:00.000Z' }
    store.record('dst', 'n3w01', rec)
    assert.deepEqual(store.get('dst', 'n3w01'), rec)
    assert.equal(store.get('other', 'n3w01'), null)
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'provenance.json'), 'utf8')).entries['dst/n3w01'])
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`${passed} passed`)
