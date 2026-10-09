export interface SlideImagePlacement { kind: string; index: number; count: number }
export function imagePlacementsForSlide(slide: unknown): SlideImagePlacement[]
export function audienceImageLineNumbers(lines: readonly string[]): number[]
