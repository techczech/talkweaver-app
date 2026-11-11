#!/usr/bin/env node
/** Built app only. Run under agent-run. Mutates only an explicitly disposable .perf-fixture vault.
 * Usage: npm run perf:large-talk -- VAULT OUTPUT.json [--talk=relative/outline.md] [--session-seconds=600]
 * --session-seconds=0 is a cheap repeat, not the ten-minute memory baseline.
 * Traces retain timings and code frames only; never source strings, screenshots or IPC payloads.
 */
import { _electron as electron } from "playwright";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openTalkByTitle } from "../../e2e/lib/talklist.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [vaultArg, outputArg, ...flags] = process.argv.slice(2);
if (!vaultArg || !outputArg)
  throw Error("Expected VAULT OUTPUT.json [--talk=relative/outline.md] [--session-seconds=600]");
const vault = realpathSync(resolve(vaultArg)), output = resolve(outputArg);
if (!output.endsWith(".json"))
  throw Error("Output filename must end in .json");
if (!vault.startsWith(realpathSync(join(repo, ".perf-fixture")) + "/"))
  throw Error("Only disposable vaults inside this worktree/.perf-fixture are allowed");
const opt = Object.fromEntries(flags.map((s) => s.replace(/^--/, "").split("=")));
const seconds = Number(opt["session-seconds"] ?? 600);
if (!Number.isFinite(seconds) || seconds < 0)
  throw Error("Invalid session duration");
function outlines(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() && !e.name.startsWith(".") ? outlines(join(dir, e.name)) : e.isFile() && e.name.endsWith("-outline.md") ? [join(dir, e.name)] : []);
}
const foundOutline = opt.talk ? resolve(vault, opt.talk) : outlines(vault)[0];
const outline = foundOutline ? realpathSync(foundOutline) : null;
if (!outline || !outline.startsWith(vault + "/"))
  throw Error("No contained outline");
