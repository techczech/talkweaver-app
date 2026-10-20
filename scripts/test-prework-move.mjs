// Work-files ticket 28: "Move to a work file" for a retired {prework} section.
//   1. The plan (src/shared/prework-move.ts): section -> work file + metadata, every step id and {right}
//      kept, {results=<step>} slides pointed at the file, the section gone, the file named without a clash;
//   2. the refusals (no section, no steps, the talk already names a file);
//   3. the write (src/main/prework-move.ts): the file and the outline both written; if the outline write
//      fails the new file is kept and named (never deleted); if the file cannot be written the outline is
//      never touched; a retried transformation leaves one file; nothing is ever overwritten;
//   4. the compiler notes the section once (prework-section-retired) and not after the move;
//   5. the demo vault's pre-work workshop uses work files and compiles clean;
//   6. review round 1: the work file is kept when the editor took the move but its save failed or was not
//      confirmed; the handler's outline guard; compiler-resolved ids for unstamped steps; every results token
//      form; no rewriting outside slide headings and Trigger blocks; the intro keeps its code fences;
//   7. review round 2: the move never deletes a work file (a refused save keeps it and says so; a retry
//      never touches a replacement; a retry with unchanged content reuses the one file); a results
//      attribute on a line that also holds a comment is rewritten, the comment kept as written.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-prework-move.mjs
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPreworkMove, hasPreworkSection } from '../src/shared/prework-move.ts'
import { readWorkFile } from '../src/shared/work-file.ts'
import { movePreworkToWorkFile } from '../src/main/prework-move.ts'
import { preworkFromOutline } from '../compiler/scripts/lib/prework.mjs'
import { adaptMarkdownOutlineV2, prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { configureTalkWriter, writeTalkOutline } from '../src/main/talk-writer.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { outlineInVault } from '../src/main/vault-paths.ts'
import { formatWarning } from '../compiler/scripts/lib/warning-registry.mjs'

let n = 0
const t = async (name, fn) => { await fn(); n += 1; console.log(`PASS  ${name}`) }
// The compiler's reading of the steps, as index.ts passes it (adaptMarkdownOutlineV2's prework.steps).
const compileSteps = (text) => adaptMarkdownOutlineV2(text, 'talk', undefined)?.prework?.steps ?? null
const ctxFor = (outline, extra = {}) => ({ existingFileNames: [], existingIds: [], compiledSteps: compileSteps(outline), ...extra })
const planFor = (outline, extra) => planPreworkMove(outline, ctxFor(outline, extra))

const OUTLINE = [
  '---', 'title: "Agents **in practice**"', 'author: A', '---', '# Agents', '',
  '## Before the session', '{id=pwform}{prework}', '',
  'Short steps to do first.', '',
  '### Welcome', '{id=welcome}{task}{readonly}', '', '- Read this', '',
  '### Quick check', '{poll=single}{id=quiz}{check}', '', '- Wrong', '- Right one {right}', '',
  '### Hopes', '{poll=open}{id=hopes}', '',
  '## Opening', '{id=open}', '',
  '```', '## Not a heading {prework}', '```', '',
  '### Results', '{id=quizresults}{results=quiz}', '',
  '### Board', '{poll=board}{results=hopes}{id=hopesboard}', '', '- A', '- B', '',
  '### Other file', '{id=other}{results=somefile/step-1}', '',
].join('\n')

await t('the plan: file, metadata, ids and {right} kept, results slides follow, section gone', () => {
  const plan = planFor(OUTLINE)
  assert.equal(plan.ok, true)
  assert.equal(plan.id, 'agents-in-practice-pre-work')
  assert.equal(plan.fileName, 'agents-in-practice-pre-work.md')
  const read = readWorkFile(plan.workFileText)
  assert.equal(read.definition.id, plan.id)
  assert.equal(read.definition.title, 'Agents in practice pre-work')
  assert.equal(read.definition.revision, 1)
  assert.equal(read.definition.intro, 'Short steps to do first.')
  assert.deepEqual(read.definition.steps.map((s) => [s.id, s.kind]), [['welcome', 'task'], ['quiz', 'check'], ['hopes', 'question']])
  assert.deepEqual(plan.stepIds, ['welcome', 'quiz', 'hopes'])
  assert.deepEqual(read.definition.steps[1].right, { index: 1, label: 'Right one' }, 'the {right} mark is kept')
  assert.ok(plan.workFileText.includes('- Right one {right}'), '{right} stays in the file text')
  assert.deepEqual(read.findings.filter((f) => f.severity === 'blocking'), [])
  assert.equal(preworkFromOutline(plan.outline), null, 'no {prework} section is left')
  assert.ok(plan.outline.includes('prework: agents-in-practice-pre-work'), 'the talk names the file')
  assert.ok(plan.outline.includes('{results=agents-in-practice-pre-work/quiz}'))
  assert.ok(plan.outline.includes('{results=agents-in-practice-pre-work/hopes}'))
  assert.ok(plan.outline.includes('{results=somefile/step-1}'), 'a results token for another file is left alone')
  assert.ok(plan.outline.includes('## Not a heading {prework}'), 'text in a code fence is not a section')
  assert.ok(!plan.outline.includes('Short steps to do first') && !plan.outline.includes('### Welcome'))
  assert.ok(plan.outline.includes('author: A\nprework: agents-in-practice-pre-work\n---'), 'only prework: is added to the front matter')
  // A heading-looking line inside a code fence of the section does not end it.
  const fenced = planFor('## Before\n{prework}\n\n### A\n{id=a}\n\n```\n## no\n```\n\n### B\n{id=b}\n\n## After\n{id=after}\n')
  assert.deepEqual(fenced.stepIds, ['a', 'b'])
  assert.ok(fenced.outline.includes('## After') && !fenced.outline.includes('## no'))
})

await t('a step with no id gets the compiler id; a repeated title gets a unique one', () => {
  const plan = planFor('## Before\n{prework}\n\n### Read this\n\nText\n\n### Read this\n{id=read-this}\n\n### Read this\n')
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.stepIds, ['read-this-2', 'read-this', 'read-this-3'])
  const read = readWorkFile(plan.workFileText)
  assert.deepEqual(read.definition.steps.map((s) => s.id), plan.stepIds)
  assert.equal(read.findings.filter((f) => f.code.startsWith('work-file-step-id')).length, 0)
})

