import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { thumbnailSlides, type ThumbnailProjectionRow } from '../shared/slide-preview.ts';
/** Gallery only accepts the current artwork identity; never suffix/legacy lookup. */
export function galleryCoverFile(dir: string, row: ThumbnailProjectionRow | null): string | null {
  if (typeof row?.thumbnail_hash !== 'string') return null;
  const slide = thumbnailSlides([row], row.thumbnail_hash.slice(0, 16))[0];
  if (!slide || /[/\\\x00-\x1f]/.test(slide.cacheKey)) return null;
  const file = join(dir, slide.cacheKey + '.png');
  return existsSync(file) ? file : null;
}
