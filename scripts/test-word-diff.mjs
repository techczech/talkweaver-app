import assert from 'node:assert/strict'
import { diffWords } from '../src/renderer/src/lib/wordDiff.ts'

const kinds = (tokens) => tokens.map((token) => token.kind)
const text = (tokens) => tokens.map((token) => token.text).join(' ')
const only = (tokens, kind) => tokens.filter((token) => token.kind === kind).map((token) => token.text)

// Identical strings — everything is 'same', both columns round-trip verbatim.
{
  const d = diffWords('the quick brown fox', 'the quick brown fox')
  assert.deepEqual(kinds(d.original), ['same', 'same', 'same', 'same'])
  assert.deepEqual(kinds(d.suggested), ['same', 'same', 'same', 'same'])
  assert.equal(text(d.original), 'the quick brown fox')
  assert.equal(text(d.suggested), 'the quick brown fox')
}

// Pure insertion — the suggestion adds words the original never had.
{
  const d = diffWords('we start here', 'so we clearly start here')
  assert.deepEqual(only(d.original, 'removed'), [], 'nothing removed on a pure insertion')
  assert.deepEqual(only(d.suggested, 'added'), ['so', 'clearly'], 'the new words are marked added')
  assert.equal(text(d.original), 'we start here', 'original column reads clean')
  assert.equal(text(d.suggested), 'so we clearly start here', 'suggested column reads clean')
}

// Pure deletion — a disfluency the clean job drops.
{
  const d = diffWords('um so we begin', 'so we begin')
  assert.deepEqual(only(d.original, 'removed'), ['um'], 'the dropped filler is marked removed')
  assert.deepEqual(only(d.suggested, 'added'), [], 'nothing added on a pure deletion')
}

// Substitution — a name fixed from the slide content shows as removed + added.
{
  const d = diffWords('as trish argued', 'as Greenhalgh argued')
  assert.deepEqual(only(d.original, 'removed'), ['trish'])
  assert.deepEqual(only(d.suggested, 'added'), ['Greenhalgh'])
  // The unchanged words stay aligned as 'same'.
  assert.deepEqual(only(d.original, 'same'), ['as', 'argued'])
  assert.deepEqual(only(d.suggested, 'same'), ['as', 'argued'])
}

// Reorder — moving a word reads as one removal + one addition, not a full rewrite.
{
  const d = diffWords('the big red house', 'the red big house')
  assert.equal(only(d.original, 'same').length + only(d.suggested, 'added').length > 0, true)
  // 'the' and 'house' anchor; exactly one word moves.
  assert.ok(only(d.original, 'same').includes('the'))
  assert.ok(only(d.original, 'same').includes('house'))
  assert.equal(only(d.original, 'removed').length, 1, 'one token removed from the original order')
  assert.equal(only(d.suggested, 'added').length, 1, 'one token added in the new order')
  assert.equal(text(d.original), 'the big red house')
  assert.equal(text(d.suggested), 'the red big house')
}

// Cosmetic-only edits — added punctuation and capitalisation are NOT churn.
{
  const d = diffWords('so we begin here we go', 'So, we begin. Here we go.')
  assert.deepEqual(only(d.original, 'removed'), [], 'punctuation/case changes are not removals')
  assert.deepEqual(only(d.suggested, 'added'), [], 'punctuation/case changes are not additions')
  // But the display text keeps the cleaned punctuation.
  assert.equal(text(d.suggested), 'So, we begin. Here we go.')
}

// Empty original (a silent slide) — the whole suggestion is added; empty stays empty.
{
  const d = diffWords('', 'anything here')
  assert.deepEqual(kinds(d.original), [])
  assert.deepEqual(only(d.suggested, 'added'), ['anything', 'here'])
  const e = diffWords('', '')
  assert.deepEqual(e.original, [])
  assert.deepEqual(e.suggested, [])
}

// Whitespace is normalised — extra spaces/newlines never leak into tokens.
{
  const d = diffWords('one   two\n\nthree', 'one two three')
  assert.deepEqual(only(d.original, 'same'), ['one', 'two', 'three'])
  assert.deepEqual(only(d.suggested, 'same'), ['one', 'two', 'three'])
}

console.log('test-word-diff: all assertions passed')