await t('the name never clashes with a file name or an id', () => {
  const plan = planFor(OUTLINE, { existingFileNames: ['Agents-In-Practice-Pre-Work.md'], existingIds: ['agents-in-practice-pre-work-2'] })
  assert.equal(plan.id, 'agents-in-practice-pre-work-3')
})

await t('the talk\'s details: prework: true is replaced, no front matter gets one, CRLF is kept', () => {
  const flag = planFor(OUTLINE.replace('author: A', 'author: A\nprework: true'))
  assert.ok(flag.outline.includes('prework: agents-in-practice-pre-work') && !flag.outline.includes('prework: true'))
  const bare = planFor('# T\n\n## Before\n{prework}\n\n### A\n{id=a}{task}\n')
  assert.ok(bare.outline.startsWith('---\nprework: t-pre-work\n---\n\n# T'))
  const crlf = planFor(OUTLINE.replace(/\n/g, '\r\n'))
  assert.equal(crlf.ok, true)
  assert.deepEqual(crlf.stepIds, ['welcome', 'quiz', 'hopes'])
  assert.equal(preworkFromOutline(crlf.outline), null)
  assert.ok(crlf.outline.includes('\r\n## Opening') && !/[^\r]\n/.test(crlf.outline.slice(0, 40)))
})

await t('refusals say why and plan nothing', () => {
  assert.match(planFor('## A\n{id=a}\n\n### B\n').error, /no pre-work section/)
  assert.match(planFor('## Before\n{prework}\n\nJust an intro.\n').error, /no steps/)
  const named = planFor('---\nprework: "Intake.md"\n---\n## Before\n{prework}\n\n### A\n{id=a}\n')
  assert.match(named.error, /already names the work file “Intake”/)
  assert.equal(hasPreworkSection('## A\n'), false)
  assert.equal(hasPreworkSection(OUTLINE), true)
})

