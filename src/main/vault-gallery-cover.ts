import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { thumbnailSlides, type ThumbnailProjectionRow } from '../shared/slide-preview.ts';

/** Use the compiled deck's marked cover, or the first usable slide in presentation order. */
export function galleryCoverIndex(rows: readonly (ThumbnailProjectionRow & { role?: string })[]): number {
  const isDivider = (row: typeof rows[number]) => [row.role, row.layout].some(
    value => value === 'section-title' || value === 'subsection-title')
  const title = rows.findIndex(row => row.layout === 'title' && !isDivider(row));
  if (title >= 0) return title;
  const opening = rows.findIndex(row => row.role === 'opening' && !isDivider(row));
  return opening >= 0 ? opening : rows.findIndex(row => !isDivider(row));
}

/** Gallery only accepts the current artwork identity; never suffix/legacy lookup. */
export function galleryCoverFile(dir: string, row: ThumbnailProjectionRow | null): string | null {
  if (typeof row?.thumbnail_hash !== 'string') return null;
  const slide = thumbnailSlides([row], row.thumbnail_hash.slice(0, 16))[0];
  if (!slide || /[/\\\x00-\x1f]/.test(slide.cacheKey)) return null;
  const file = join(dir, slide.cacheKey + '.png');
  return existsSync(file) ? file : null;
}