const presentPath = outline.replace(/-outline\.md$/, "-present.html"), hadPresent = existsSync(presentPath);
const original = readFileSync(outline), source = original.toString("utf8");
const title = source.match(/^title:\s*["']?([^\n]*?)["']?\s*$/m)?.[1] || basename(dirname(outline));
mkdirSync(dirname(output), { recursive: true });
const scratch = mkdtempSync(join(repo, ".perf-fixture", "probe-runtime-"));
for (const p of ["home", "userData", "tmp", "cache", "config"])
  mkdirSync(join(scratch, p), { recursive: true });
writeFileSync(join(scratch, "userData", "config.json"), JSON.stringify({ vaultRoot: vault }));
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}`, HOME: join(scratch, "home"), CFFIXED_USER_HOME: join(scratch, "home"), TW_E2E_HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), XDG_CACHE_HOME: join(scratch, "cache"), XDG_CONFIG_HOME: join(scratch, "config"), TW_E2E: "1", TW_REC_TEST: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const result = { schema: 1, created: (/* @__PURE__ */ new Date()).toISOString(), version: JSON.parse(readFileSync(join(repo, "package.json"))).version, fixture: relative(vault, outline), outlineSha256: createHash("sha256").update(original).digest("hex"), probeSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), host: { platform: process.platform, arch: process.arch, node: process.version }, sourceHeadings: (source.match(/^#{1,6} /gm) || []).length, cpuThrottle: 3, mainProcessThrottled: false, sessionSeconds: seconds, measurements: {}, memory: [], errors: [], limitations: ["Double requestAnimationFrame is a paint-opportunity proxy; hidden Electron windows do not prove physical display latency.", "CPU throttle applies to the editor renderer only; main process, workers, GPU and other webContents are not throttled.", "TW_E2E disables normal background prewarm and network-dependent capture.", "Continuous tracing, CPU profiling and filesystem wrappers add overhead; samples are instrumented baselines.", "Event-loop delay shows blocking but does not identify a unique responsible stack. CPU samples and trace frames are correlational."] };
let app, page, cdp, rendererProfile = null, tracing = false, traceEvents = [], phase = "launch";
async function mainRead(fn) {
  for (let i = 0; ; i++) {
    try {
      return await app.evaluate(fn);
    } catch (e) {
      if (i >= 4 || !String(e).includes("Execution context was destroyed"))
        throw e;
      result.inspectorReadRetries = (result.inspectorReadRetries || 0) + 1;
      await page.waitForTimeout(100);
    }
  }
}
const t0 = performance.now();
result.startEpochMs = Date.now();
const summary = (a) => {
  const s = [...a].sort((a2, b) => a2 - b);
  return { n: s.length, p50: s[Math.floor((s.length - 1) * 0.5)] ?? null, p95: s[Math.floor((s.length - 1) * 0.95)] ?? null, max: s.at(-1) ?? null };
};
function cleanURL(s = "") {
  if (s.includes(repo + "/")) {
    const name = s.slice(s.indexOf(repo + "/") + repo.length + 1);
    return name.startsWith(".perf-fixture/") ? "[fixture-or-generated]" : name.split("?")[0];
  }
  if (s.startsWith("node:"))
    return s;
  if (s.startsWith("file:") || s.startsWith("data:") || s.startsWith("tw"))
    return "[fixture-or-generated]";
  return s.split("?")[0].replace(/\/Users\/[^/]+/g, "[home]");
}
function frame(f) {
  return { functionName: (f.functionName || "").startsWith("RegExp:") ? "[regexp]" : f.functionName || "", url: cleanURL(f.url), lineNumber: f.lineNumber, columnNumber: f.columnNumber };
}
function cleanEvent(e) {
  const data = e.args?.data;
  return { name: e.name, cat: e.cat, ph: e.ph, ts: e.ts, dur: e.dur, pid: e.pid, tid: e.tid, args: e.ph === "M" ? { name: e.args?.name } : data ? { stackTrace: data.stackTrace?.map(frame), functionName: data.functionName, url: cleanURL(data.url || data.scriptName || ""), lineNumber: data.lineNumber, columnNumber: data.columnNumber } : void 0 };
}
const scrollSettled = () => page.evaluate(() => new Promise((resolve2) => {
  const root = document.querySelector("[data-place-region=strip]");
  const el = root && [...root.children].find((n) => getComputedStyle(n).overflowY === "auto");
  if (!el) {
    resolve2({ unavailable: true });
    return;
  }
  const start = performance.now();
  let last = el.scrollTop, stable = 0;
  function tick(now) {
    stable = Math.abs(last - el.scrollTop) < 0.5 ? stable + 1 : 0;
    last = el.scrollTop;
    if (stable >= 5 && now - start > 100 || now - start > 3e3)
      resolve2({ ms: now - start, settled: stable >= 5 });
    else
      requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}));
const paint = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
async function timed(name, fn) {
  phase = name;
  const t = performance.now();
  try {
    const detail = await fn();
    result.measurements[name] = { startMs: t - t0, ms: performance.now() - t, ...detail };
    console.log(JSON.stringify({ phase: name, ...result.measurements[name] }));
  } catch (e) {
    result.measurements[name] = { error: String(e.message).split("\n")[0] };
    result.errors.push({ phase: name, error: String(e.message).split("\n")[0] });
    console.log(JSON.stringify({ phase: name, error: String(e.stack).replaceAll(repo, "[repo]").replaceAll(vault, "[vault]").replaceAll(title, "[talk-title]") }));
  }
}
async function mainStats() {
  return app.evaluate(async ({ app: app2, webContents }) => ({ metrics: app2.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu, memory: m.memory })), webContents: await Promise.all(webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map(async (w) => ({ id: w.id, type: w.getType(), osPid: w.getOSProcessId(), frames: w.mainFrame.framesInSubtree.length, dom: await w.executeJavaScript(`(()=>({iframes:document.querySelectorAll('iframe').length,webviews:document.querySelectorAll('webview').length,liveFrames:[...document.querySelectorAll('iframe')].filter(f=>f.srcdoc||f.getAttribute('src')&&!['about:blank',''].includes(f.getAttribute('src'))).length,offSlideLiveFrames:[...document.querySelectorAll('.slide:not(.active) iframe')].filter(f=>f.srcdoc||f.getAttribute('src')&&!['about:blank',''].includes(f.getAttribute('src'))).length,slides:document.querySelectorAll('#stage .slide').length,images:document.images.length,incompleteImages:[...document.images].filter(i=>!i.complete).length}))()`).catch(() => null) }))), mainMemory: process.memoryUsage(), inflight: globalThis.__largePerf?.inflight, loop: globalThis.__largePerf?.delay ? { maxMs: globalThis.__largePerf.delay.max / 1e6, p95Ms: globalThis.__largePerf.delay.percentile(95) / 1e6 } : null }));
}
async function sample() {
  result.memory.push({ elapsedMs: performance.now() - t0, phase, main: await mainStats(), renderer: await page.evaluate(() => ({ heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null, iframes: document.querySelectorAll("iframe").length, webviews: document.querySelectorAll("webview").length, domNodes: document.getElementsByTagName("*").length })), frames: page.frames().length });
  writeFileSync(output, JSON.stringify(result, null, 2));
}
async function editorPosition(index, sourceLine = null) {
  return page.evaluate(({index2, sourceLine}) => {
    const v = document.querySelector(".cm-content")?.cmTile?.root?.view;
    if (!v)
      throw Error("CodeMirror view unavailable");
    const hs = [...v.state.doc.toString().matchAll(/^### .+$/gm)];
    const h = hs[Math.min(index2, hs.length - 1)];
    if (!h)
      throw Error("No slide heading");
    const targetLine = Number.isInteger(sourceLine) && sourceLine > 0 && sourceLine <= v.state.doc.lines ? v.state.doc.line(sourceLine) : null;
    const at = targetLine ? targetLine.to : h.index + h[0].length;
    v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    v.focus();
    return { headings: hs.length, index: targetLine ? Math.max(0, hs.findIndex(h => h.index >= targetLine.from)) : Math.min(index2, hs.length - 1) };
  }, {index2:index, sourceLine});
}
try {
  app = await electron.launch({ args: [".", "--use-mock-keychain", `--user-data-dir=${join(scratch, "userData")}`], cwd: repo, env, timeout: 6e4 });
  page = await app.firstWindow();
  page.setDefaultTimeout(2e4);
  await app.evaluate(async ({ app: app2, BrowserWindow, ipcMain }) => {
    const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const p = globalThis.__largePerf = { delay, ipc: [], drift: [], started: performance.now(), epochMs: Date.now(), inflight: {}, maxInflight: {}, rowKeys: [], rowLines: [], thumbnailWarnings: [], fsStats: {}, slowFs: [] };
    for(const method of ["warn","error"]){const old=console[method];console[method]=function(...args){const text=String(args[0]);if(text.startsWith("[thumbnails]"))p.thumbnailWarnings.push({kind:text.includes("not loaded")?"image-not-loaded":text.includes("isolate")?"wrong-active-slide":text.includes("failed to render")?"render-failed":text.includes("aborted")?"aborted":"other",slideIndex:Number(text.match(/slide (\d+)/)?.[1]??-1),errorName:args[1]?.name});return old.apply(this,args)}}
    const fs = process.getBuiltinModule("node:fs");
    for (const key of ["readFileSync", "writeFileSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "existsSync"]) {
      const old = fs[key];
      fs[key] = function(...args) {
        const t = performance.now();
        try {
          return old.apply(this, args);
        } finally {
          const ms = performance.now() - t;
          const stat = p.fsStats[key] ??= { calls: 0, totalMs: 0, maxMs: 0 };
          stat.calls++;
          stat.totalMs += ms;
          stat.maxMs = Math.max(stat.maxMs, ms);
          if (ms > 5)
            p.slowFs.push({ operation: key, startMs: t - p.started, ms, stack: new Error().stack.split("\n").slice(2, 8).join("\n") });
        }
      };
      Object.assign(fs[key], old);
    }
    let last = performance.now();
    p.timer = setInterval(() => {
      const now = performance.now(), ms = now - last - 20;
      if (ms > 100)
        p.drift.push({ atMs: now - p.started, delayMs: ms });
      last = now;
    }, 20);
    p.focus = [];
    ipcMain.prependListener("talk:thumbnail-focus", (_e, _path, indices) => { p.focus.push({ atMs: performance.now() - p.started, indices: Array.isArray(indices) ? indices.slice(0, 12) : null }); });
    for (const channel of ["talk:compile", "talk:thumbnails", "talk:present"]) {
      const old = ipcMain._invokeHandlers.get(channel);
      if (!old)
        continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const start = performance.now();
        p.inflight[channel] = (p.inflight[channel] || 0) + 1;
        p.maxInflight[channel] = Math.max(p.maxInflight[channel] || 0, p.inflight[channel]);
        try {
          const r = await old(...args);
          if (channel === "talk:compile" && Array.isArray(r))
            {p.rowKeys = r.map((x) => x.render_hash || x.content_hash || x.slide_id).filter(Boolean);p.rowLines=r.map(x=>x.source_line??null);}
          p.ipc.push({ channel, startMs: start - p.started, ms: performance.now() - start, rows: Array.isArray(r) ? r.length : void 0, keys: channel === "talk:thumbnails" && r ? Object.keys(r).length : void 0, matchedRows: channel === "talk:thumbnails" && r ? p.rowKeys.filter((k) => r[k]).length : void 0, missingRowIndices: channel === "talk:thumbnails" && r ? p.rowKeys.flatMap((key,i)=>r[key]?[]:[i]) : void 0, expectedRows: channel === "talk:thumbnails" ? p.rowKeys.length : void 0 });
          return r;
        } catch (e) {
          p.ipc.push({ channel, ms: performance.now() - start, error: true });
          throw e;
        } finally {
          p.inflight[channel]--;
        }
      });
    }
    for (const w of BrowserWindow.getAllWindows())
      w.setSize(1440, 900);
    if (app2.getPath("userData").indexOf("probe-runtime-") < 0)
      throw Error("Isolation failed");
    if (BrowserWindow.getAllWindows().some((w) => w.isVisible()))
      throw Error("Window unexpectedly visible");
    const inspector = process.getBuiltinModule("node:inspector"), session = new inspector.Session();
    session.connect();
    p.inspector = session;
    await new Promise((r, j) => session.post("Profiler.enable", (e) => e ? j(e) : r()));
    await new Promise((r, j) => session.post("Profiler.start", (e) => e ? j(e) : r()));
  });
  result.editorWebContentsId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 3 });
  cdp.on("Tracing.dataCollected", ({ value }) => {
    traceEvents.push(...value.filter((e) => e.ph === "X" || e.name === "thread_name" || e.name === "process_name").map(cleanEvent));
  });
  await cdp.send("Tracing.start", { categories: "devtools.timeline,v8.execute,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" });
  tracing = true;
  await page.waitForLoadState("domcontentloaded");
  result.rendererTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => {
    window.__largePerf = { keys: [], clicks: [], arrows: [], longTasks: [], compile: [], visibleThumbs: {} };
    // Time to the first VISIBLE thumbnails: the active card's picture, and every card in the strip's
    // viewport with a loaded picture (Date.now() epochs; the probe subtracts its own start).
    {
      const v = window.__largePerf.visibleThumbs, started = Date.now();
      const has = (c) => { const i = c.querySelector("img"); return !!(i && i.complete && i.naturalWidth > 0); };
      const watch = setInterval(() => {
        if (Date.now() - started > 24e4) { clearInterval(watch); return; }
        const cards = [...document.querySelectorAll("[data-slide-index]")];
        if (!cards.length) return;
        let el = cards[0].parentElement;
        while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        const view = (el || document.documentElement).getBoundingClientRect();
        const visible = cards.filter((c) => { const b = c.getBoundingClientRect(); return b.height > 0 && b.bottom > view.top && b.top < view.bottom; });
        const ready = visible.filter(has).length;
        const active = cards.find((c) => c.dataset.active === "true");
        v.last = { visible: visible.length, ready, indices: visible.map((c) => Number(c.dataset.slideIndex)) };
        if (v.firstAnyEpoch === undefined && cards.some(has)) v.firstAnyEpoch = Date.now();
        if (v.activeEpoch === undefined && active && has(active)) { v.activeEpoch = Date.now(); v.activeIndex = Number(active.dataset.slideIndex); }
        if (v.allVisibleEpoch === undefined && visible.length > 0 && ready === visible.length) { v.allVisibleEpoch = Date.now(); v.allVisible = v.last; }
        if (v.activeEpoch !== undefined && v.allVisibleEpoch !== undefined) clearInterval(watch);
      }, 50);
    }
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.duration > 100)
          window.__largePerf.longTasks.push({ startMs: e.startTime, ms: e.duration, attribution: e.attribution.map((a) => ({ name: a.name, containerType: a.containerType })) });
    }).observe({ type: "longtask", buffered: true });
    document.addEventListener("click", (e) => { if(e.target.closest?.("[data-slide-index]")){const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__largePerf.clicks.push(performance.now()-t)))} }, true);
    document.addEventListener("keydown", (e) => {
      if(e.target.closest?.("[data-place-region=strip]") && e.key.startsWith("Arrow")){const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__largePerf.arrows.push(performance.now()-t)))}
      if (e.target.closest?.(".cm-content") && e.key.length === 1) {
        const t = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => window.__largePerf.keys.push(performance.now() - t)));
      }
    }, true);
  });
  await timed("openEditable", async () => {
    await openTalkByTitle(page, title, { timeout: 6e4 });
    await paint();
    return { launchToEditableMs: performance.now() - t0 };
  });
  if (!await page.locator(".cm-content").count())
    throw Error("Talk did not open");
  if (!await page.locator("[data-right-column]").count())
    await page.locator('[data-testid="sidebar-toggle"]').click().catch(() => {
    });
  if (await page.locator('[data-rc-tab="slides"] button').count())
    await page.locator('[data-rc-tab="slides"] button').click();
  // The author scrolls to mid-talk while the cold thumbnails are still being made: how long until every
  // card in the strip's viewport has its picture (the thumbnail render's visible-first ordering).
  await timed("midStripVisible", async () => {
    // After the first compile has landed (the strip then shows compiled rows and stops re-following the
    // active slide) and the first picture is up, i.e. while the cold render is under way.
    const waitStart = performance.now();
    while (performance.now() - waitStart < 6e4 && !await mainRead(() => globalThis.__largePerf.ipc.some((e) => e.channel === "talk:compile"))) await page.waitForTimeout(100);
    await page.waitForFunction(() => document.querySelectorAll("[data-slide-index]").length > 40 && !!document.querySelector('[data-slide-index][data-active="true"] img'), null, { timeout: 6e4 });
    await page.waitForTimeout(300);
    const scrolledAt = await page.evaluate(() => {
      const card = document.querySelector("[data-slide-index]");
      let el = card.parentElement;
      while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el) return null;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      el.dispatchEvent(new Event("scroll"));
      return Date.now();
    });
    if (!scrolledAt) throw Error("Strip scroller not found");
    const start = performance.now();
    let seen = null;
    while (performance.now() - start < 12e4) {
      seen = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("[data-slide-index]")];
        let el = cards[0]?.parentElement;
        while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        const view = (el || document.documentElement).getBoundingClientRect();
        const visible = cards.filter((c) => { const b = c.getBoundingClientRect(); return b.height > 0 && b.bottom > view.top && b.top < view.bottom; });
        const ready = visible.filter((c) => { const i = c.querySelector("img"); return !!(i && i.complete && i.naturalWidth > 0); }).length;
        return { at: Date.now(), visible: visible.length, ready, indices: visible.map((c) => Number(c.dataset.slideIndex)) };
      });
      if (seen.visible > 0 && seen.ready === seen.visible) return { thumbnailRequestStillRunning: !await mainRead(() => globalThis.__largePerf.ipc.some((e) => e.channel === "talk:thumbnails")), scrollToAllVisibleMs: seen.at - scrolledAt, launchToScrollMs: scrolledAt - result.startEpochMs, ...seen };
      await page.waitForTimeout(100);
    }
    return { scrollToAllVisibleMs: null, launchToScrollMs: scrolledAt - result.startEpochMs, ...seen };
  });
  await timed("allThumbnails", async () => {
    await page.waitForFunction(() => !document.querySelector(".workspace-toolbar .spin, .workspace-toolbar .spinning") && document.querySelectorAll("[data-slide-index]").length > 0, null, { timeout: 3e4 }).catch(() => {
    });
    const start = performance.now();
    let done;
    while (performance.now() - start < 24e4) {
      done = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:thumbnails").at(-1) || null);
      if (done && done.keys > 0)
        break;
      await page.waitForTimeout(250);
    }
    if (!done || !done.keys)
      throw Error("Thumbnail completion timeout 240s");
    const rows = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile").at(-1)?.rows ?? null);
    const vis = await page.evaluate(() => window.__largePerf.visibleThumbs);
    const since = (epoch) => epoch === undefined ? null : epoch - result.startEpochMs;
    const openedAt = result.measurements.openEditable?.launchToEditableMs ?? null;
    const visibleThumbnails = { launchToFirstAnyMs: since(vis.firstAnyEpoch), launchToActiveMs: since(vis.activeEpoch), activeIndex: vis.activeIndex ?? null, launchToAllVisibleMs: since(vis.allVisibleEpoch), allVisible: vis.allVisible ?? null, lastSeen: vis.last ?? null, launchToEditableMs: openedAt };
    return { visibleThumbnails, launchToCompletionMs: performance.now() - t0, requestMs: done.ms, rows, mountedThumbs: await page.locator("[data-slide-index] img").evaluateAll((images) => ({ count: images.length, loaded: images.filter((i) => i.complete && i.naturalWidth > 0).length })), keys: done.keys, matchedRows: done.matchedRows, missingRowIndices:done.missingRowIndices, allReady: done.matchedRows === done.expectedRows && done.expectedRows > 0 };
  });
  await sample();
  const middle = await mainRead(()=>{const lines=globalThis.__largePerf.rowLines;let i=Math.floor(lines.length/2);while(i<lines.length&&!Number.isInteger(lines[i]))i++;return {compiledIndex:i,sourceLine:lines[i]??null}});
  const pos = await editorPosition(Math.floor(result.sourceHeadings / 2),middle.sourceLine);
  result.midTalk = {...pos,...middle};
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await timed("typing", async () => {
    const beforeLength = await page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.length);
    const beforeCompiles = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile").length);
    for (let i = 0; i < 200; i++) {
      await page.keyboard.type("x");
      await page.waitForTimeout(30);
    }
    await paint();
    const addedCharacters = (await page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.length)) - beforeLength;
    if(addedCharacters !== 200)throw Error(`Expected 200 inserted characters, got ${addedCharacters}`);
    const latency = summary(await page.evaluate(() => window.__largePerf.keys));
    if (latency.n !== 200)
      throw Error(`Expected 200 keystroke samples, got ${latency.n}`);
    return { ...latency, addedCharacters, compileCompletionsDuringTyping: await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile").length) - beforeCompiles };
  });
  let refreshThumbBefore = 0, refreshEditStart = 0;
  await timed("compileRefresh", async () => {
    refreshThumbBefore = await mainRead(()=>globalThis.__largePerf.ipc.filter(e=>e.channel==="talk:thumbnails").length);
    const before = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile").length);
    refreshEditStart = performance.now();
    await page.keyboard.type("z");
    await page.waitForFunction(() => document.querySelector(".cm-content") !== null);
    const start = performance.now();
    while (performance.now() - start < 12e4) {
      const n = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile").length);
      if (n > before)
        break;
      await page.waitForTimeout(50);
    }
    const calls = await mainRead(() => globalThis.__largePerf.ipc.filter((e) => e.channel === "talk:compile"));
    if (calls.length <= before)
      throw Error("No compile observed");
    await paint();
    return { compileIpcMs: calls.at(-1).ms };
  });
  await timed("thumbnailRefresh", async () => {
    const waitStart = performance.now();
    let reply = null;
    while(performance.now()-waitStart < 120000){
      const replies = await mainRead(()=>globalThis.__largePerf.ipc.filter(e=>e.channel==="talk:thumbnails"));
      if(replies.length > refreshThumbBefore){reply=replies.at(-1);break}
      await page.waitForTimeout(50);
    }
    if(!reply)throw Error("Refresh thumbnail response timeout");
    await paint();
    const mainEpoch = await mainRead(()=>globalThis.__largePerf.epochMs);
    return {mapCompletionAfterEditMs:mainEpoch+reply.startMs+reply.ms-result.startEpochMs-(refreshEditStart-t0),paintOpportunityAfterEditMs:performance.now()-refreshEditStart,requestMs:reply.ms,matchedRows:reply.matchedRows,expectedRows:reply.expectedRows};
  });
  rendererProfile = (await cdp.send("Profiler.stop")).profile;
  rendererProfile.nodes = rendererProfile.nodes.map((n) => ({ ...n, callFrame: frame(n.callFrame) }));
  writeFileSync(output.replace(/\.json$/, ".renderer-profile.json"), JSON.stringify(rendererProfile));
  await timed("stripScroll", async () => {
    const cards = page.locator("[data-slide-index]");
    if (!await cards.count())
      throw Error("Strip cards not mounted");
    await cards.first().scrollIntoViewIfNeeded();
    const box = await cards.first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const gaps = await page.evaluate(() => {
      window.__scrollGaps = [];
      let last = performance.now();
      window.__scrollRaf = function tick(t) {
        window.__scrollGaps.push(t - last);
        last = t;
        window.__scrollId = requestAnimationFrame(tick);
      };
      window.__scrollId = requestAnimationFrame(window.__scrollRaf);
      return [];
    });
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(40);
    }
    return { frameGaps: summary(await page.evaluate(() => {
      cancelAnimationFrame(window.__scrollId);
      return window.__scrollGaps.filter((n) => n >= 0);
    })) };
  });
  await timed("slideClick", async () => {
    const cards = page.locator("[data-slide-index]");
    const card = cards.nth(Math.floor(await cards.count() / 2));
    await card.scrollIntoViewIfNeeded();
    const index = await card.getAttribute("data-slide-index");
    await card.click();
    await page.waitForFunction((i) => document.querySelector(`[data-slide-index="${i}"]`)?.getAttribute("data-active") === "true", index);
    await paint();
    const selectedMs = performance.now();
    return { index: Number(index), inputToPaintMs: await page.evaluate(()=>window.__largePerf.clicks.at(-1)??null), scrollTail: await scrollSettled(), selectionPaintAtMs: selectedMs - t0 };
  });
  await timed("slideArrow", async () => {
    const active = page.locator('[data-slide-index][data-active="true"]').first();
    await page.locator("[data-place-region=strip]").focus();
    const before = await active.getAttribute("data-slide-index");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction((i) => document.querySelector('[data-slide-index][data-active="true"]')?.getAttribute("data-slide-index") !== i, before);
    await paint();
    return { inputToPaintMs: await page.evaluate(()=>window.__largePerf.arrows.at(-1)??null), activeIndex: await page.locator('[data-slide-index][data-active="true"]').first().getAttribute("data-slide-index"), scrollTail: await scrollSettled() };
  });
  await timed("editorFollow", async () => {
    await editorPosition(Math.max(1, pos.index - 5));
    await paint();
    return { activeIndex: await page.locator('[data-slide-index][data-active="true"]').first().getAttribute("data-slide-index") };
  });
  await timed("insertSlide", async () => {
    await editorPosition(pos.index);
    const before = await page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString().match(/^### /gm).length);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("tw-run-command", { detail: "new-slide" })));
    await page.waitForFunction((n) => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString().match(/^### /gm).length > n, before, { timeout: 5e3 });
    await paint();
    return {};
  });
  await timed("moveSlide", async () => {
    await editorPosition(pos.index);
    const before = await page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString());
    await page.keyboard.press("Meta+Shift+ArrowDown");
    await page.waitForFunction((s) => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString() !== s, before, { timeout: 5e3 });
    await paint();
    return {};
  });
  await sample();
  await timed("presenter", async () => {
    await page.keyboard.press("F5");
    const start = performance.now();
    while (performance.now() - start < 12e4) {
      const p = app.windows().find((w) => w !== page && w.url().includes("present"));
      if (p) {
        await p.waitForSelector("#currentPreview iframe", { timeout: 6e4 });
        result.presenterFrames = p.frames().length;
        await p.close();
        return {};
      }
      await page.waitForTimeout(100);
    }
    throw Error("Presenter did not become ready");
  });
  await timed("editSession", async () => {
    const start = performance.now();
    let nextSample = 0, cycles = 0;
    while (performance.now() - start < seconds * 1e3) {
      await editorPosition(cycles * 11 % Math.max(1, pos.headings));
      const changed = await page.evaluate(() => {
        const view = document.querySelector(".cm-content").cmTile.root.view;
        const before = view.state.doc.length;
        view.dispatch({changes:{from:view.state.selection.main.head, insert:" p"}});
        return view.state.doc.length === before + 2;
      });
      if(!changed)throw Error("Scripted editor edit was refused");
      await page.waitForTimeout(1800);
      if (cycles % 4 === 0)
        await page.keyboard.press("Meta+s");
      if (performance.now() - start >= nextSample) {
        await sample();
        nextSample += 1e4;
      }
      cycles++;
    }
    await sample();
    return { cycles, verifiedEdits: cycles, editMethod: "CodeMirror dispatch through existing update/autosave callbacks", actualSeconds: (performance.now() - start) / 1e3 };
  });
  await page.waitForTimeout(2500);
  const finalBuffer = await page.evaluate(() => document.querySelector(".cm-content").cmTile.root.view.state.doc.toString());
  const finalDisk = readFileSync(outline, "utf8");
  result.reliability = { bufferDiskAgree: finalBuffer === finalDisk, bufferBytes: Buffer.byteLength(finalBuffer), diskBytes: Buffer.byteLength(finalDisk), bufferSha256: createHash("sha256").update(finalBuffer).digest("hex"), diskSha256: createHash("sha256").update(finalDisk).digest("hex") };
  result.renderer = await page.evaluate(() => window.__largePerf);
} catch (e) {
  result.errors.push({ phase, error: String(e.message).split("\n")[0] });
  console.log(JSON.stringify({ error: result.errors.at(-1) }));
  process.exitCode = 1;
} finally {
  if (app) {
    try {
      result.main = await app.evaluate(async () => {
        const p = globalThis.__largePerf;
        if (!p)
          return null;
        clearInterval(p.timer);
        p.delay.disable();
        const profile = await new Promise((r, j) => p.inspector.post("Profiler.stop", (e, v) => e ? j(e) : r(v.profile)));
        p.inspector.disconnect();
        return { thumbnailFocus:p.focus, thumbnailWarnings:p.thumbnailWarnings, epochMs: p.epochMs, inflight: p.inflight, maxInflight: p.maxInflight, prepareCount: globalThis.__twPrepareCount, ipc: p.ipc, drift: p.drift, fsStats: p.fsStats, slowFs: p.slowFs, delay: { maxMs: p.delay.max / 1e6, p95Ms: p.delay.percentile(95) / 1e6 }, profile };
      });
      if (result.main?.slowFs)
        result.main.slowFs = result.main.slowFs.map((x) => ({ ...x, stack: x.stack.split(repo + "/").join("").split(vault).join("[vault]") }));
      if (result.main?.profile) {
        result.main.profile.nodes = result.main.profile.nodes.map((n) => ({ ...n, callFrame: frame(n.callFrame) }));
        writeFileSync(output.replace(/\.json$/, ".main-profile.json"), JSON.stringify(result.main.profile));
        delete result.main.profile;
      }
    } catch (e) {
      result.errors.push({ phase: "main-finalise", error: String(e.message).split("\n")[0] });
    }
    if (tracing) {
      try {
        const complete = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
        await cdp.send("Tracing.end");
        await complete;
        writeFileSync(output.replace(/\.json$/, ".trace.json"), JSON.stringify({ traceEvents }));
        const tasks = traceEvents.filter((e) => e.dur > 1e5);
        result.traceLongTasks = tasks.sort((a, b) => b.dur - a.dur).slice(0, 100);
      } catch (e) {
        result.errors.push({ phase: "trace-finalise", error: String(e.message).split("\n")[0] });
      }
    }
    await app.close().catch(() => {
      app.process().kill("SIGKILL");
    });
  }
  writeFileSync(outline, original);
  if (!hadPresent)
    rmSync(presentPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  if (result.errors.length)
    process.exitCode = 1;
  result.totalMs = performance.now() - t0;
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output: relative(repo, output), errors: result.errors.length, totalMs: result.totalMs }));
}