// ── The write ────────────────────────────────────────────────────────────────────────────────
function vaultWith(outline) {
  const root = mkdtempSync(join(tmpdir(), 'tw-prework-move-'))
  const talk = join(root, 'agents'); mkdirSync(talk)
  const outlinePath = join(talk, 'agents-outline.md')
  writeFileSync(outlinePath, outline)
  return { root, outlinePath }
}
/** A stand-in for writeTalkOutline: runs the transformation on the file and writes the result (or refuses). */
const diskWriter = (opts = {}) => async (path, next) => {
  const current = readFileSync(path, 'utf8')
  const attempts = opts.attempts ?? 1
  let text = current
  try {
    for (let i = 0; i < attempts; i += 1) text = typeof next === 'function' ? next(current) : next
  } catch (error) { return { ok: false, error: error.message } }
  if (opts.refuse) return { ok: false, error: opts.refuse, untouched: true }
  if (opts.applyThenFail) { writeFileSync(path, text); return { ok: false, error: opts.applyThenFail } }
  writeFileSync(path, text)
  return { ok: true, via: 'disk', changed: text !== current, text }
}

await t('a move writes the file and the outline; ids, {right} and the intro are in the file', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter(), compileSteps)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.relPath, 'Work files/agents-in-practice-pre-work.md')
  const file = readFileSync(join(root, result.relPath), 'utf8')
  assert.deepEqual(readWorkFile(file).definition.steps.map((s) => s.id), ['welcome', 'quiz', 'hopes'])
  assert.ok(file.includes('- Right one {right}'))
  const outline = readFileSync(outlinePath, 'utf8')
  assert.equal(preworkFromOutline(outline), null)
  assert.ok(outline.includes('prework: agents-in-practice-pre-work'))
  // The same move again has nothing to move and writes nothing new.
  const again = await movePreworkToWorkFile(root, outlinePath, diskWriter(), compileSteps)
  assert.equal(again.ok, false)
  assert.deepEqual(readdirSync(join(root, 'Work files')), ['agents-in-practice-pre-work.md'])
})

await t('a refused outline write keeps the new file and names it; the section stays', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter({ refuse: 'The talk changed on disk.' }), compileSteps)
  assert.deepEqual(result, {
    ok: false,
    keptFile: 'Work files/agents-in-practice-pre-work.md',
    error: 'The talk changed on disk. The talk was not changed and its section stays. The work file “Work files/agents-in-practice-pre-work.md” that was made for the move is left in place; you can delete it.',
  })
  assert.equal(readFileSync(outlinePath, 'utf8'), OUTLINE)
  assert.deepEqual(readdirSync(join(root, 'Work files')), ['agents-in-practice-pre-work.md'])
})

await t('a retried transformation leaves one file', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter({ attempts: 3 }), compileSteps)
  assert.equal(result.ok, true)
  assert.deepEqual(readdirSync(join(root, 'Work files')), ['agents-in-practice-pre-work.md'])
})

await t('an existing work file of that name is never overwritten: the new file takes another name', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  mkdirSync(join(root, 'Work files'))
  const mine = '---\nid: agents-in-practice-pre-work\ntitle: Mine\nrevision: 4\n---\n\n### Mine\n{id=m}\n'
  writeFileSync(join(root, 'Work files', 'agents-in-practice-pre-work.md'), mine)
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter(), compileSteps)
  assert.equal(result.ok, true)
  assert.equal(result.fileName, 'agents-in-practice-pre-work-2.md')
  assert.equal(readFileSync(join(root, 'Work files', 'agents-in-practice-pre-work.md'), 'utf8'), mine)
  assert.ok(readFileSync(outlinePath, 'utf8').includes('prework: agents-in-practice-pre-work-2'))
})

