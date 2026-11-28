export const WIDGET_MAX_BYTES: number
export const WIDGET_MAX_FILES: number
export const WIDGET_DEPENDENCY_TYPES: Map<string, string>
export function widgetDependencyRefs(text: string, extension: string): Array<{ raw: string; start: number; end: number }>
export function widgetDependencyPath(parent: string, raw: string): { path: string; mime: string } | null
