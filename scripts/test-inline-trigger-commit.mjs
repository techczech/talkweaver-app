import { strict as assert } from 'node:assert'
import * as commitModel from '../src/renderer/src/extensions/inlineTriggerCommitModel.ts'

const { commitInlineTriggerSelection } = commitModel

function apply(doc, changes) {
  let out = doc
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

const body = '### Slide\n{id=abc}{list}\n\nBody byte {lis identical'
const bodyFrom = body.lastIndexOf('{lis')
const bodyPlan = commitInlineTriggerSelection(body, bodyFrom, bodyFrom + 4, (line) => `${line}{reveal}`)
assert.equal(apply(body, bodyPlan.changes), '### Slide\n{id=abc}{list}{reveal}\n\nBody byte  identical')
assert.equal(bodyPlan.selection, bodyFrom, 'caret remains where the body token was removed')
assert.equal(bodyPlan.changes.length, 2, 'body removal and Trigger-line rewrite share one dispatch')

const trigger = '### Slide\n{id=abc}{lis}\n\nBody'
const triggerFrom = trigger.indexOf('{lis')
const triggerPlan = commitInlineTriggerSelection(trigger, triggerFrom, triggerFrom + 4, () => '{id=abc}{list}')
assert.equal(apply(trigger, triggerPlan.changes), '### Slide\n{id=abc}{list}\n\nBody')
assert.equal(triggerPlan.changes.length, 1, 'caret-on-Trigger-line reduces to one in-place rewrite')

const noTrigger = '### Slide\n\nBody {sta'
const noTriggerFrom = noTrigger.indexOf('{sta')
const noTriggerPlan = commitInlineTriggerSelection(noTrigger, noTriggerFrom, noTriggerFrom + 4, () => '{statement}')
assert.equal(apply(noTrigger, noTriggerPlan.changes), '### Slide\n{statement}\n\nBody ')

const duplicate = '### Not all Agents are Agents\n{sidebar} {id=hnwcx}\n{layout=media} {id=3plcu}\n\nBody {rev'
const duplicateFrom = duplicate.indexOf('{rev')
const duplicatePlan = commitInlineTriggerSelection(duplicate, duplicateFrom, duplicateFrom + 4, (line) => `${line}{reveal}`)
assert.equal(
  apply(duplicate, duplicatePlan.changes),
  '### Not all Agents are Agents\n{sidebar}{layout=media}{id=3plcu}{reveal}\n\nBody ',
  'inline commit collapses the whole Trigger block and keeps the lower original id'
)
assert.deepEqual(duplicatePlan.warnings, ['duplicate-slide-id-merged:3plcu'])

for (const midTyping of [
  '### Trying and making skills\n{id=7ely8}\n{\n\nBody',
  '### Trying and making skills\n{\n{id=7ely8}\n\nBody'
]) {
  const braceFrom = midTyping.indexOf('\n{\n') + 1
  const plan = commitInlineTriggerSelection(midTyping, braceFrom, braceFrom + 1, (line) => `${line}{carousel}`)
  const result = apply(midTyping, plan.changes)
  assert.equal((result.match(/\{id=7ely8\}/g) ?? []).length, 1,
    'inline completion keeps the existing id in either mid-typing line order')
  assert.equal(result.split('\n').filter((line) => /^\s*(\{[^}]*\}\s*)+$/.test(line)).length, 1,
    'inline completion consolidates the mid-typing window to one logical Trigger line')
}

assert.equal(typeof commitModel.planEditorTriggerCommit, 'function',
  'mounted-editor option commits expose the shared logical-block planner')
if (typeof commitModel.planEditorTriggerCommit === 'function') {
  const mounted = '### Not all Agents are Agents\n{sidebar} {id=hnwcx}\n{layout=media} {id=3plcu}\n\nBody\n'
  const plan = commitModel.planEditorTriggerCommit(mounted, 1, (line) => `${line}{titletop}`)
  assert.equal(apply(mounted, plan.changes),
    '### Not all Agents are Agents\n{sidebar}{layout=media}{id=3plcu}{titletop}\n\nBody\n',
    'mounted-editor planner merges the two-line block with one dispatch and keeps the lower id')
}

console.log('inline trigger commit: body, Trigger-line and missing-Trigger-line plans pass')