await t('when the work file cannot be written the outline writer is not asked to change anything', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const elsewhere = mkdtempSync(join(tmpdir(), 'tw-prework-move-out-'))
  symlinkSync(elsewhere, join(root, 'Work files'))
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter(), compileSteps)
  assert.equal(result.ok, false)
  assert.match(result.error, /not a folder inside this vault/)
  assert.equal(readFileSync(outlinePath, 'utf8'), OUTLINE, 'the section stays')
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link')
})

await t('a talk with no section changes nothing and says so', async () => {
  const { root, outlinePath } = vaultWith('## A\n{id=a}\n\n### B\n')
  const before = statSync(outlinePath).mtimeMs
  const result = await movePreworkToWorkFile(root, outlinePath, diskWriter(), compileSteps)
  assert.equal(result.ok, false)
  assert.match(result.error, /no pre-work section/)
  assert.equal(statSync(outlinePath).mtimeMs, before)
  assert.equal(existsSync(join(root, 'Work files')), false, 'no folder is made for a move that does not happen')
})

// ── The compiler's note ─────────────────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'tw-prework-move-compile-'))
const scratchOutline = join(scratch, 'x-outline.md')
writeFileSync(scratchOutline, '# x\n')
const compile = async (text) => prepareSource(scratchOutline, text, 'x', statSync(scratchOutline), undefined, { projectionsOnly: true })
await t('the compiler notes a {prework} section once, in the registry\'s words; not after the move', async () => {
  const model = await compile(OUTLINE)
  assert.deepEqual(model.warnings.filter((w) => w.startsWith('prework-section-retired')), ['prework-section-retired:pwform'])
  assert.match(formatWarning('prework-section-retired:pwform'), /^Pre-work now lives in a work file\./)
  const after = await compile(planFor(OUTLINE).outline)
  assert.deepEqual(after.warnings.filter((w) => w.startsWith('prework')), [])
})

// ── Review round 1 (Sol): one check per finding, each the reviewer's case ───────────────────
// 1. Rollback only when nothing was applied anywhere. Through the real writer and the real editor mutator.
function openInEditor(outlinePath, { saveFails = false, typesOnEveryApply = false } = {}) {
  let text = readFileSync(outlinePath, 'utf8')
  const buffer = { read: () => text, apply: (_p, next) => { text = next; return text }, adopt() {} }
  const mutator = createOutlineMutator({
    bufferFor: (p) => (p === outlinePath ? buffer : null),
    settled: async () => {},
    write: async (_p, next) => (saveFails ? { ok: false } : (writeFileSync(outlinePath, next), { ok: true, content: next })),
  })
  configureTalkWriter({
    editorBufferFor: (p) => p !== outlinePath ? null : {
      async read() { const reply = await mutator.readForMain(p); if (!reply.ok) throw new Error(reply.error); return reply.text },
      async commit(base, next, origin) {
        if (typesOnEveryApply) text += '\nTyped.'
        const reply = await mutator.applyFromMain(p, base, next, origin)
        return reply.ok ? { ok: true, text: reply.text } : { ok: false, error: reply.error, moved: reply.moved === true }
      },
    },
  })
  return { buffer: () => text }
}
const closeEditors = () => configureTalkWriter({ editorBufferFor: () => null })

await t('review 1: the editor took the move but its save failed: the work file is kept and the reply says so', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const editor = openInEditor(outlinePath, { saveFails: true })
  try {
    const result = await movePreworkToWorkFile(root, outlinePath, writeTalkOutline, compileSteps)
    assert.equal(result.ok, false)
    assert.equal(result.keptFile, 'Work files/agents-in-practice-pre-work.md')
    assert.match(result.error, /^The work file “Work files\/agents-in-practice-pre-work\.md” was made, but the talk’s outline was not saved: .* The work file is kept/)
    assert.ok(editor.buffer().includes('prework: agents-in-practice-pre-work'), 'the buffer holds the moved outline')
    assert.ok(existsSync(join(root, result.keptFile)), 'so the file it names is still there')
    assert.equal(readFileSync(outlinePath, 'utf8'), OUTLINE, 'nothing reached the disk')
  } finally { closeEditors() }
})

