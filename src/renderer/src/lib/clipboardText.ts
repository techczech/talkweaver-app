export function clipboardHasText(clipboard: DataTransfer): boolean {
  return clipboard.types.includes('text/plain') || clipboard.types.includes('text/html')
}

/** HTML from an image-and-text copy can be the only text flavour. Read it without attaching it to the page. */
export function htmlClipboardText(clipboard: DataTransfer): string {
  const fragment = document.createElement('template')
  fragment.innerHTML = clipboard.getData('text/html')
  fragment.content.querySelectorAll('script, style, head, title, noscript').forEach(element => element.remove())
  return fragment.content.textContent ?? ''
}
