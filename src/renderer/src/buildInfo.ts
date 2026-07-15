// Build stamp injected at build time by electron.vite.config.ts (`define`), surfaced in the
// bottom-left status bar so a test session can confirm which build is actually installed.
// SHA carries a trailing `+` when the build was made from a dirty working tree.
declare const __APP_VERSION__: string
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
export const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev'
export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