await t('review 1: the buffer kept moving (nothing applied): the one work file is kept and named', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const editor = openInEditor(outlinePath, { typesOnEveryApply: true })
  try {
    const result = await movePreworkToWorkFile(root, outlinePath, writeTalkOutline, compileSteps)
    assert.equal(result.ok, false)
    assert.equal(result.keptFile, 'Work files/agents-in-practice-pre-work.md')
    assert.match(result.error, /The talk was not changed and its section stays\. The work file “Work files\/agents-in-practice-pre-work\.md” that was made for the move is left in place/)
    assert.deepEqual(readdirSync(join(root, 'Work files')), ['agents-in-practice-pre-work.md'], 'each retry reused the same file')
    assert.ok(!editor.buffer().includes('prework: agents'), 'the buffer was never changed by the move')
  } finally { closeEditors() }
})

await t('review 1: an unconfirmed save (no reply from the window) keeps the file; so does a refused disk write', async () => {
  const unconfirmed = vaultWith(OUTLINE)
  configureTalkWriter({ editorBufferFor: (p) => p !== unconfirmed.outlinePath ? null : {
    async read() { return OUTLINE },
    async commit() { return { ok: false, error: 'The editor window with this talk did not confirm the save of the move to a work file.' } },
  } })
  try {
    const result = await movePreworkToWorkFile(unconfirmed.root, unconfirmed.outlinePath, writeTalkOutline, compileSteps)
    assert.equal(result.ok, false)
    assert.ok(existsSync(join(unconfirmed.root, result.keptFile)))
  } finally { closeEditors() }
  const readOnly = vaultWith(OUTLINE)
  chmodSync(readOnly.outlinePath, 0o444)
  try {
    const result = await movePreworkToWorkFile(readOnly.root, readOnly.outlinePath, writeTalkOutline, compileSteps)
    assert.equal(result.ok, false)
    assert.equal(result.keptFile, 'Work files/agents-in-practice-pre-work.md')
    assert.deepEqual(readdirSync(join(readOnly.root, 'Work files')), ['agents-in-practice-pre-work.md'], 'no byte reached the outline; the file is still kept')
    assert.equal(readFileSync(readOnly.outlinePath, 'utf8'), OUTLINE)
  } finally { chmodSync(readOnly.outlinePath, 0o644) }
  const landed = vaultWith(OUTLINE)
  const kept = await movePreworkToWorkFile(landed.root, landed.outlinePath, diskWriter({ applyThenFail: 'The talk’s file was replaced while writing.' }), compileSteps)
  assert.ok(existsSync(join(landed.root, kept.keptFile)), 'a write that may have landed keeps the file')
})

// 2. The IPC handler takes the outline-writing guard: real-path containment and *-outline.md.
await t('review 2: an outline that is a link to a file outside the vault is refused by the handler\'s guard', () => {
  const { root } = vaultWith(OUTLINE)
  const outside = mkdtempSync(join(tmpdir(), 'tw-prework-move-outside-'))
  writeFileSync(join(outside, 'target-outline.md'), OUTLINE)
  symlinkSync(join(outside, 'target-outline.md'), join(root, 'linked-outline.md'))
  assert.equal(outlineInVault(root, join(root, 'linked-outline.md')).ok, false, 'a link out of the vault')
  writeFileSync(join(root, 'notes.md'), OUTLINE)
  assert.equal(outlineInVault(root, join(root, 'notes.md')).ok, false, 'not an *-outline.md')
  assert.equal(outlineInVault(root, join(root, 'agents', 'agents-outline.md')).ok, true)
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  const from = src.indexOf("ipcMain.handle('work-files:move-prework'")
  const handler = src.slice(from, src.indexOf('\n})', from))
  assert.ok(from > 0 && /outlineRefused\(outlinePath\)/.test(handler), 'the handler calls the outline guard')
  assert.ok(handler.indexOf('outlineRefused(outlinePath)') < handler.indexOf('movePreworkToWorkFile('), 'before anything is written')
})

