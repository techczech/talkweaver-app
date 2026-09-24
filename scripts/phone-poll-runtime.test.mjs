import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  createAudiencePollRuntime,
  normalisePollState,
  renderAudiencePollMarkup,
} from '../compiler/assets/runtime/live-follow.js'

const single = (overrides = {}) => ({
  type: 'poll.state', pollId: 'single', pollType: 'single', question: 'Choose one',
  options: [{ optionId: 'a', label: 'First' }, { optionId: 'b', label: 'Second' }],
  visibility: 'held', open: true, revealed: false, slideId: 'slide-poll',
  ...overrides,
})

const multiple = (overrides = {}) => ({
  ...single({ pollId: 'multiple', pollType: 'multiple', question: 'Choose any' }),
  ...overrides,
})

const open = (overrides = {}) => ({
  ...single({ pollId: 'open', pollType: 'open', question: 'What matters?', options: [] }),
  ...overrides,
})

function createHarness(sendVote) {
  const dom = new JSDOM('<main id="poll"></main>', { url: 'https://handout.example.test/' })
  const previousDocument = globalThis.document
  globalThis.document = dom.window.document
  const mount = dom.window.document.getElementById('poll')
  const runtime = createAudiencePollRuntime({ mount, storage: dom.window.localStorage, sendVote })
  runtime.startSession('session-1')
  return {
    dom, mount, runtime,
    cleanup() { globalThis.document = previousDocument; dom.window.close() },
  }
}

{
  const safe = normalisePollState(open({
    visibility: 'live', revealed: true, open: false, tallies: { private: 9 },
    responses: [
      { responseId: 'shown', text: 'Public', name: 'Private name' },
      { responseId: 'hidden', text: 'Moderated', hidden: true, name: 'Hidden name' },
    ],
  }))
  assert.equal(safe?.slideId, 'slide-poll', 'an authored poll keeps its optional slide ID')
  assert.deepEqual(safe?.responses, [{ responseId: 'shown', text: 'Public' }], 'public state excludes hidden responses and names')
  assert.deepEqual(safe?.tallies, {}, 'undeclared tally fields do not affect audience totals')

  const held = normalisePollState(open({
    tallies: { private: 9 },
    responses: [{ responseId: 'private', text: 'Held response', name: 'Private name' }],
  }))
  assert.equal('tallies' in held, false, 'held tallies do not enter audience state')
  assert.equal('responses' in held, false, 'held responses do not enter audience state')
}

{
  const freshSingle = renderAudiencePollMarkup(single({
    visibility: 'live', revealed: true, open: false, tallies: { a: 2, b: 1, private: 99 },
  }), null)
  assert.match(freshSingle, /poll-results/, 'a closed public snapshot renders for a new viewer')
  assert.match(freshSingle, /3 votes/, 'single-choice totals are labelled as votes')
  assert.doesNotMatch(freshSingle, /Your answer/, 'a fresh viewer is not told that they voted')

  const freshMultiple = renderAudiencePollMarkup(multiple({
    visibility: 'live', revealed: true, open: false, tallies: { a: 2, b: 2 },
  }), null)
  assert.match(freshMultiple, /4 selections/, 'multiple-choice totals count selections')
  assert.doesNotMatch(freshMultiple, /participants|voted/, 'multiple-choice results do not infer participant count')

  const defensiveHeld = renderAudiencePollMarkup(open({
    open: false,
    responses: [{ responseId: 'private', text: 'Held response', name: 'Private name' }],
  }), null)
  assert.doesNotMatch(defensiveHeld, /Held response|Private name/, 'held content is absent even when a caller supplies it')
}

