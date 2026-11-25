export const presenterTemplateSource: string
export const presenterTemplateOutput: string
export class PresenterTemplateError extends Error {}
export function deckStylesheetPaths(stylesDir: string): string[]
export function readPresenterTemplate(compilerRoot?: string): string
