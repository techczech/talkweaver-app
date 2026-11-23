// The one HTML escape, for TypeScript callers (main process, src/shared/, worker). The
// implementation lives in compiler/scripts/lib/00-html.mjs so the compiler, which ships as
// plain .mjs, uses the same function. Both escape & < > " ' ; see that file.
export { escapeAttr, escapeHtml } from '../../compiler/scripts/lib/00-html.mjs'
