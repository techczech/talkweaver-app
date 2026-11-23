// Publication preflight uses the compiler's already-parsed model and the same containment authority.
// It checks readability without decoding images, inlining media or building HTML.
import { open } from 'node:fs/promises';
import { remoteReferenceUrl } from './asset-containment.mjs';

// The budget is for the advisory check. The normal build can still hydrate and read a cloud file.
async function readable(path, timeoutMs = 3000) {
  let timer;
  const work = (async () => {
    const handle = await open(path, 'r');
    try { await handle.read(Buffer.alloc(1), 0, 1, 0); return 'readable'; }
    catch { return 'unreadable'; }
    finally { await handle.close(); }
  })().catch(() => 'unreadable');
  try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve('not-downloaded'), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function checkPublicationFiles(model, sourceDir, containment) {
  const refs = [];
  const seen = new Set();
  const add = (value, slide) => {
    if (typeof value !== 'string' || !value || /^(?:data|blob):/i.test(value) || remoteReferenceUrl(value)) return;
    const key = `${slide}\0${value}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ file: containment.label(value), reference: value, slide }); }
  };
  const walk = (value, slide) => {
    if (!value || typeof value !== 'object') return;
    if (['image', 'video', 'audio', 'embed'].includes(value.type)) add(value.src, slide);
    if (value.type === 'title-poster') add(value.data?.logo, slide);
    if (Array.isArray(value.captures)) for (const capture of value.captures) add(capture?.src, slide);
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) for (const child of item) walk(child, slide);
      else if (item && typeof item === 'object') walk(item, slide);
    }
  };
  for (const slide of model.slides ?? []) walk(slide, String(slide.id ?? ''));
  const findings = [];
  const results = new Map();
  for (const ref of refs) {
    let reason = results.get(ref.reference);
    if (reason === undefined) {
      const found = await containment.reference(sourceDir, ref.reference);
      reason = found.ok ? await readable(found.path) : found.reason;
      results.set(ref.reference, reason);
    }
    if (reason !== 'readable') findings.push({ file: ref.file, slide: ref.slide, reason });
  }
  return { checked: results.size, findings };
}
