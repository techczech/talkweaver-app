import { dirname, resolve } from 'node:path';
import { extractImageRefs, extractFrontmatterImageRefs, resolveImagePaths } from './slide-image-refs.ts';
import type { GalleryFacts } from '../shared/vault-gallery';
export interface GalleryFactTarget {
  vaultId: string;
  relativeOutline: string;
  root: string;
  outlinePath: string;
  slug: string;
  epoch?: number;
  live?:()=>boolean;
  rootIdentity?: {dev:number;ino:number};
}
interface Source {
  text: string;
  revision: string;
  slideCount: number | null;
  coverUrl: string | null;
  editedMs?: number;
}
interface Dependencies {
  resolve(id: string, path: string): Promise<GalleryFactTarget | null>;
  current(target: GalleryFactTarget): boolean;
  read(target: GalleryFactTarget): Promise<Source>;
  render(target: GalleryFactTarget, source: Source): Promise<{
    slideCount: number | null;
    coverUrl: string | null;
  } | null>;
}
/** Demand only; no discovery. Every awaited boundary revalidates the configured root. */
export function createGalleryFacts(deps: Dependencies) {
  const cache = new Map<string, GalleryFacts>();
  return async (id: string, path: string, preview = true, live:()=>boolean = ()=>true): Promise<GalleryFacts | null> => {
    const target = await deps.resolve(id, path);
    if (!target || !live() || !deps.current(target))
      return null;
    target.live=live;
    const unknown: GalleryFacts = { revision: null, slideCount: null, imageCount: null, coverUrl: null, preview: 'unavailable', editedMs: null };
    try {
      const source = await deps.read(target);
      if (!live() || !deps.current(target))
        return null;
      const key = JSON.stringify([id, path, target.root, source.revision]);
      const held = cache.get(key);
      if (held)
        return held;
      const result: GalleryFacts = { revision: source.revision, slideCount: source.slideCount, imageCount: null, coverUrl: source.coverUrl, preview: source.coverUrl ? 'ready' : 'pending', editedMs: source.editedMs ?? null };
      try {
        result.imageCount = new Set([...extractImageRefs(source.text), ...extractFrontmatterImageRefs(source.text)].map(ref => {
          const resolved = resolveImagePaths([ref], dirname(target.outlinePath), target.root)[0];
          if (resolved)
            return resolved;
          if (ref.kind === 'video') return null;
          let raw = ref.ref;
          try {
            raw = decodeURIComponent(raw);
          }
          catch { }
          return /^(https?:|data:|blob:|img-|vid-)/i.test(raw) ? raw : resolve(dirname(target.outlinePath), raw);
        }).filter(value => value !== null)).size;
      }
      catch { /* unknown reference count */ }
      if (!preview) return result;
      if (!result.coverUrl || result.slideCount === null) {
        const rendered = await deps.render(target, source);
        if (!live() || !deps.current(target))
          return null;
        const latest = await deps.read(target);
        if (!live() || !deps.current(target) || latest.revision !== source.revision)
          return null;
        if (rendered) {
          result.slideCount = rendered.slideCount;
          result.coverUrl = rendered.coverUrl;
        }
      }
      result.preview = result.coverUrl ? 'ready' : 'unavailable';
      if (cache.size >= 256)
        cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    }
    catch {
      return live() && deps.current(target) ? unknown : null;
    }
  };
}
