import type { Dirent } from 'node:fs'

export const TALK_SCAN_MAX_DEPTH: number
export function isSkippedScanDir(name: string): boolean
export function pickOutlineName(names: string[], folderName?: string): string | null
export function pickOutlineEntry(dirents: Dirent[], folderName?: string): Dirent | null
export function scanTalkFoldersSync(root: string): Array<{ dir: string; outlineName: string }>
