import assert from 'node:assert/strict'
import { updateCheckMenuTemplate } from '../src/main/settings-update-menu.ts'
import { registry, MENUS, appCommandIdOf } from '../src/shared/bridle-commands.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { TASK_GROUPS } from '../src/shared/task-groups.ts'
import { toAccelerator } from '@app-patterns/commands'

let passed = 0
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`) }
const ran = [], bindings = registry.bindingsOf({})
const template = updateCheckMenuTemplate({ platform: 'darwin', keys: {}, run: id => ran.push(id), log() {} })
const walk = items => items.flatMap(item => [item, ...walk(Array.isArray(item.submenu) ? item.submenu : [])])
const all = walk(template)
check('native menus expose the existing ten named task groups exactly once', () => {
  for (const group of TASK_GROUPS) assert.equal(all.filter(item => item.label === group).length, 1, group)
})
check('commands live under their registry task and subgroup with unchanged runners', () => {
  for (const def of registry.defs) {
    const source = COMMAND_REGISTRY.find(c => c.id === appCommandIdOf(def.id))
    if (!source || def.noMenu || ['settings', 'cheat', 'check-for-updates'].includes(def.id)) continue
    const parent = all.find(item => item.label === def.group) // menu group: Research keeps its View placement
    assert.ok(parent, `${def.id}: task group`)
    const subgroup = parent.submenu.find(item => item.label === source.subgroup)
    assert.ok(subgroup, `${def.id}: subgroup`)
    const items = subgroup.submenu.filter(item => item.id === def.id)
    assert.equal(items.length, 1, `${def.id}: exactly once`)
    items[0].click(); assert.equal(ran.at(-1), def.id)
    assert.equal(items[0].accelerator, toAccelerator(bindings[def.id] ?? '') ?? undefined)
    if (items[0].accelerator) assert.equal(items[0].registerAccelerator, false)
  }
})
check('native Edit roles remain direct children in the platform frame', () => {
  const edit = template.find(m => m.label === 'Edit').submenu
  assert.deepEqual(edit.filter(item => item.role).map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  assert.equal(template[0].submenu[1].id, 'check-for-updates')
  assert.ok(template[0].submenu.some(item => /Settings/.test(item.label)))
  assert.ok(template.find(m => m.label === 'Help').submenu.some(item => item.label === registry.byId('cheat').label))
})
check('rebound effective chords reach the nested native leaf', () => {
  const keys = { 'format-bold': '⌘⌥⇧9' }
  // Use the actual settings format; the same registry computes both projections.
  const rebound = updateCheckMenuTemplate({ platform: 'darwin', keys, run() {}, log() {} })
  const expected = registry.bindingsOf(keys)
  assert.notEqual(expected['format-bold'], registry.bindingsOf({})['format-bold'], 'override takes effect')
  for (const item of walk(rebound).filter(item => item.id && item.click)) assert.equal(item.accelerator, toAccelerator(expected[item.id] ?? '') ?? undefined, item.id)
})
console.log(`${passed} native task-menu checks passed; ${MENUS.length} menu placements`)
