#!/usr/bin/env node
/**
 * A publish's handout pages are built in a process of its own (handout-pages-off-process.ts).
 *
 * Under plain Node: one child per publish, job sent as a message, one answer, the child ended after it;
 * a build error, a child that exits or reports a fatal error, a job that cannot be copied and a child
 * that cannot be started each fail that publish only, and a silent child is killed at the deadline.
 * Then the REAL child script (handout-pages-worker.ts) runs as a Node child process (stand-in:
 * scripts/lib/node-compile-child.mjs) with the real bundled compiler, and writes where the job says and
 * nowhere else. The real process boundary (a heap of its own) is proven under Electron by
 * e2e/diagnose-handout-own-heap.mjs.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHandoutPagesOffProcess } from '../src/main/handout-pages-off-process.ts'
import { forkNodeCompileChild } from './lib/node-compile-child.mjs'

const made = []
class FakeChild extends EventEmitter {
  constructor(path) { super(); this.path = path; this.posted = []; this.killed = false; made.push(this) }
  postMessage(job) {
    if (typeof job.bad === 'function') throw new Error('An object could not be cloned.')
    this.posted.push(job)
  }
  kill() { this.killed = true; return true }
  answer(value) { this.emit('message', value) }
}
const spawn = (path) => new FakeChild(path)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outcome = (promise) => promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
const job = { kind: 'pages', n: 1 }

// 1. A job goes to a fresh child as a message; its answer resolves the publish and ends the child.
{
  made.length = 0
  const build = createHandoutPagesOffProcess('w.js', spawn, 60_000)
  const first = build(job)
  const [a] = made
  assert.equal(a.path, 'w.js')
  assert.deepEqual(a.posted, [job], 'the job is sent as a message')
  a.answer({ ok: true, result: { warnings: ['w'] } })
  assert.deepEqual(await first, { warnings: ['w'] })
  assert.ok(a.killed, 'the child is ended after its answer')
  a.emit('exit', 0) // its exit arrives late: nothing happens
  const second = build(job)
  assert.equal(made.length, 2, 'one child per publish')
  made[1].answer({ ok: true, result: { warnings: [] } })
  await second
}

// 2. The build's own error is passed on as it is.
{
  made.length = 0
  const build = createHandoutPagesOffProcess('w.js', spawn, 60_000)
  const pending = outcome(build(job))
  made[0].answer({ ok: false, error: 'The pictures are too big.' })
  const r = await pending
  assert.equal(r.ok, false)
  assert.equal(r.e.message, 'The pictures are too big.')
  assert.ok(made[0].killed)
}

// 3. A child that exits (out of memory, a crash) or reports a fatal error fails that publish only.
{
  made.length = 0
  const build = createHandoutPagesOffProcess('w.js', spawn, 60_000)
  const crashed = outcome(build(job))
  made[0].emit('exit', 5)
  const r = await crashed
  assert.equal(r.ok, false)
  assert.match(r.e.message, /The handout could not be built \(the build stopped with code 5\)\./)
  const fatal = outcome(build(job))
  made[1].emit('error', 'FatalError', 'boom')
  const f = await fatal
  assert.match(f.e.message, /The handout could not be built \(the build stopped: FatalError at boom\)\./)
  made[1].emit('exit', 5)
  const next = build(job)
  assert.equal(made.length, 3, 'the next publish starts a fresh child')
  made[2].answer({ ok: true, result: { warnings: [] } })
  await next
}

// 4. A job that cannot be copied, and a child that cannot be started, fail that publish.
{
  made.length = 0
  const build = createHandoutPagesOffProcess('w.js', spawn, 60_000)
  const bad = await outcome(build({ ...job, bad: () => 1 }))
  assert.match(bad.e.message, /could not be cloned/)
  assert.ok(made[0].killed, 'the child of a job that could not be sent is ended')
  const refusing = createHandoutPagesOffProcess('w.js', () => { throw new Error('no child') }, 60_000)
  assert.equal((await outcome(refusing(job))).e.message, 'no child')
}

// 5. A silent child is killed at the deadline; late events change nothing.
{
  made.length = 0
  const build = createHandoutPagesOffProcess('w.js', spawn, 20)
  const r = await outcome(build(job))
  assert.equal(r.ok, false)
  assert.match(r.e.message, /The handout could not be built \(the build took longer than 0\.02 seconds\)\./)
  assert.ok(made[0].killed)
  made[0].answer({ ok: true, result: { warnings: [] } }); made[0].emit('exit', 9)
  const minutes = createHandoutPagesOffProcess('w.js', spawn, 600_000)
  const waiting = outcome(minutes(job))
  made[1].answer({ ok: true, result: { warnings: [] } })
  assert.equal((await waiting).ok, true)
  await wait(30)
}

// 6. The real child script in a plain Node child process, with the real bundled compiler: a 'pages'
//    job writes exactly the handout folder's pages, its venue page and the site's 404 page.
{
  const base = mkdtempSync(join(tmpdir(), 'tw-handout-off-process-'))
  try {
    const site = join(base, 'site')
    const talkOutDir = join(site, 'talk')
    const html = '<!doctype html><html><body><section class="slide" id="s1"><h1>One</h1></section></body></html>'
    const build = createHandoutPagesOffProcess(join(process.cwd(), 'src/main/handout-pages-worker.ts'), forkNodeCompileChild, 60_000)
    const result = await build({
      kind: 'pages', compilerDir: join(process.cwd(), 'compiler/scripts'), talkOutDir, siteDir: site, slug: 'talk', live: '',
      url: 'https://example.org/talk/', qr: '', downloadFile: 'talk-download.html', handoutFile: 'talk.html',
      pages: [
        { fileName: 'talk-download.html', html, lazy: false },
        { fileName: 'talk.html', html },
        { fileName: 'index.html', html },
      ],
      venue: { title: 'Talk', slides: [{ id: 's1', html: '<section id="s1">One</section>', notes: '' }], styles: '', liveTalkSlug: 'talk' },
    })
    assert.deepEqual(result.warnings, [])
    const written = []
    const walk = (dir) => { for (const name of readdirSync(dir)) { const full = join(dir, name); statSync(full).isDirectory() ? walk(full) : written.push(relative(base, full)) } }
    walk(base)
    const roots = written.map((file) => file.split('/').slice(0, 2).join('/'))
    for (const file of ['site/404.html', 'site/talk/index.html', 'site/talk/talk.html', 'site/talk/talk-download.html', 'site/talk/p/index.html']) {
      assert.ok(written.includes(file), `${file} is written: ${written.join(', ')}`)
    }
    assert.ok(roots.every((root) => root.startsWith('site/')), `nothing outside the site folder: ${written.join(', ')}`)
    // A build error in the child comes back as a publish failure, not a hang.
    const failing = await outcome(build({ kind: 'pages', compilerDir: join(base, 'no-compiler'), talkOutDir, siteDir: site, slug: 'talk', live: '', url: '', qr: '', downloadFile: 'd.html', handoutFile: 'h.html', pages: [], venue: { title: '', slides: [], styles: '' } }))
    assert.equal(failing.ok, false)
    assert.ok(!existsSync(join(base, 'no-compiler')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

console.log('handout pages off-process: ok')
