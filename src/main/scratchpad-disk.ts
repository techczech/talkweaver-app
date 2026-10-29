// Scratchpad filesystem authority. A child starts in the checked talk directory and then pins
// scratchpad as its own working directory. Every talk mutation is one relative filename: a
// subsequent directory/symlink replacement cannot redirect it. Main's cwd never changes.
// Reads are opened once, checked against lstat, and consumed through that descriptor. Consumers
// receive private, content-addressed copies, never paths back into the agent-writable folder.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

export interface ScratchFileIdentity { dev: number; ino: number }
export interface ScratchDiskFile { name: string; path: string; mtime: string; sidecar: string | null }
export interface ScratchDiskScan {
  folder: ScratchFileIdentity | null
  state: { text: string | null; error: string | null }
  files: ScratchDiskFile[]
  notices: string[]
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>()
let cache: string | undefined
function cacheFolder(): string {
  if (!cache) {
    cache = realpathSync(mkdtempSync(join(tmpdir(), 'talkweaver-scratch-snapshots-')))
    const owned = cache
    process.once('exit', () => {
      for (const child of activeChildren) { try { child.kill() } catch { /* already gone */ } }
      try { rmSync(owned, { recursive: true, force: true }) } catch { /* OS temp cleanup */ }
    })
  }
  return cache
}

/** Stable thumbnail identity for one of this process's private, write-once snapshots. */
export function scratchSnapshotIdentity(path: string): string | null {
  if (!cache) return null
  const parts = relative(cache, path).split(sep)
  return parts.length === 2 && /^[a-f0-9]{64}$/.test(parts[0]) && parts[1] !== '' && !parts[1].startsWith('.')
    ? `${parts[0]}/${parts[1]}` : null
}

// Constant Node program; no outline, filename or content is interpolated into executable text.
// Electron runs it in Node-only mode, including in signed packages. No window or profile opens.
const IO_SCRIPT = String.raw`
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
const identity = (s) => ({dev:s.dev, ino:s.ino});
const plain = (n) => typeof n === 'string' && n !== '' && !/[\\/\0]/.test(n) && !n.startsWith('.');
const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
function readPlain(name, max = 64 * 1024 * 1024) {
  const listed = fs.lstatSync(name);
  if (!listed.isFile()) throw new Error(listed.isSymbolicLink() ? 'is a link' : 'is not a plain file');
  if (listed.size > max) throw new Error('is too large to read safely');
  const fd = fs.openSync(name, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !same(listed, opened)) throw new Error('changed while opening');
    if (opened.size > max) throw new Error('is too large to read safely');
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd,bytes,offset,bytes.length-offset,null);
      if (n === 0) throw new Error('changed while reading');
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (!same(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('changed while reading');
    return {bytes, info:after};
  } finally { fs.closeSync(fd); }
}
function run(job) {
  if (!same(fs.statSync('.'), job.talkId) || fs.realpathSync('.') !== job.talk) throw new Error('The talk folder changed. Nothing was changed.');
  let info;
  try { info = fs.lstatSync('scratchpad'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!info && job.action === 'scan') return {folder:null, state:{text:null,error:null}, files:[], notices:[]};
  if (!info) { fs.mkdirSync('scratchpad'); info = fs.lstatSync('scratchpad'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Scratchpad folder is a link or is not a folder. Nothing was changed.');
  if (job.folder && !same(info,job.folder)) throw new Error('The Scratchpad folder changed. Nothing was changed.');
  process.chdir('scratchpad');
  const held = fs.statSync('.'); const heldPath = fs.realpathSync('.');
  const holds = () => {
    const named = fs.lstatSync(job.folderPath);
    if (!named.isDirectory() || named.isSymbolicLink() || !same(named,held) || fs.realpathSync('.') !== heldPath) throw new Error('The Scratchpad folder changed. Nothing was changed.');
    if (!same(fs.statSync(job.talk),job.talkId) || fs.realpathSync(job.talk) !== job.talk) throw new Error('The talk folder changed. Nothing was changed.');
  };
  if (!same(info,held)) throw new Error('The Scratchpad folder changed. Nothing was changed.');
  holds();
  const state = () => {
    try { return {text:readPlain('scratchpad-state.json').bytes.toString('utf8'),error:null}; }
    catch (e) { return e.code === 'ENOENT' ? {text:null,error:null} : {text:null,error:e.message}; }
  };
  if (job.action === 'scan') {
    const saved = state(); const files = []; const notices = [];
    for (const name of fs.readdirSync('.').sort()) {
      if (!plain(name) || !job.extensions.includes(path.extname(name).toLowerCase())) continue;
      try {
        const source = readPlain(name);
        const hash = crypto.createHash('sha256').update(source.bytes).digest('hex');
        const bucket = path.join(job.cache,hash); fs.mkdirSync(bucket,{recursive:true,mode:0o700});
        const copy = path.join(bucket,name);
        let existing;
        try { existing = fs.lstatSync(copy); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (existing && !existing.isFile()) throw new Error('Invalid private snapshot');
        if (!existing) {
          const staging = path.join(bucket,'.'+crypto.randomBytes(12).toString('hex')+'.tmp');
          try {
            fs.writeFileSync(staging,source.bytes,{flag:'wx',mode:0o600});
            try { fs.renameSync(staging,copy); }
            catch (e) { if (!['EEXIST','EPERM','EACCES'].includes(e.code) || !fs.lstatSync(copy).isFile()) throw e; }
          } finally { try { fs.unlinkSync(staging); } catch {} }
        }
        let sidecar = null;
        try { sidecar = readPlain(name+'.json',256*1024).bytes.toString('utf8'); } catch {}
        files.push({name,path:copy,mtime:source.info.mtime.toISOString(),sidecar});
      } catch (e) {
        if (e.message === 'is too large to read safely') notices.push('The Scratchpad file '+JSON.stringify(name)+' is larger than 64 MB, so it was not loaded. The original was left unchanged.');
        // Vanished, linked, unreadable or changing: never consume a replacement.
      }
    }
    holds();
    return {folder:identity(held),state:saved,files,notices};
  }
  const before = state();
  if (before.error || before.text !== job.previous) throw new Error('The Scratchpad saved state changed or could not be read. Nothing was changed.');
  if (job.action === 'backup') {
    if (!plain(job.name) || !job.name.startsWith('scratchpad-state.broken-') || !job.name.endsWith('.json')) throw new Error('Invalid recovery filename');
    fs.writeFileSync(job.name,job.previous,{flag:'wx',mode:0o600});
  } else if (job.action === 'write') {
    const temp = '.scratchpad-state.json.'+process.pid+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
    try { fs.writeFileSync(temp,job.text,{flag:'wx',mode:0o600}); fs.renameSync(temp,'scratchpad-state.json'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
    if (readPlain('scratchpad-state.json').bytes.toString('utf8') !== job.text) throw new Error('The Scratchpad write could not be confirmed.');
  } else { throw new Error('Unknown Scratchpad operation'); }
  holds();
  return null;
}
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => { try { process.stdout.write(JSON.stringify({ok:true,value:run(JSON.parse(input))})); } catch(e) { process.stdout.write(JSON.stringify({ok:false,error:e.message})); process.exitCode=1; } });
`

export function createScratchpadDisk(talkDir: string, spawnChild: typeof spawn = spawn) {
  const talk = realpathSync(talkDir)
  const talkId = statSync(talk)
  const folderPath = join(talk, 'scratchpad')
  function run<T>(request: Record<string, unknown>): Promise<T> {
    const input = JSON.stringify({ ...request, talk, talkId: { dev: talkId.dev, ino: talkId.ino }, folderPath, cache: cacheFolder() })
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
      // Built-ins only: never inherit loaders, module paths, injected libraries or inspector hooks.
      // Windows needs its OS root for the runtime; no program is looked up on PATH.
      if (process.platform === 'win32') childEnv.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      const child = spawnChild(process.execPath, ['-e', IO_SCRIPT], {
        cwd: talk, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      })
      activeChildren.add(child)
      let output = ''; let diagnostic = ''; let done = false
      const finish = (error?: Error): void => {
        if (done) return
        done = true; clearTimeout(timer)
        if (error) { child.kill(); reject(error); return }
        try {
          const answer = JSON.parse(output) as { ok: boolean; value?: T; error?: string }
          if (!answer.ok) reject(new Error(answer.error ?? 'The Scratchpad operation failed.'))
          else resolve(answer.value as T)
        } catch { reject(new Error(`The Scratchpad operation did not answer. ${diagnostic.slice(0, 300)}`)) }
      }
      const timer = setTimeout(() => finish(new Error('The Scratchpad operation did not finish. Nothing was set aside.')), 15_000)
      child.on('error', finish)
      child.stdin.on('error', (error) => finish(error))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output.length > 64 * 1024 * 1024) finish(new Error('The Scratchpad answer was too large.'))
      })
      child.stderr.on('data', (chunk: Buffer) => { if (diagnostic.length < 1000) diagnostic += chunk.toString() })
      child.on('close', () => { activeChildren.delete(child); finish() })
      child.stdin.end(input)
    })
  }
  return {
    scan: (extensions: string[]): Promise<ScratchDiskScan> => run({ action: 'scan', extensions }),
    write: (text: string, previous: string | null, folder: ScratchFileIdentity | null): Promise<void> => run({ action: 'write', text, previous, folder }),
    backup: (name: string, previous: string, folder: ScratchFileIdentity | null): Promise<void> => run({ action: 'backup', name, previous, folder })
  }
}
