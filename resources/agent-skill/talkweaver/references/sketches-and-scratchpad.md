# Sketches and the Slide Scratchpad

## Sketch files

A sketch is a plain UTF-8 Markdown file in `<talk folder>/scratchpad/`, for example `scratchpad/sketch-community-garden.md`. A talk can hold several. Never name a sketch `*-outline.md`. TalkWeaver reserves that filename suffix for talk outlines. Locate the exact sketch named in a Copy for agent request. Edit that file only. A sketch request never edits the talk file.

The author can use plain section lines, bullets and indented details, or paragraphs of prose. To propose specific cuts, put `## ` in front of a section line and `### ` in front of a line that begins a slide. Keep every line and word in its section unless the author asks for rewriting. For example:

```markdown
## Next season
### Repair the beds
- Ask for volunteers
  - Bring gloves and tools
### Share the tools
- Keep a sign-out sheet
```

In TalkWeaver, open the sketch and choose **Break into slides → As marked** to review those cuts. The author decides where any unplaced lines go and clicks **Add to the talk**. This adds the agreed slides with fresh IDs in one undoable edit. The sketch stays in the Scratchpad. Save the sketch once and tell the author what changed.

## Scratchpad items

Use the exact item and scope in the Copy for agent request. Keep the talk outline and app-owned `scratchpad-state.json` intact.

- **Sketch.** Edit the named Markdown file using the rules above.
- **Agent visual.** Edit the named SVG, HTML or image in `scratchpad/` only when asked. Keep its filename and format. Optional sidecar `<filename>.json` supplies `title`, `description` and `sources` (each with a `label` and `url`).
- **Proposed slide or picked slide.** The app holds a snapshot. Use the selected Markdown in the request to make a new, descriptively named sketch in `scratchpad/`, with `### ` marking the slide title. Keep the snapshot and its source talk intact.

The author uses the Scratchpad to compare items and decide what to insert. **Keep** and **Reject** mark an item. **Insert** copies it into the talk and leaves the original item in the Scratchpad.