{
  let submission = 0
  const sent = []
  const harness = createHarness((pollId, choice) => {
    submission += 1
    const submissionId = `00000000-0000-4000-8000-${String(submission).padStart(12, '0')}`
    sent.push({ submissionId, pollId, choice })
    return submissionId
  })
  try {
    harness.runtime.selectSlide('slide-poll')
    harness.runtime.receive(single())
    const first = harness.mount.querySelector('input[value="a"]')
    first.click()
    harness.mount.querySelector('.poll-submit').click()
    assert.equal(harness.mount.querySelector('.poll-submit').textContent, 'Submitting…')
    assert.equal(harness.dom.window.localStorage.length, 0, 'pending votes are not persisted')

    harness.runtime.onVoteStatus({ submissionId: 'wrong-id', pollId: 'single', status: 'confirmed' })
    assert.equal(harness.dom.window.localStorage.length, 0, 'an unrelated acknowledgement cannot confirm the vote')
    harness.runtime.onVoteStatus({
      submissionId: sent[0].submissionId, pollId: 'single', status: 'confirmed', choice: 'b',
    })
    assert.equal(harness.dom.window.localStorage.length, 0, 'a mismatched echoed choice cannot confirm the wrong answer')

    harness.runtime.onVoteStatus({
      submissionId: sent[0].submissionId, pollId: 'single', status: 'rejected', error: 'Answer window closed',
    })
    assert.equal(harness.mount.querySelector('input[value="a"]').checked, true, 'rejection keeps the selected answer')
    assert.match(harness.mount.querySelector('.poll-inline-status').textContent, /Answer window closed/)
    assert.equal(harness.mount.querySelector('.poll-submit').disabled, false, 'rejection offers a usable retry')

    harness.mount.querySelector('.poll-submit').click()
    assert.equal(sent.length, 2, 'retry creates one new submission')
    harness.mount.querySelector('.poll-submit').click()
    assert.equal(sent.length, 2, 'a pending retry cannot be duplicated')
    harness.runtime.onVoteStatus({ submissionId: sent[1].submissionId, pollId: 'single', status: 'confirmed' })
    assert.equal(
      harness.dom.window.localStorage.getItem('talkweaver:poll-vote:session-1:single'),
      '"a"',
      'only a confirmed vote is persisted',
    )
  } finally { harness.cleanup() }
}

{
  let runtime
  const harness = createHarness((pollId, choice) => {
    const submissionId = '10000000-0000-4000-8000-000000000001'
    runtime.onVoteStatus({ submissionId, pollId, status: 'confirmed' })
    return submissionId
  })
  runtime = harness.runtime
  try {
    runtime.selectSlide('slide-poll')
    runtime.receive(open())
    const textarea = harness.mount.querySelector('textarea')
    textarea.value = 'Accountability'
    textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
    harness.mount.querySelector('.poll-submit').click()
    assert.equal(
      harness.dom.window.localStorage.getItem('talkweaver:poll-vote:session-1:open'),
      '"Accountability"',
      'a synchronous confirmation is correlated after sendVote returns its ID',
    )
  } finally { harness.cleanup() }
}

{
  const sent = []
  const harness = createHarness((pollId, choice) => {
    const submissionId = `20000000-0000-4000-8000-${String(sent.length + 1).padStart(12, '0')}`
    sent.push({ submissionId, pollId, choice })
    return submissionId
  })
  try {
    harness.runtime.selectSlide('slide-poll')
    harness.runtime.receive(single())
    harness.mount.querySelector('input[value="b"]').click()
    harness.mount.querySelector('.poll-submit').click()

    harness.runtime.selectSlide('ordinary-slide')
    assert.equal(harness.mount.hidden, true, 'leaving an authored poll hides its phone surface')
    harness.runtime.receive(single({ pollId: 'background', slideId: 'another-slide' }))
    assert.equal(harness.mount.hidden, true, 'a non-current poll update does not steal the screen')
    harness.runtime.receive(single({ pollId: 'old-quick', slideId: undefined, open: false }))
    assert.equal(harness.mount.hidden, true, 'a closed Quick poll from a full snapshot does not steal the screen')

    harness.runtime.onVoteStatus({ submissionId: sent[0].submissionId, pollId: 'single', status: 'confirmed' })
    assert.equal(harness.mount.hidden, true, 'late confirmation persists without stealing the current view')
    assert.equal(harness.dom.window.localStorage.getItem('talkweaver:poll-vote:session-1:single'), '"b"')

    harness.runtime.selectSlide('slide-poll')
    assert.equal(harness.mount.hidden, false, 'returning to the authored poll restores its view')
    harness.mount.querySelector('.poll-dismiss').click()
    harness.runtime.receive(single({ visibility: 'live', revealed: true, tallies: { a: 2, b: 1 } }))
    assert.equal(harness.mount.hidden, true, 'background updates do not reopen a manually dismissed poll')

    harness.runtime.selectSlide('ordinary-slide')
    harness.runtime.selectSlide('slide-poll')
    assert.equal(harness.mount.hidden, false, 'explicit navigation back restores a dismissed authored poll')
  } finally { harness.cleanup() }
}

