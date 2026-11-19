// A synthetic talk for the presenter stepping probes and test: reveal and focus lists, a focus loop,
// a stepping carousel and plain slides, so every kind of step and slide change happens in a few dozen
// presses (scripts/perf/presenter-pane-flicker.mjs, presenter-step-speed.mjs, presenter-pane-swap-dom.test.mjs).
export const flickerFixture = [
  '---', 'title: Pane flicker', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section {id=sec}', '',
  '### Reveal list', '{reveal}{id=rev1}', '', '- First point about the river', '- Second point about the bridges', '- Third point about the market', '- Fourth point about the walls', '',
  '### Focus list', '{focus}{id=foc1}', '', '- Choosing the route', '- Checking the paths', '- Inviting new walkers', '- Walking together', '',
  '### The walking year', '{cycle}{focus}{id=loop}', '', '- Plan the route', '- Check the paths', '- Invite walkers', '- Walk together', '- Write it up', '',
  '### Plain one', '{id=plain1}', '', 'A plain slide with a sentence of text on it.', '',
  '### Cards that step', '{carousel}{reveal}{id=cards}', '', '#### First card', '', '- One', '- Two', '', '#### Second card', '', '- Three', '- Four', '',
  '### Columns', '{.columns}{id=cols}', '', '- Left point with **bold**', '- Right point with *italic*', '',
  '### Quote', '{id=quote}', '', '> Simple things should be simple, complex things should be possible.', '',
  '### Reveal two', '{reveal}{id=rev2}', '', '- Alpha', '- Beta', '- Gamma', '- Delta', '- Epsilon', '',
  '### Focus two', '{focus}{id=foc2}', '', '- North', '- East', '- South', '- West', '',
  '### Plain two', '{id=plain2}', '', 'Another plain slide.', '',
  '### Reveal three', '{reveal}{id=rev3}', '', '- One', '- Two', '- Three', '',
  '### Focus three', '{focus}{id=foc3}', '', '- Red', '- Green', '- Blue', '',
  '### End', '{id=end}', '', 'Words only.', ''
].join('\n')