// ── Review round 2 (Sol) ────────────────────────────────────────────────────────────────────
// 1. The move never deletes a work file.
/** A writer that runs the transformation, lets `meanwhile` act on the made file, then (optionally) runs it again. */
const meddlingWriter = (meanwhile, { retry = false, refuse = false } = {}) => async (path, next) => {
  const current = readFileSync(path, 'utf8')
  let text = next(current)
  meanwhile()
  if (retry) text = next(current)
  if (refuse) return { ok: false, error: 'The talk changed on disk.', untouched: true }
  writeFileSync(path, text)
  return { ok: true, via: 'disk', changed: true, text }
}
await t('round 2: a refused save leaves the work file in place (even one edited meanwhile) and reports it', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const made = join(root, 'Work files', 'agents-in-practice-pre-work.md')
  const edit = () => writeFileSync(made, readFileSync(made, 'utf8') + '\nEdited elsewhere.\n')
  const result = await movePreworkToWorkFile(root, outlinePath, meddlingWriter(edit, { refuse: true }), compileSteps)
  assert.equal(result.ok, false)
  assert.equal(result.keptFile, 'Work files/agents-in-practice-pre-work.md')
  assert.match(result.error, /^The talk changed on disk\. .*“Work files\/agents-in-practice-pre-work\.md”.* left in place/)
  assert.ok(readFileSync(made, 'utf8').endsWith('Edited elsewhere.\n'), 'the file is left as it is')
  assert.equal(readFileSync(outlinePath, 'utf8'), OUTLINE)
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'prework-move.ts'), 'utf8')
  assert.ok(!/\b(rmSync|unlinkSync|rm|unlink)\(/.test(src), 'the move has no delete call')
})
await t('round 2: a retry after another program replaced the file never touches the replacement', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const made = join(root, 'Work files', 'agents-in-practice-pre-work.md')
  const theirs = '---\nid: theirs\ntitle: Theirs\nrevision: 1\n---\n\n### Theirs\n{id=t}\n'
  const replace = () => { writeFileSync(join(root, 'Work files', '.swap'), theirs); renameSync(join(root, 'Work files', '.swap'), made) }
  const result = await movePreworkToWorkFile(root, outlinePath, meddlingWriter(replace, { retry: true }), compileSteps)
  assert.equal(result.ok, true, result.error)
  assert.equal(readFileSync(made, 'utf8'), theirs, 'the replacement survives the retry')
  assert.equal(result.fileName, 'agents-in-practice-pre-work-2.md', 'the retry made its own file beside it')
  assert.deepEqual(result.keptFiles, ['Work files/agents-in-practice-pre-work.md'], 'the earlier file is reported as kept')
  assert.ok(readFileSync(outlinePath, 'utf8').includes('prework: agents-in-practice-pre-work-2'))
})
await t('round 2: a retry with unchanged content reuses the one file; changed content takes the next name', async () => {
  const { root, outlinePath } = vaultWith(OUTLINE)
  const result = await movePreworkToWorkFile(root, outlinePath, meddlingWriter(() => {}, { retry: true }), compileSteps)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.fileName, 'agents-in-practice-pre-work.md')
  assert.equal(result.keptFiles, undefined)
  assert.deepEqual(readdirSync(join(root, 'Work files')), ['agents-in-practice-pre-work.md'])
  // The section's text changed between attempts: the earlier file is kept, the new one has the next name.
  const changed = vaultWith(OUTLINE)
  let calls = 0
  const writer = async (path, next) => {
    const first = readFileSync(path, 'utf8')
    next(first)
    const edited = first.replace('Short steps to do first.', 'Short steps to do first, please.')
    writeFileSync(path, edited)
    const text = next(edited); calls += 1
    writeFileSync(path, text)
    return { ok: true, via: 'disk', changed: true, text }
  }
  const second = await movePreworkToWorkFile(changed.root, changed.outlinePath, writer, compileSteps)
  assert.equal(calls, 1)
  assert.equal(second.ok, true, second.error)
  assert.equal(second.fileName, 'agents-in-practice-pre-work-2.md')
  assert.deepEqual(second.keptFiles, ['Work files/agents-in-practice-pre-work.md'])
  assert.ok(readFileSync(join(changed.root, 'Work files', second.fileName), 'utf8').includes('first, please.'))
})