{
  const harness = createHarness(() => false)
  try {
    harness.runtime.selectSlide('slide-poll')
    harness.runtime.receive(single({ visibility: 'live', revealed: true, tallies: { a: 3, b: 1 } }))
    harness.runtime.onVoteStatus({
      submissionId: '30000000-0000-4000-8000-000000000001', pollId: 'single', status: 'confirmed', choice: 'b',
    })
    assert.equal(
      harness.dom.window.localStorage.getItem('talkweaver:poll-vote:session-1:single'),
      '"b"',
      'a restored confirmed receipt persists its choice without a local pending submission',
    )
    assert.match(harness.mount.querySelector('.poll-bar.mine').textContent, /Second/)
    harness.runtime.onVoteStatus({
      submissionId: '30000000-0000-4000-8000-000000000002', pollId: 'other', status: 'confirmed',
    })
    assert.equal(
      harness.dom.window.localStorage.getItem('talkweaver:poll-vote:session-1:other'),
      null,
      'an uncorrelated confirmation without a choice cannot invent local answer state',
    )
  } finally { harness.cleanup() }
}

{
  const harness = createHarness(() => false)
  try {
    harness.runtime.selectSlide('slide-poll')
    harness.runtime.receive(single())
    harness.mount.querySelector('input[value="a"]').click()
    harness.mount.querySelector('.poll-submit').click()
    assert.equal(harness.mount.querySelector('input[value="a"]').checked, true)
    assert.match(harness.mount.querySelector('.poll-inline-status').textContent, /try again/i)
    assert.equal(harness.dom.window.localStorage.length, 0, 'a send failure is not treated as confirmation')

    harness.runtime.receive(single({ open: false }))
    assert.equal(harness.mount.hidden, false, 'closing voting retains a visible held confirmation')
    assert.match(harness.mount.textContent, /Poll closed/)
    harness.runtime.receive(single({
      open: false, revealed: true, tallies: { a: 2, b: 1 },
    }))
    assert.match(harness.mount.innerHTML, /poll-results/, 'reveal after close replaces the held confirmation with results')
  } finally { harness.cleanup() }
}

{
  const harness = createHarness(() => false)
  try {
    harness.runtime.selectSlide('slide-poll')
    harness.runtime.receive(open())
    const textarea = harness.mount.querySelector('textarea')
    textarea.focus()
    textarea.value = 'Still typing'
    textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
    harness.runtime.receive(open({ visibility: 'live', revealed: true, responses: [] }))
    assert.equal(harness.mount.querySelector('textarea'), textarea, 'a tally update does not replace an unconfirmed form')
    assert.equal(harness.dom.window.document.activeElement, textarea, 'a tally update preserves typing focus')
    assert.equal(textarea.value, 'Still typing')

    harness.runtime.receive(open({ open: false, visibility: 'live', revealed: true, responses: [
      { responseId: 'visible', text: 'Shown' },
    ] }))
    assert.match(harness.mount.textContent, /Shown/)
    harness.runtime.receive(open({ open: false, visibility: 'live', revealed: true, responses: [
      { responseId: 'visible', text: 'Shown', hidden: true },
    ] }))
    assert.doesNotMatch(harness.mount.textContent, /Shown/, 'a moderation snapshot removes cached public content')
  } finally { harness.cleanup() }
}

console.log('phone poll runtime: safe snapshots, navigation, closed results and acknowledgements passed')

