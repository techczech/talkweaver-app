// Resolve known static subresources before giving an embed its unchanged sandbox and CSP.
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { scanStartTags, decodeHtmlEntities } from './embed-frame.mjs';

export const WIDGET_DEPENDENCY_TYPES = new Map(Object.entries({
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt',
  '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html'
}));
export const WIDGET_MAX_BYTES = 24 * 1024 * 1024;
export const WIDGET_MAX_FILES = 128;

const RESOURCE_ATTRIBUTES = {
  script: ['src'], link: ['href'], img: ['src'], image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'], source: ['src'], video: ['src', 'poster'],
  audio: ['src'], track: ['src'], iframe: ['src'], input: ['src']
};

function cssReferences(css, offset = 0) {
  const refs = [];
  for (const match of css.matchAll(/\/\*[\s\S]*?\*\/|url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = match.slice(1).find((value) => value !== undefined);
    if (raw === undefined) continue;
    const start = offset + match.index + match[0].indexOf(raw, match[0].startsWith('@') ? 7 : 4);
    refs.push({ raw, start, end: start + raw.length });
  }
  return refs;
}

/** Locations of static file URLs. Comments and script text never supply markup attributes. */
export function widgetDependencyRefs(text, extension) {
  if (extension === '.css') return cssReferences(text);
  if (!['.html', '.htm', '.svg'].includes(extension)) return [];
  const refs = [];
  let ownBase = false;
  scanStartTags(text, ({ name, attributes, attributeLocations, contentStart, contentEnd }) => {
    if (name === 'base' && attributes.has('href')) ownBase = true;
    if (name === 'style') refs.push(...cssReferences(text.slice(contentStart, contentEnd), contentStart));
    const style = attributeLocations.get('style');
    if (style) refs.push(...cssReferences(text.slice(style.start, style.end), style.start));
    if (name === 'link' && !/^(?:stylesheet|icon|preload|modulepreload)$/i.test(attributes.get('rel') ?? '')) return;
    for (const attr of RESOURCE_ATTRIBUTES[name] ?? []) {
      const location = attributeLocations.get(attr);
      if (location) refs.push({ ...location, raw: decodeHtmlEntities(attributes.get(attr)) });
    }
  }, extension === '.svg');
  // An authored base changes what every relative URL means.
  return ownBase ? [] : refs;
}

export function widgetDependencyPath(parent, raw) {
  const written = raw.trim();
  if (!written || /^(?:[a-z][a-z0-9+.-]*:|[\\/#])/i.test(written) || written.includes('\\')) return null;
  let relative = written.split(/[?#]/)[0];
  try { relative = decodeURIComponent(relative); } catch { return null; }
  if (!relative || /[\\:\0]/.test(relative) || relative.startsWith('/') ||
      relative.split('/').some(part => part.startsWith('.') && part !== '.' && part !== '..')) return null;
  const path = resolve(dirname(parent), relative);
  const mime = WIDGET_DEPENDENCY_TYPES.get(extname(path).toLowerCase());
  return mime ? { path, mime } : null;
}

export async function inlineWidgetDependencies(text, entry, containment, stopAt, {
  maxBytes, allowsMedia, warn, omit
}) {
  let remaining = Math.min(WIDGET_MAX_BYTES, maxBytes);
  let files = WIDGET_MAX_FILES;
  const active = new Set([entry]);
  const cache = new Map();
  async function inline(source, location) {
    const leaveOut = (ref) => {
      omit(ref.raw);
      edits.push({ ...ref, uri: ref.end - ref.start >= 6 ? "data:," : "#" });
    };
    const refs = widgetDependencyRefs(source, extname(location).toLowerCase());
    const edits = [];
    for (const ref of refs) {
      const dependency = widgetDependencyPath(location, ref.raw);
      if (!dependency) continue;
      const { path, mime } = dependency;
      // Dependencies are implicit reads authorised by the widget's own talk folder as well as the vault.
      if (!path.startsWith(stopAt.lexical) || active.has(path)) continue;
      try {
        let uri = cache.get(path);
        if (!uri) {
          if (files-- <= 0) { leaveOut(ref); continue; }
          const found = await containment.file(path);
          if (!found.ok || !found.path.startsWith(stopAt.real)) { warn(ref.raw); continue; }
          const info = await stat(found.path);
          const audiovisual = /^(?:audio|video)\//.test(mime);
          if ((audiovisual && !allowsMedia(info.size)) || Math.ceil(info.size / 3) * 4 > remaining) {
            leaveOut(ref);
            continue;
          }
          const bytes = await readFile(found.path);
          active.add(path);
          try {
            const child = ['text/css', 'text/html', 'image/svg+xml'].includes(mime)
              ? await inline(bytes.toString('utf8'), path)
              : null;
            uri = `data:${mime};base64,${(child === null ? bytes : Buffer.from(child)).toString('base64')}`;
            // Bound the expanded output as well as the source reads (shared dependencies can fan out).
            cache.set(path, uri);
          } finally { active.delete(path); }
        }
        if (uri.length > remaining) { leaveOut(ref); continue; }
        remaining -= uri.length;
        edits.push({ ...ref, uri });
      } catch { warn(ref.raw); }
    }
    if (!edits.length) return null;
    let result = source;
    for (const { start, end, uri } of edits.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, start) + uri + result.slice(end);
    }
    return result;
  }
  return await inline(text, entry) ?? text;
}