// 2. A results attribute beside a comment on the same line.
await t('round 2: a heading or Trigger line with a comment is rewritten outside the comment; a commented-out results stays', async () => {
  const outline = [
    '# T', '', '## Before', '{prework}', '', '### Quiz', '{id=quiz}{poll=single}{check}', '', '- A {right}', '- B', '',
    '## After', '{id=after}', '',
    '### Board {poll=board}{results=quiz} <!-- facilitator note {results=quiz} -->', '',
    '### Second', '{id=second}{poll=board}{results=quiz} <!-- note -->', '',
    '### Third', '{id=third}', '', '<!-- {results=quiz} -->', '',
  ].join('\n')
  const before = await compile(outline)
  assert.ok(!before.warnings.some((w) => /^prework-results-unknown/.test(w)), 'the compiler resolves both before the move')
  const p = planFor(outline)
  assert.equal(p.ok, true, p.error)
  assert.ok(p.outline.includes(`### Board {poll=board}{results=${p.id}/quiz} <!-- facilitator note {results=quiz} -->`), p.outline)
  assert.ok(p.outline.includes(`{id=second}{poll=board}{results=${p.id}/quiz} <!-- note -->`), p.outline)
  assert.ok(p.outline.includes('<!-- {results=quiz} -->\n'), 'a commented-out results stays literal')
  assert.equal(p.outline.split(`${p.id}/quiz`).length - 1, 2)
  const after = await compile(p.outline)
  assert.deepEqual(after.warnings.filter((w) => /^prework-results/.test(w)), [])
})

// 4. An unstamped step takes the id the compiler resolved across the whole talk.
await t('review 4: earlier slide {id=quiz}, unstamped step "Quiz": stamped quiz-2, {results=quiz-2} follows it', () => {
  const outline = '# T\n\n## Intro\n{id=quiz}\n\nHello\n\n## Before\n{prework}\n\n### Quiz\n{poll=open}\n\nWhat do you hope?\n\n## Results\n{id=res}{poll=board}{results=quiz-2}\n'
  assert.deepEqual(compileSteps(outline).map((s) => s.id), ['quiz-2'], 'the compiler calls the step quiz-2')
  const p = planFor(outline)
  assert.equal(p.ok, true, p.error)
  assert.deepEqual(p.stepIds, ['quiz-2'])
  assert.ok(p.workFileText.includes('### Quiz\n{poll=open}\n{id=quiz-2}\n'), 'stamped under the step\'s Trigger block')
  assert.deepEqual(readWorkFile(p.workFileText).definition.steps.map((s) => [s.id, s.kind]), [['quiz-2', 'question']])
  assert.ok(p.outline.includes(`{id=res}{poll=board}{results=${p.id}/quiz-2}`))
  assert.ok(p.outline.includes('## Intro\n{id=quiz}\n'), 'the other slide is untouched')
})

// 5. Every results token form the compiler reads is rewritten.
await t('review 5: {poll=board results=quiz} and {results="quiz"} are rewritten to the file form', async () => {
  const outline = '# T\n\n## Before\n{prework}\n\n### Quiz\n{id=quiz}{poll=single}{check}\n\n- A {right}\n- B\n\n## After\n{id=after}\n\n### One {poll=board results=quiz}\n\n### Two\n{poll=board}{results="quiz"}\n\n### Three\n{id=three}\n{poll=board, results:quiz}\n'
  const p = planFor(outline)
  assert.equal(p.ok, true, p.error)
  assert.ok(p.outline.includes(`### One {poll=board results=${p.id}/quiz}`))
  assert.ok(p.outline.includes(`{poll=board}{results=${p.id}/quiz}`))
  assert.ok(p.outline.includes(`{poll=board, results=${p.id}/quiz}`))
  const model = await compile(p.outline)
  assert.deepEqual(model.warnings.filter((w) => /^prework-results/.test(w)), [])
  assert.deepEqual(preworkFromOutline(outline) && preworkFromOutline(p.outline), null)
})

