export function pageTitleOf(model: Readonly<Record<string, unknown>> | null | undefined, slug: string): string {
  const frontmatterTitle = String((model?.meta as { title?: unknown } | undefined)?.title ?? '').trim()
  if (frontmatterTitle) return frontmatterTitle
  const modelTitle = String(model?.title ?? '').trim()
  return modelTitle && modelTitle !== slug ? modelTitle : slug
}
