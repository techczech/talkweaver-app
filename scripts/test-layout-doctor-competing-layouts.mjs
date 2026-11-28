import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { history, undo, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { findSlideSections } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { renderQuoteSourcesTag } from '../compiler/scripts/lib/quote-forms-static.mjs'
import { renderSlideScriptTag } from '../compiler/scripts/lib/slide-script.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { loadCompiledSlidesSignature } from '../src/main/compiled-slides-match.ts'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'
import { outlineSaveChange } from '../src/shared/outline-save-changes.ts'
import { competingLayoutFindings, planCompetingLayoutRepair } from '../src/shared/competing-layout-repair.ts'
import { applyCompetingLayoutRepair } from '../src/renderer/src/lib/competingLayoutRepair.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { replaceDocTransaction } from '../src/renderer/src/lib/replaceDocTransaction.ts'

const before = '# Fixture\n\n## Example\n{table table-header=off}{contrast contrast=rows}{id=3c1f}{from=sample}{tags=demo,team}{my-tag}\n\n- First\n- Second\n'
const after = before.replace('{table table-header=off}', '{table-header=off}')
const compile = text => prepareSource('/tmp/doctor-layout-fixture.md', text, 'Fixture')
const signature = await loadCompiledSlidesSignature(fileURLToPath(new URL('../compiler/scripts/', import.meta.url)))
function compiledSlidesMatch(before, after) {
  const original = signature(before)
  return original !== null && original === signature(after)
}
const verify = async (base, next) => compiledSlidesMatch(await compile(base), await compile(next))

function editor(initial) {
  let state = EditorState.create({ doc: initial, extensions: history() })
  const writes = []
  const repairSaves = []
  const put = (text, options) => { state = state.update(replaceDocTransaction(state.doc.toString(), text, options)).state }
  const apply = createOutlineMutator({
    bufferFor: path => path === 'fixture' ? {
      read: () => state.doc.toString(),
      apply: (_path, next, options) => { put(next, options); return state.doc.toString() },
      adopt: () => {}
    } : null,
    settled: async () => {},
    write: async (_path, text, scope) => {
      writes.push(text)
      if (scope) repairSaves.push(scope)
      return { ok: true }
    }
  }).apply
  return { apply, put, writes, repairSaves, get state() { return state }, undo: () => undo({
    state, dispatch: transaction => { state = transaction.state }
  }) }
}

test('Doctor names the drawn layout and the ignored kind, then previews the exact change', () => {
  const [finding, ...rest] = competingLayoutFindings(before)
  assert.equal(rest.length, 0)
  assert.equal(finding.kind, 'competing-layouts')
  assert.match(finding.detail, /Drawn as Contrast.*Ignored.*Table/)
  const plan = planCompetingLayoutRepair(before, finding.headingLine)
  assert.equal(plan.ok, true)
  assert.equal(plan.text, after)
  assert.deepEqual(plan.lines, [{
    line: 4,
    before: before.split('\n')[3],
    after: after.split('\n')[3]
  }])
  assert.equal(competingLayoutFindings(after).length, 0)
})

test('the confirmed edit compiles identically and one Undo restores the exact source', async () => {
  const doc = editor(before.replace('Second', 'Second item'))
  doc.put(before)
  const plan = planCompetingLayoutRepair(before, 3)
  assert.equal(plan.ok, true)
  let verified = 0
  const reply = await applyCompetingLayoutRepair(doc.apply, 'fixture', before, plan, async (base, next) => {
    verified += 1
    assert.equal(base, before)
    assert.equal(next, after)
    const [original, repaired] = await Promise.all([compile(base), compile(next)])
    const sections = model => findSlideSections(model.fullHtml).map(section => section.html)
    assert.deepEqual(sections(repaired), sections(original))
    assert.equal(compiledSlidesMatch(original, repaired), true)
    return true
  })
  assert.equal(reply, null)
  assert.equal(verified, 1)
  assert.deepEqual(doc.writes, [after])
  assert.equal(doc.state.doc.toString(), after)
  assert.equal(undoDepth(doc.state), 2)
  assert.equal(doc.undo(), true)
  assert.equal(doc.state.doc.toString(), before)
  assert.equal(undoDepth(doc.state), 1)
})

test('a different compiled section or a changed preview base prevents a write', async () => {
  const plan = planCompetingLayoutRepair(before, 3)
  assert.equal(plan.ok, true)
  const doc = editor(before)
  const changed = await verify(before, after.replace('First', 'Changed'))
  assert.equal(changed, false)
  assert.match(await applyCompetingLayoutRepair(doc.apply, 'fixture', before, plan, async () => changed), /compiled slides would change/)
  assert.match(await applyCompetingLayoutRepair(doc.apply, 'fixture', before, plan, async () => {
    doc.put(before.replace('First', 'New edit'))
    return true
  }), /talk.*chang/i)
  assert.deepEqual(doc.writes, [])
  assert.equal(doc.state.doc.toString(), before.replace('First', 'New edit'))
})

test('a numbered Cards slide keeps the option the renderer uses', async () => {
  const source = before.replace(/\{table table-header=off\}\{contrast contrast=rows\}/, '{list numbered}{cards}')
  const plan = planCompetingLayoutRepair(source, 3)
  assert.equal(plan.ok, true)
  assert.equal(plan.text, source.replace('{list numbered}', '{numbered}'))
  const original = await compile(source)
  assert.ok(findSlideSections(original.fullHtml).some(section => section.html.includes('cards-numbered')))
  assert.equal(compiledSlidesMatch(original, await compile(plan.text)), true)
})

test('an option that can imply a layout is not a competing layout tag', async () => {
  const source = before.replace(/\{table table-header=off\}\{contrast contrast=rows\}/, '{cards}{cards=rows}{cols=2}')
  assert.deepEqual(competingLayoutFindings(source), [])
  assert.equal(planCompetingLayoutRepair(source, 3).ok, false)
  assert.equal(await verify(source, source.replace('{cards=rows}', '')), false)
  const contrastOption = source.replace('{cards=rows}', '{contrast=cards}')
  assert.deepEqual(competingLayoutFindings(contrastOption), [])
  assert.ok(scanOutlineTriggers(contrastOption).every(finding => finding.kind !== 'duplicate-layout'))
})

test('target-slide tidy-up is in the preview, the verified save and the same Undo', async () => {
  const source = before.replace('## Example\n{table table-header=off}{contrast contrast=rows}', '## Example {table table-header=off}{contrast contrast=rows}\n\n')
  const next = after
  assert.equal(outlineSaveChange(source), 'tidy-up')
  const plan = planCompetingLayoutRepair(source, 3)
  assert.equal(plan.ok, true)
  assert.equal(plan.text, next)
  assert.deepEqual(plan.lines, [{
    line: 3,
    before: source.split('\n').slice(2, 5).join('\n'),
    after: next.split('\n').slice(2, 4).join('\n')
  }])
  assert.equal(outlineSaveChange(plan.text), null)
  const doc = editor(source)
  assert.equal(await applyCompetingLayoutRepair(doc.apply, 'fixture', source, plan, verify), null)
  assert.deepEqual(doc.writes, [next])
  assert.equal(undoDepth(doc.state), 1)
  assert.equal(doc.undo(), true)
  assert.equal(doc.state.doc.toString(), source)
})

test('a repair save preserves unrelated untidied slides before and after the selected slide', async () => {
  const prefix = '# Fixture\n\n## Earlier {list}\n\n{id=earlier}\n\n- Earlier item\n\n'
  const suffix = '\n## Later {list}\n\n{id=later}\n\n- Later item\n'
  const source = prefix + before.split('\n').slice(2).join('\n').replace('## Example\n{table table-header=off}', '## Example {table table-header=off}\n\n') + suffix
  const next = prefix + after.split('\n').slice(2).join('\n') + suffix
  const headingLine = prefix.split('\n').length
  const plan = planCompetingLayoutRepair(source, headingLine)
  assert.equal(plan.ok, true)
  assert.equal(plan.text, next)
  assert.ok(plan.text.startsWith(prefix))
  assert.ok(plan.text.endsWith(suffix))
  assert.equal(plan.lines[0].line, headingLine)
  assert.equal(outlineSaveChange(next), 'tidy-up', 'ordinary saves still tidy the entire outline')
  assert.equal(outlineSaveChange(next, headingLine - 1), null)
  const doc = editor(source)
  assert.equal(await applyCompetingLayoutRepair(doc.apply, 'fixture', source, plan, verify), null)
  assert.deepEqual(doc.writes, [next])
  assert.deepEqual(doc.repairSaves, [{ before: source, headingLine }])
  assert.equal(doc.undo(), true)
  assert.equal(doc.state.doc.toString(), source)
})

test('a plan with a change outside the target is refused before compiling or writing', async () => {
  const source = before + '\n## Other\n{id=other}\n\n- Other item\n'
  const plan = planCompetingLayoutRepair(source, 3)
  assert.equal(plan.ok, true)
  const doc = editor(source)
  const altered = { ...plan, text: plan.text.replace('Other item', 'A different item') }
  const refusal = await applyCompetingLayoutRepair(doc.apply, 'fixture', source, altered, () => assert.fail('must refuse before compiling'))
  assert.match(refusal, /no longer match/)
  assert.deepEqual(doc.writes, [])
  assert.equal(doc.state.doc.toString(), source)
})

test('an outside slide needing an ID cannot be part of the repair', () => {
  const plan = planCompetingLayoutRepair(before + '\n## Other\n\n- Other item\n', 3)
  assert.equal(plan.ok, false)
  assert.match(plan.error, /add slide IDs/)
})

test('the compiled comparison also rejects a change to either companion payload', async () => {
  const original = await compile(before)
  const close = original.fullHtml.lastIndexOf('</body>')
  assert.ok(close > 0)
  const withoutScript = original.fullHtml.replace(/<script type="application\/json" id="twSlideScript">.*?<\/script>/s, '')
  assert.notEqual(withoutScript, original.fullHtml)
  const replace = (html, tag) => html.slice(0, html.lastIndexOf('</body>')) + tag + '</body>'
  const script = renderSlideScriptTag({ '3c1f': [{ type: 'p', text: 'A different script' }] })
  const sources = renderQuoteSourcesTag({ '3c1f': { url: 'https://example.com/quote' } })
  assert.equal(compiledSlidesMatch(original, { ...original, fullHtml: replace(withoutScript, script) }), false)
  assert.equal(compiledSlidesMatch(original, { ...original, fullHtml: replace(original.fullHtml, sources) }), false)
})

test('cancelling or timing out an in-flight check prevents a late write', async () => {
  const plan = planCompetingLayoutRepair(before, 3)
  assert.equal(plan.ok, true)
  for (const cancelled of [true, false]) {
    const doc = editor(before)
    const controller = new AbortController()
    let finishCheck
    let started
    const checking = new Promise(resolve => { started = resolve })
    const verifyLater = () => new Promise(resolve => { finishCheck = resolve; started() })
    const outcome = applyCompetingLayoutRepair(doc.apply, 'fixture', before, plan, verifyLater, {
      signal: controller.signal, timeoutMs: 20
    })
    await checking
    if (cancelled) controller.abort()
    assert.match(await outcome, cancelled ? /cancelled/ : /took too long/)
    finishCheck(true)
    await Promise.resolve()
    assert.deepEqual(doc.writes, [])
    assert.equal(doc.state.doc.toString(), before)
  }
})
