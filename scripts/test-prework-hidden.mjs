// 0.37: pre-work is hidden behind one switch, off by default. The switch is read by every entry point
// (Inspector card, Plan a run fields, status-bar chip, History Run page, Run handout form). While it is
// off, saving a plan sends no pre-work fields, so a Run's stored pre-work times are never rewritten.
import { strict as assert } from 'node:assert'
import { PREWORK_ENABLED, preworkEnabled } from '../src/shared/prework-flag.ts'
import { blankDraft, planFromDraft, zoneToSend } from '../src/shared/plan-run.ts'

delete process.env.TW_PREWORK
assert.equal(PREWORK_ENABLED, false, 'the constant ships off')
assert.equal(preworkEnabled(), false, 'off by default')
process.env.TW_PREWORK = '1'
assert.equal(preworkEnabled(), true, 'TW_PREWORK=1 forces it on for the pre-work tests')
delete process.env.TW_PREWORK

const draft = { ...blankDraft(new Date('2026-10-01T09:00:00'), false), event: 'Workshop', preworkOn: true }
const plan = planFromDraft(draft, preworkEnabled())
assert(plan.ok)
assert.equal('preworkOpens' in plan.fields || 'preworkCloses' in plan.fields, false, 'no pre-work fields are sent while hidden, so a Run keeps its stored times')
assert.equal(zoneToSend({ timeZone: 'Europe/London', preworkOpens: '2026-10-02T09:00' }, 'Europe/Prague', Boolean(plan.fields.preworkOpens)), undefined)
console.log('PASS pre-work hidden: flag off by default, forced on by TW_PREWORK=1, a plan save leaves stored pre-work alone')
