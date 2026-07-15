// The pure selection + section-grouping helpers moved VERBATIM to slideBrowserModel.ts
// (the Slide Browser's node-tested model). This re-export keeps SearchPalette compiling
// until Task 12 deletes it — new code should import from './slideBrowserModel' directly.
export { selRowKey, rangeKeys, sectionKeysAt, isSingleTalk, groupBySection } from './slideBrowserModel'
export type { SelRow } from './slideBrowserModel'