// 6. Only authored results attributes of the talk body are rewritten.
await t('review 6: front matter, comments, inline code and fenced code keep a literal {results=quiz}', () => {
  const outline = [
    '---', 'title: T', 'description: "Write {results=quiz} on a slide"', '---', '# T', '',
    '## Before', '{prework}', '', '### Quiz', '{id=quiz}{poll=open}', '',
    '## After', '{id=after}', '', 'Write `{results=quiz}` on a board slide.', '',
    '<!-- {results=quiz} -->', '', '<!--', '### Old {results=quiz}', '-->', '',
    '```', '{results=quiz}', '```', '',
    '### Board', '{poll=board}{results=quiz}', '',
  ].join('\n')
  const p = planFor(outline)
  assert.equal(p.ok, true, p.error)
  assert.ok(p.outline.includes('description: "Write {results=quiz} on a slide"'), 'front matter')
  assert.ok(p.outline.includes('Write `{results=quiz}` on a board slide.'), 'inline code')
  assert.ok(p.outline.includes('<!-- {results=quiz} -->') && p.outline.includes('### Old {results=quiz}'), 'comments')
  assert.ok(p.outline.includes('```\n{results=quiz}\n```'), 'fenced code')
  assert.ok(p.outline.includes(`{poll=board}{results=${p.id}/quiz}`), 'the board slide itself')
  assert.equal(p.outline.split(`${p.id}/quiz`).length - 1, 1, 'and nothing else')
})

// 7. The intro keeps all its content; only the section's own Trigger block goes.
await t('review 7: brace-only lines in the intro\'s code fence are kept', () => {
  const outline = '# T\n\n## Before\n{id=pw}{prework}\n\nRead this first.\n\n```text\n{keep-this}\n```\n\n### Step\n{id=step}\n'
  const p = planFor(outline)
  assert.equal(p.ok, true, p.error)
  assert.ok(p.workFileText.includes('Read this first.\n\n```text\n{keep-this}\n```\n\n### Step'), p.workFileText)
  assert.ok(!p.workFileText.includes('{prework}') && !p.workFileText.includes('{id=pw}'), 'the section\'s Trigger block is not in the file')
})

// ── The demo vault ──────────────────────────────────────────────────────────────────────────
await t('the demo vault\'s pre-work workshop names a pre-work and a post-work file, and compiles clean', async () => {
  const demo = join(import.meta.dirname, '..', 'demo-vault')
  const outline = readFileSync(join(demo, 'pre-work-workshop', 'pre-work-workshop-outline.md'), 'utf8')
  assert.equal(preworkFromOutline(outline), null, 'no {prework} section')
  assert.match(outline, /^prework: pre-work-workshop-intake$/m)
  assert.match(outline, /^postwork: pre-work-workshop-after$/m)
  const intake = readWorkFile(readFileSync(join(demo, 'Work files', 'pre-work-workshop-intake.md'), 'utf8'))
  assert.equal(intake.definition.id, 'pre-work-workshop-intake')
  assert.deepEqual(intake.definition.steps.map((s) => s.id), ['pwwelcome', 'pwquiz', 'pwtools', 'pwhope', 'pwtask'])
  assert.deepEqual(intake.findings, [], 'the intake file has no findings')
  assert.deepEqual(intake.definition.steps[1].right, { index: 1, label: 'It uses tools to carry out steps on its own' })
  const after = readWorkFile(readFileSync(join(demo, 'Work files', 'pre-work-workshop-after.md'), 'utf8'))
  assert.equal(after.definition.id, 'pre-work-workshop-after')
  assert.deepEqual(after.definition.steps.map((s) => s.id), ['what-learnt', 'will-try'])
  assert.deepEqual(after.findings, [])
  for (const id of ['pwquiz', 'pwtools', 'pwhope']) assert.ok(outline.includes(`{results=pre-work-workshop-intake/${id}}`), `${id} results resolve to the file`)
  const model = await compile(outline)
  assert.deepEqual(model.warnings.filter((w) => /^(prework|results|unknown-trigger|unresolved-trigger)/.test(w)), [])
})

console.log(`prework-move: ${n} checks passed`)
