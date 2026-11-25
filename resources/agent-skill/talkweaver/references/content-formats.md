# TalkWeaver source formats

## Outline

Retain the existing frontmatter and conventions. A small source example:

```markdown
---
title: A clearer explanation
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

## The question
{id=question}

What needs explaining?

### One example
{id=example}

- The first observation.
- The second observation.

:::notes
Speaker-only explanation belongs here.
:::
```

The hierarchy is part of the presentation. `#` names the Talk; `##` establishes a section; a bodyless `###` with `####` children establishes a subsection; its `####` children are ordinary content slides. A direct `###` content slide under a `##` section is also valid. Do not flatten a section-and-subsection plan into a sequence of `###` slides. Verify the resulting section and subsection memberships with the current compiler parser or app outliner.

```markdown
# Talk title

## Section heading

### Subsection heading

#### Content slide within the subsection

- The explanation belongs here.

### Direct content slide within the section

- This slide has a section but no subsection.
```

Heading depth supplies the hierarchy. `####` is not inherently a card: container layouts such as carousel, cards, image-grid or contrast can absorb child headings as cards; an ordinary subsection must retain its children as separate slides. Keep subsection dividers bodyless and put the explanation on their child slides. Preserve the author's deliberate existing containers and heading levels when reusing a source Talk.

For example, **New subsection** under **Next season** creates the divider shown to the audience. Its first slide is one level deeper. Existing IDs stay with their own headings.

```markdown
## Next season {id=season7}

### Getting involved {id=join5}
{sub}{role=subsection-title}

#### Volunteer for the watering rota {id=water9}

- Choose one week in the rota.
```

In the compiler, structural `##` through `######` headings each begin a slide block; `#` is a title boundary. Headings inside code fences or HTML comments are not slide boundaries. Do not split source with an unrestricted heading regex. A slide block includes its trigger line, notes and body until the next structural heading.

Preserve `{id=...}` identifiers and their references. On application save, TalkWeaver can stamp missing IDs, record ledger history and return stamped content. File edits alone do not perform that lifecycle. Keep existing IDs across title changes and moves; new/copied slides need distinct identities under the app's rules, not duplicates of the original IDs.

Use the existing trigger line immediately below its heading. Preserve existing layout options and registered fenced object syntax. Consult the app's installed reference or the user's working examples before adding unfamiliar charts, diagrams, tables or layout triggers. Do not convert an entire talk to an older presentation-skill dialect.

## Pathway

The app stores Pathways in `<vault>/_PRESENTATIONS/<talk-slug>/manifest.json`, under a `pathways` array. Verify this against the actual vault/version before a write. Merge into the existing manifest; preserve all other fields.

```json
{
  "pathways": [
    {
      "id": "short-introduction",
      "name": "Short introduction",
      "note": "An introductory cut of the existing talk.",
      "slideIds": ["question", "example"]
    }
  ]
}
```

This is a minimal schema example, not a replacement for an existing manifest. Pathway IDs must be unique within the Talk; names and IDs must be non-empty. `slideIds` is ordered and must contain no duplicates or empty IDs. Verify every referenced slide against current compiled identity or established source IDs. Report missing slides; do not silently drop them or substitute headings.

Choosing a Pathway selects content; it does not rewrite the audience wording in the original. If both a shorter cut and changed wording are requested, explain their distinct effects and preserve the requested original.

## Runs, assets and outputs

A Run is a delivery record, not another source outline. Preserve existing Run records, dates, links and Pathway relationships; do not invent a historical delivery or edit run-state files from a guessed schema. Read the actual app contract when writing Run metadata.

Keep relative assets relocatable and preserve speaker notes in the source. Treat audience slides, speaker notes, handouts and recordings as different publication surfaces. Inspect the real exported artefact before sharing; do not assume notes are absent because the audience view hides them.
## A request copied from the Slide tab

Change only the named aspect, keep the id line, and leave the wording, media, notes and
other slides unchanged. Identify the slide by its id. Save the Markdown file once so
the open app can review the disk change.

### Place and style the title

- `{id=p4k2m}{titletop}` puts it on top.
- `{id=p4k2m}{sidebar}{split=35}` uses a coloured left panel at 35%. Other widths are
  `{split=30}`, `{split=40}` and `{split=50}`.
- `{id=p4k2m}{notitle}` hides the painted title while keeping its navigation text.
  Remove conflicting placement and `{title=show}`. On a title-quiet layout, for example
  `{id=p4k2m}{quote}{title=show}`, the latter restores a heading.
- Statements can use `{title=show}{sidebar}{statement-sidebar=on}` for a title panel,
  or `{title=show}{titletop}{statement-sidebar=off}` for a title above the statement.

| Top title style | Example |
| --- | --- |
| Plain | `{id=p4k2m}{titlelook=default}` |
| Tab | `{id=p4k2m}{titlelook=tab}{titlelook-tone=strong}` |
| Soft tab | `{id=p4k2m}{titlelook=tab}{titlelook-tone=soft}` |
| Kicker | `{id=p4k2m}{titlelook=kicker}` |
| Label | `{id=p4k2m}{titlelook=label}` |
| Section strip | `{id=p4k2m}{titlelook=tab-strip}` |
| Intro only | `{id=p4k2m}{titlelook=intro-then-none}` |

Intro only uses the section slide's title and hides titles on the slides that follow.
To follow the talk again, remove the slide's title overrides. A plain override pins
a plain title even when the talk changes.

`{font-title=l}` makes the title larger. Other sizes include `{font-title=xs}`,
`{font-title=s}` and `{font-title=xl}`. Medium leaves the size off. For an icon above
the title and a different icon at the start of a point's text treatment, write:

```markdown
### Three priorities {icon=lucide:list}
{id=p4k2m}{title-icon=above}{iconlist}

- Repair the beds {icon=lucide:hammer}
- Share the tools
```

Remove `{title-icon=above}` to place the heading icon before the title. Remove a
point's explicit icon to let it be chosen automatically. `{icons=top}` marks top-level
points, `{icons=all}` includes sub-points, and `{icons=off}` disables the frame's marks.

### Change one section

```markdown
## What we made
{id=make1}{section-colour=amber}{contents}
```

This section has an amber slide and shows a contents rail. Use `{grid-zoom}` to zoom into
tiles, `{grid-linear}` to step through the tiles in order, or `{carousel}` when the children
have pictures. For One after another, remove the container-mode code. Removing the colour
override restores rotation. Other colours include `{section-colour=blue}`,
`{section-colour=deep-blue}`, `{section-colour=light}` and `{section-colour=light-amber}`.

### Video markers

Write one `[Marker: 1:23 The demo]` line per marker under a video file line,
whether `![alt](media/demo.mp4)` or `[Video: media/demo.mp4]`. Marker
spelling is case-insensitive. Blanks, standalone HTML comments and other
marker lines may sit between the video and its markers. Use whole seconds as `m:ss` or
`h:mm:ss`, with two-digit seconds and a maximum of 24 hours. The name is
plain text and may be omitted. An unnamed marker displays its time.

When adding a line, insert it in time order without reordering other lines.
Equal times retain their source order. Keep markers with their video when
moving or copying a slide. Keep markers beyond the duration, and keep orphan
and YouTube or Vimeo markers as authored. They do not control playback.
Marker lines do not appear as slide text, in handouts or on shared pages.

The in-process source edits are `videoMarker.add`, `videoMarker.change`
and `videoMarker.remove`. They take the current outline and zero-based
source line numbers, and return an outline edit. Apply it only against
that same outline. In the app, use the Video page on the Slide tab or
**Video: Add marker at current time**.
