// What the Slide Scratchpad says when nothing has been collected yet (wording from the locked mockup).
export function ScratchpadEmpty({ onShowFolder, onOpenSlideBrowser }: { onShowFolder: () => void; onOpenSlideBrowser: () => void }): JSX.Element {
  return (
    <div className="sp-empty">
      <div className="sp-empty-icon" aria-hidden="true" />
      <h3>Nothing in the Slide Scratchpad yet</h3>
      <p>This is where candidates for this talk collect, so you can look at them next to your slides and decide.</p>
      <div className="sp-empty-box">
        <b>Visuals made by an agent</b>
        Ask an agent to make pictures, SVG diagrams or HTML widgets in this talk&rsquo;s scratch folder. Every file it puts there appears here on its own. Agents only make files in that folder; they never change your slides.
        <div><button type="button" className="sp-btn sp-btn--sm" onClick={onShowFolder}>Show the scratch folder</button></div>
      </div>
      <div className="sp-empty-box">
        <b>Slides from your other talks</b>
        Open the Slide Browser, select the slides you like and choose Add to Slide Scratchpad.
        <div><button type="button" className="sp-btn sp-btn--sm" onClick={onOpenSlideBrowser}>Open the Slide Browser</button></div>
      </div>
    </div>
  )
}
