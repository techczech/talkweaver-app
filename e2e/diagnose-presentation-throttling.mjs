// Hidden synthetic Electron check using production options, without launching TalkWeaver.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const repo = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(join(repo, 'src/main/index.ts'), 'utf8')
const evaluate = (text, context) => vm.runInNewContext(ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, context)
const start = source.indexOf('const deckWindowOpenOpts = ')
const child = evaluate(source.slice(start, source.indexOf('\n\n', start)) + '\ndeckWindowOpenOpts', {
  E2E: false, appWindowOpenOpts: {}, pressLedger: { pressedRecently: () => false }
}).allowOptions.overrideBrowserWindowOptions
const directStart = source.indexOf('const win = new BrowserWindow({', source.indexOf('const bridgePreload ='))
const direct = evaluate(source.slice(directStart, source.indexOf('    // Keep our role+talk title', directStart)) + '\nwin', {
  E2E: false, winTitle: 'Synthetic audience', bridgePreload: null, BrowserWindow: function (opts) { return opts }
})
assert.equal(direct.webPreferences.backgroundThrottling, false)
assert.equal(child.webPreferences.backgroundThrottling, false)
const scratch = mkdtempSync(join(repo, 'e2e/.presentation-throttling-'))
try {
  writeFileSync(join(scratch, 'options.json'), JSON.stringify([direct, child]))
  writeFileSync(join(scratch, 'slide.html'), '<body>initial<script>window.channel = new BroadcastChannel("synthetic-slide"); channel.onmessage = e => requestAnimationFrame(() => { document.body.dataset.slide = e.data; document.body.style.backgroundColor = "rgb(255, 0, 0)"; });</script>')
  writeFileSync(join(scratch, 'host.cjs'), `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'userData'));
app.whenReady().then(async () => {
  const windows = [];
  try {
    for (const [i, opts] of JSON.parse(fs.readFileSync(path.join(__dirname, 'options.json'))).entries()) {
      const audience = new BrowserWindow({...opts, show: false}); windows.push(audience);
      await audience.loadFile(path.join(__dirname, 'slide.html'));
      if (audience.isVisible() || audience.webContents.getBackgroundThrottling() !== false) throw Error('unsafe visibility or throttled audience');
      const presenter = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false}}); windows.push(presenter);
      await presenter.loadFile(path.join(__dirname, 'slide.html'));
      await presenter.webContents.executeJavaScript('channel.postMessage("slide-' + i + '")');
      const deadline = Date.now() + 5000;
      while (await audience.webContents.executeJavaScript('document.body.dataset.slide') !== 'slide-' + i) {
        if (Date.now() > deadline) throw Error('hidden audience did not render advance');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // macOS capture colour conversion can map CSS red to approximately BGRA 26,39,251,255.
      const paintDeadline = Date.now() + 5000;
      let pixel;
      do {
        const frame = await audience.webContents.capturePage();
        if (frame.isEmpty()) throw Error('empty rendered frame');
        const {width, height} = frame.getSize();
        const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
        pixel = frame.toBitmap().subarray(offset, offset + 4);
        if (pixel[2] >= 230 && pixel[1] <= 60 && pixel[0] <= 60) break;
        if (Date.now() > paintDeadline) throw Error('captured frame did not turn red: ' + [...pixel]);
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (true);
      console.log('PASS hidden production audience path ' + i + ': BroadcastChannel, animation frame, capture');
      // Keep the host alive between paths; all windows remain hidden until app.exit.
    }
    app.exit(0);
  } catch (error) { console.error(error); for (const w of windows) if (!w.isDestroyed()) w.destroy(); app.exit(1); }
});
`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.TW_E2E
  const childProcess = spawn(createRequire(import.meta.url)('electron'), [join(scratch, 'host.cjs')], { cwd: repo, env, stdio: 'inherit' })
  const timer = setTimeout(() => childProcess.kill(), 20000)
  try {
    const code = await new Promise((resolve, reject) => { childProcess.once('error', reject); childProcess.once('exit', resolve) })
    assert.equal(code, 0, 'hidden Electron host exits successfully')
  } finally { clearTimeout(timer) }
} finally { rmSync(scratch, { recursive: true, force: true }) }
