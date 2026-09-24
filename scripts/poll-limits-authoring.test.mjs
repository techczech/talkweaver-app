import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { commitOptionSelection, selectionForGroup } from '../src/shared/trigger-line.ts'
import { inspectorModel } from '../src/renderer/src/components/inspectorModel.ts'
import { normaliseRun } from '../src/main/runs.ts'

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-limits-'))
try {
  const source = '---\ntitle: Limits\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Choose {id=choices poll=multiple pollselections=2}\n\n- A\n- B\n- C\n\n### Ideas {id=ideas poll=open pollsubmissions=unlimited}\n'
  const path = join(scratch, 'poll-limits.md'); await writeFile(path, source)
  const model = await prepareSource(path, source, 'limits', await stat(path))
  const dom = new JSDOM(model.fullHtml)
  const polls = [...dom.window.document.querySelectorAll('[data-poll]')].map(el => JSON.parse(el.dataset.poll))
  assert.equal(polls.find(p => p.type === 'multiple')?.maxSelections, 2, 'authored selections reach the compiled poll')
  assert.equal(polls.find(p => p.type === 'open')?.maxSubmissions, null, 'authored unlimited submissions reach the compiled poll')
  dom.window.close()
  for (const [key, type] of [['pollselections', 'multiple'], ['pollsubmissions', 'open']]) {
    const group = GLOBAL_OPTION_GROUPS.find(g => g.key === key)
    assert.ok(group, 'authoring exposes the numeric control')
    const line = `{id=stable}{poll=${type}}{${key}=2}{accent=cobalt}`
    const changed = commitOptionSelection(line, group, `${key}=7`)
    assert.match(changed, /id=stable/); assert.match(changed, /accent=cobalt/)
    assert.equal(selectionForGroup(changed, group), `${key}=7`)
    assert.doesNotMatch(changed, new RegExp(`${key}=2`))
    const model = inspectorModel([], 0, 3, changed, LAYOUTS)
    assert.ok(model.groups.some(b => b.group.key === key))
    const plain = inspectorModel([], 0, 3, '{id=plain}', LAYOUTS)
    assert.ok(!plain.groups.some(b => b.group.key === key), 'limits are only shown for the relevant poll type')
  }
  const run = normaliseRun({ id: 'run', talkSlug: 'limits', polls: [
    { id: 'choices', type: 'multiple', question: 'Choices', options: [{ optionId:'a',label:'A' }], visibility:'held', maxSelections:1 },
    { id: 'open', type:'open', question:'', options:[], visibility:'held', maxSubmissions:null },
  ] })
  assert.equal(run.polls[0].maxSelections, 1)
  assert.equal(run.polls[1].maxSubmissions, null, 'questionless Quick polls retain their rules in history')
  console.log('Poll limits authoring, inspector and history passed')
} finally { await rm(scratch, { recursive:true, force:true }) }
