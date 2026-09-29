import type { Dirent } from 'node:fs'

export const TALK_SCAN_MAX_DEPTH: number
export function isSkippedScanDir(name: string): boolean
export function pickOutlineEntry(dirents: Dirent[]): Dirent | null
export function scanTalkFoldersSync(root: string): Array<{ dir: string; outlineName: string }>
