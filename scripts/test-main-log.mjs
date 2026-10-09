#!/usr/bin/env node
/**
 * "A lane that decides things on its own has to be able to say what it did."
 *
 * The packaged app has no console — main-process `console.log` goes nowhere a user can reach, and
 * tw-main-errors.log records only unhandled rejections. Both 2026-09-15 incidents (the OOM, and
 * then every Slide Browser card falling back to its schematic while the PNGs sat on disk) had to
 * be diagnosed from crash reports and a screenshot. This is the log that replaces the guesswork,
 * and the thing that can go wrong with it is unbounded growth in a user's profile.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendBounded, createAppendLog, createErrorLog, formatErrorEntry, formatLogLine, readLogTail, truncateLogText } from '../src/main/main-log.ts'

const dir = mkdtempSync(join(tmpdir(), 'tw-main-log-'))
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

check('a line is a timestamp and a message, and nothing else', () => {
  const at = new Date('2026-09-15T08:35:01.123Z')
  assert.equal(formatLogLine('hello', at), '[2026-09-15T08:35:01.123Z] hello\n')
  assert.match(formatLogLine('x'), /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] x\n$/, 'ISO, to the millisecond')
  // One event is one line: an embedded newline must not become a second, timestamp-less entry.
  assert.equal(formatLogLine('two\nlines', at), '[2026-09-15T08:35:01.123Z] two lines\n')
  assert.equal(formatLogLine('crlf\r\nhere', at), '[2026-09-15T08:35:01.123Z] crlf here\n')
})

check('the file is written, appended to, and readable in order', () => {
  const file = join(dir, 'ordered.log')
  const log = createAppendLog(file)
  log('[thumbnails] heap at 2100 MB — deferring talk-a until it drops')
  log('[thumbnails] heap at 400 MB after 20s — resuming talk-a')
  log('[thumbnails] talk-a: rendered 87 of 87 slides, prepared model evicted, heap at 460 MB')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3, 'three events, three lines')
  assert.match(lines[0], /deferring talk-a/)
  assert.match(lines[2], /rendered 87 of 87 slides/)
  assert.ok(lines.every((l) => /^\[\d{4}-\d{2}-\d{2}T/.test(l)), 'every line carries its timestamp')
})

check('the file is truncated to its tail once it passes the ceiling', () => {
  const file = join(dir, 'big.log')
  // 1KB ceiling, 400B kept: the same rule as the 1MB/512KB production values, small enough to hit.
  const log = createAppendLog(file, { maxBytes: 1024, keepBytes: 400 })
  for (let i = 0; i < 200; i++) log(`[thumbnails] event number ${i} with enough text to add up`)
  const size = statSync(file).size
  assert.ok(size <= 1024, `the log must stay under its ceiling, got ${size} bytes`)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /event number 199/, 'the most recent event survives — it is the one being read')
  assert.ok(!text.includes('event number 0 '), 'the oldest events are gone')
  assert.match(text, /^\[log truncated to the last 400 bytes\]\n/, 'and the cut says so')
  // Every surviving line is whole: a truncation that opens mid-line makes the first entry a lie.
  for (const line of text.trim().split('\n').slice(1)) {
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[thumbnails\] event number \d+ /, `whole line: ${line}`)
  }
})

check('truncation keeps the tail and starts at a line boundary', () => {
  const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].map((l) => l + '\n').join('')
  const kept = truncateLogText(text, 12)
  assert.ok(kept.endsWith('dddd\n'), 'the newest line is kept')
  assert.ok(!kept.includes('aaaa'), 'the oldest is dropped')
  assert.ok(kept.split('\n').slice(1).every((l) => l === '' || /^[a-d]{4}$/.test(l)), 'no half line survives')
  assert.equal(truncateLogText('short\n', 1024), 'short\n', 'a small file is left exactly as it is')
})

check('logging never throws, whatever the filesystem does', () => {
  const missing = createAppendLog(join(dir, 'no-such-directory', 'x.log'))
  assert.doesNotThrow(() => missing('a log that throws is worse than no log'))
  // A file replaced by a directory-shaped path, mid-session.
  const file = join(dir, 'clobbered.log')
  const log = createAppendLog(file, { maxBytes: 10, keepBytes: 5 })
  log('first')
  writeFileSync(file, 'x'.repeat(100))
  assert.doesNotThrow(() => log('second'))
  assert.ok(existsSync(file))
})

check('tw-main-errors.log keeps whole stacks and is bounded like every other log', () => {
  const at = new Date('2026-09-15T08:35:01.123Z')
  const err = new Error('boom')
  err.stack = 'Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)'
  assert.equal(formatErrorEntry('uncaughtException', err, at),
    '\n[2026-09-15T08:35:01.123Z] uncaughtException: Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)\n',
    'the stack keeps its line breaks — that is what makes the entry diagnosable')
  assert.match(formatErrorEntry('unhandledRejection', 'plain string', at), /unhandledRejection: plain string\n$/)
  assert.match(formatErrorEntry('unhandledRejection', undefined, at), /unhandledRejection: undefined\n$/)

  const file = join(dir, 'tw-main-errors.log')
  const log = createErrorLog(() => file, { maxBytes: 2048, keepBytes: 800 })
  for (let i = 0; i < 300; i++) {
    const e = new Error(`failure ${i}`)
    e.stack = `Error: failure ${i}\n    at frame (z.js:${i}:1)`
    log('uncaughtException', e)
  }
  const size = statSync(file).size
  assert.ok(size <= 2048, `a crash loop must not grow the log without limit, got ${size} bytes`)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /Error: failure 299\n    at frame \(z\.js:299:1\)\n$/, 'the newest error and its stack survive')
  assert.ok(!text.includes('failure 0\n'), 'the oldest errors are gone')
  assert.match(text, /^\[log truncated to the last 800 bytes\]\n/, 'and the cut says so')
})

check('the error log never throws, even before the path can be resolved', () => {
  // Process handlers are installed before app ready; app.getPath may not be usable yet.
  const early = createErrorLog(() => { throw new Error("Failed to get 'userData' path") })
  assert.doesNotThrow(() => early('uncaughtException', new Error('very early')))
  const missing = createErrorLog(() => join(dir, 'no-such-directory', 'tw-main-errors.log'))
  assert.doesNotThrow(() => missing('unhandledRejection', new Error('x')))
  // An error whose stack getter itself throws.
  const hostile = { get stack() { throw new Error('nope') } }
  const file = join(dir, 'hostile.log')
  assert.doesNotThrow(() => createErrorLog(() => file)('uncaughtException', hostile))
  assert.match(readFileSync(file, 'utf8'), /uncaughtException: \(unprintable error\)/)
})


check('an already oversized log is trimmed by reading only its tail (Codex review, PR #3)', () => {
  // An unbounded log from before this bound existed can be past V8's maximum string length, so the
  // trim must never read the whole file. readLogTail reads only the last keepBytes and keeps exactly
  // what truncateLogText would keep from the whole text.
  const file = join(dir, 'oversized.log')
  const lines = Array.from({ length: 5000 }, (_, i) => `[2026-09-01T00:00:00.000Z] old entry ${i}`).join('\n') + '\n'
  writeFileSync(file, lines)
  const size = statSync(file).size
  assert.equal(readLogTail(file, size, 2000), truncateLogText(lines, 2000), 'same result as trimming the whole text')
  appendBounded(file, 'newest entry\n', { maxBytes: 10_000, keepBytes: 2000 })
  const kept = readFileSync(file, 'utf8')
  assert.ok(statSync(file).size < 2100, `trimmed to the tail (got ${statSync(file).size} bytes)`)
  assert.match(kept, /^\[log truncated to the last 2000 bytes\]\n\[2026/, 'marked, and starts on a line boundary')
  assert.ok(kept.endsWith('newest entry\n'), 'keeps the newest entry')
  assert.equal(readLogTail(file, 5, 2000), kept.slice(0, 5), 'a file shorter than keepBytes is read as it is')
})

if (failures) {
  console.error(`\n${failures} main-log check(s) failed`)
  process.exit(1)
}
console.log('\nmain log: all checks passed')