{
  const h = createHarness(() => 'submission-limits')
  h.runtime.receive(multiple({ slideId: undefined, maxSelections: 1 }))
  const inputs = h.mount.querySelectorAll('input[name="poll-choice"]')
  inputs[0].checked = true; inputs[0].dispatchEvent(new h.dom.window.Event('change'))
  assert.equal(inputs[1].disabled, true, 'unselected options disable at the selection limit')
  assert.match(h.mount.textContent, /up to 1/)
  inputs[0].checked = false; inputs[0].dispatchEvent(new h.dom.window.Event('change'))
  assert.equal(inputs[1].disabled, false, 'deselecting restores the other options')
  h.cleanup()
}
{
  let id = 0
  const h = createHarness(() => `submission-limits-${++id}`)
  const state = open({ slideId: undefined, maxSubmissions: 2 })
  h.runtime.receive(state)
  function answer(text) {
    const input = h.mount.querySelector('textarea')
    assert.ok(input, 'a participant with remaining allowance can answer')
    input.value = text; input.dispatchEvent(new h.dom.window.Event('input'))
    h.mount.querySelector('.poll-submit').click()
    h.runtime.onVoteStatus({ type: 'vote.ack', submissionId: `submission-limits-${id}`, pollId: 'open', choice: text, status: 'confirmed' })
  }
  answer('First'); assert.match(h.mount.textContent, /1 submission remaining/)
  const receipt = { type: 'vote.ack', submissionId: 'submission-limits-1', pollId: 'open', choice: 'First', status: 'confirmed' }
  h.runtime.onVoteStatus(receipt)
  assert.ok(h.mount.querySelector('textarea'), 'repeated receipts do not use a second allowance')
  answer('Second'); assert.equal(h.mount.querySelector('textarea'), null)
  assert.match(h.mount.textContent, /No submissions remaining/)
  h.runtime.receive({ ...state, open: false }); h.runtime.receive(state)
  assert.equal(h.mount.querySelector('textarea'), null, 'reopening keeps the exhausted allowance')
  const reload = createAudiencePollRuntime({ mount: h.mount, storage: h.dom.window.localStorage, sendVote: () => 'never' })
  reload.startSession('session-1'); reload.receive(state)
  assert.equal(h.mount.querySelector('textarea'), null, 'reload restores the accepted allowance')
  h.cleanup()
}
{
  const h = createHarness(() => 'submission-unlimited')
  h.runtime.receive(open({ slideId: undefined, maxSubmissions: null, visibility: 'live' }))
  for (let i = 0; i < 4; i++) h.runtime.onVoteStatus({ type: 'vote.ack', submissionId: `submission-peer-${i}`, pollId: 'open', choice: `Idea ${i}`, status: 'confirmed' })
  assert.ok(h.mount.querySelector('textarea'), 'unlimited submissions remain available alongside results')
  assert.match(h.mount.textContent, /Unlimited submissions/)
  h.cleanup()
}
{
  const h = createHarness(() => 'submission-draft')
  const held = open({ slideId: undefined, maxSubmissions: 3 })
  h.runtime.receive(held)
  h.runtime.onVoteStatus({ type:'vote.ack', submissionId:'submission-first', pollId:'open', choice:'First', status:'confirmed' })
  const draft = h.mount.querySelector('textarea')
  draft.value = 'Work in progress'; draft.dispatchEvent(new h.dom.window.Event('input')); draft.focus()
  h.runtime.receive({ ...held, revealed:true, responses:[{responseId:'first', text:'First'}] })
  assert.match(h.mount.textContent, /Your answer is on the board/, 'revealing results updates while another answer is being drafted')
  h.runtime.receive({ ...held, revealed:true, responses:[{responseId:'first',text:'First'},{responseId:'other',text:'Another participant'}] })
  assert.match(h.mount.textContent, /Another participant/, 'revealed results keep updating alongside the draft')
  assert.equal(h.mount.querySelector('textarea'), draft, 'result updates preserve the draft element and focus')
  assert.equal(h.dom.window.document.activeElement, draft)
  assert.equal(draft.value, 'Work in progress')
  h.cleanup()
}
