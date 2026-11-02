// Resource inventory over compiler HTML only. Never inspect embedded documents or fetch metadata.
import { escapeHtml } from './00-html.mjs';
import { parseVideoEmbed } from './image-line-rules.mjs';
import { renderSlideNavTitle } from './slide-script-render.mjs';

const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const decode = (text) => String(text ?? '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity) => {
  if (entity[0] !== '#') return entities[entity.toLowerCase()];
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
});
const plain = (html) => decode(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// Quote-aware tags keep srcdoc/data-embed-doc opaque, including their encoded markup. Raw text
// and comments cannot contribute links. This scans self-generated compiler HTML, not remote pages.
function* tags(html) {
  const pattern = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|template)\b[^>]*>[\s\S]*?<\/\1\s*>|<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const match of html.matchAll(pattern)) {
    if (!match[2]) continue;
    const attrs = new Map();
    for (const attr of match[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const key = attr[1].toLowerCase();
      if (!attrs.has(key)) attrs.set(key, decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    yield { name: match[2].toLowerCase(), attrs, end: match.index + match[0].length };
  }
}

function remoteUrl(href) {
  if (!/^https?:\/\/[^\s<>\\\u0000-\u001f\u007f]+$/i.test(href)) return null;
  try { return new URL(href); } catch { return null; }
}
const fallback = (url, video = false) => {
  const address = url.host.replace(/^www\./i, '') + (url.pathname === '/' ? '' : url.pathname);
  const player = /^(?:www\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be|(?:player\.)?vimeo\.com)$/i.test(url.hostname) ? parseVideoEmbed(url.href) : null;
  if (player) return `${player.kind === 'youtube' ? 'YouTube' : 'Vimeo'} video ${player.id}`;
  return video ? `Video: ${address}` : address;
};
const siblingLink = (file, id) => `${encodeURIComponent(String(file))}#${encodeURIComponent(decode(id))}`;

/** Exact decoded URL identity; first position wins, authored anchor labels outrank metadata, which outranks URL fallbacks. */
export function collectResources(slides, { exclude = [], slidesFile = '', sameTarget } = {}) {
  slides = Array.isArray(slides) ? slides : [];
  const titles = new Map();
  for (const slide of slides) {
    // A section root may carry content or an explicit content role. Its id still identifies
    // the section; an arbitrary child heading never supplies the section title.
    if (slide?.section && (slide.role === 'section-title' || (slide.id === slide.section && !titles.has(slide.section)))) {
      titles.set(slide.section, plain(renderSlideNavTitle(slide.html || '', { links: false })) || plain(slide.title || ''));
    }
  }
  const links = [];
  const seen = new Map();
  let previousSection = '', run = 0, localIndex = 0;
  for (const slide of slides) {
    const section = slide?.section || '';
    if (section !== previousSection) run++;
    previousSection = section;
    const html = String(slide?.html || '');
    for (const { name, attrs, end } of tags(html)) {
      const local = name === 'figure' && attrs.get('data-embed') === 'local';
      let href = '', label = '', generated = false;
      if (local) {
        if (!slidesFile || !slide.id) continue;
        href = siblingLink(slidesFile, slide.id);
        label = attrs.get('data-resource-title') || 'HTML page';
      } else if (name === 'a') {
        href = attrs.get('href') || '';
        const close = html.indexOf('</a', end);
        label = close < 0 ? '' : plain(html.slice(end, close));
        generated = (attrs.get('class') || '').split(/\s+/).includes('embed-open-link');
        if (!generated) label = attrs.get('aria-label') || label || attrs.get('title') || '';
      } else if (name === 'iframe' || name === 'video') {
        href = attrs.get('data-resource-url') || attrs.get('data-embed-url') || attrs.get('data-src') || attrs.get('src') || '';
        label = attrs.get('data-resource-title') || attrs.get('title') || '';
      } else continue;
      const url = local ? null : remoteUrl(href);
      if (!local && (!url || exclude.some(value => sameTarget?.(value, href)))) continue;
      const generic = !label || generated || label === href || label === attrs.get('data-src') || label === attrs.get('src') || (url && (label === url.href || label === fallback(url) || label === url.host || label === url.hostname.replace(/^www\./i, '')));
      const rank = generic ? 0 : name === 'a' ? 2 : 1;
      const labelHtml = escapeHtml(generic ? fallback(url, name === 'video' || attrs.get('data-embed-video') === '1') : label);
      // Local documents share a slide target but remain separate resources.
      const key = local ? `${href}\u0000local:${localIndex++}` : href;
      const previous = seen.get(key);
      if (previous) {
        if (rank > previous.rank) { previous.link.labelHtml = labelHtml; previous.rank = rank; }
        continue;
      }
      const link = { href, labelHtml };
      if (section) Object.assign(link, { section, sectionTitle: titles.get(section) || plain(slide.sectionTitle || section), sectionRun: run });
      seen.set(key, { link, rank });
      links.push(link);
    }
  }
  return links;
}
