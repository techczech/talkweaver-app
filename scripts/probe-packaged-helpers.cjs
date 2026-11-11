'use strict'
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const app = resolve(process.argv[2]), resources = join(app, 'Contents/Resources')
const root = mkdtempSync(join(__dirname, '../.tw-helper-probe-'))
const run = (exe, args, env) => {
  const result = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `${exe}: ${result.stderr}`)
  return result.stdout
}
try {
  const png = join(root, 'words.png'), gif = join(root, 'animation.gif'), video = join(root, 'animation.mp4'), poster = join(root, 'poster.jpg')
  const script = join(root, 'image.cjs')
  writeFileSync(script, `require(${JSON.stringify(join(resources, 'app/node_modules/sharp'))})(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><rect width="1000" height="200" fill="white"/><text x="30" y="130" font-size="80" fill="black">SECURITY FIXTURE</text></svg>')).png().toFile(${JSON.stringify(png)}).catch(e=>{console.error(e.message);process.exitCode=1})`)
  run(join(app, 'Contents/MacOS/TalkWeaver'), [script], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  const text = run(join(resources, 'ocr'), [png])
  assert.match(text, /SECURITY/i)
  console.log('PASS signed bundled OCR recognises fixture text')
  run(join(resources, 'ffmpeg/ffmpeg'), ['-y', '-loop', '1', '-i', png, '-t', '0.5', '-vf', 'fps=5,scale=320:-1', gif])
  run(join(resources, 'media'), ['convert-gif', gif, video])
  assert.ok(existsSync(video))
  run(join(resources, 'media'), ['poster', video, poster])
  assert.ok(existsSync(poster))
  console.log('PASS signed FFmpeg, Swift GIF conversion and media poster helpers')
} finally { rmSync(root, { recursive: true, force: true }) }
