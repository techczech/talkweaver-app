// Place the caret in the fixture's intended CodeMirror line. macOS End can scroll
// or go to another line in the redesigned outline.
export async function typeAtOutlineLineEnd(page, lineText, text) {
  const line = page.locator('.cm-content .cm-line', { hasText: lineText }).first()
  await line.click()
  await line.evaluate(element => {
    const view = element.closest('.cm-content').cmTile.root.view
    const position = view.state.doc.lineAt(view.posAtDOM(element)).to
    view.dispatch({ selection: { anchor: position } })
    view.focus()
  })
  await page.keyboard.type(text)
}
