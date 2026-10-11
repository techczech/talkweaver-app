---
title: "One Rendering Model: How TalkWeaver Lays Out a Slide"
outline_version: 2
event: TalkWeaver design showcase
author: TalkWeaver
auto_thanks_slide: true
triggers: ""
---

# One Rendering Model: How TalkWeaver Lays Out a Slide

You write Markdown. The slide decides how to look. This talk shows every rule the new layout system follows, one slide per rule.

## What you write, what you get
{id=orm-sec-intro}

### A heading on its own is a statement
{id=orm-bare-heading}

:::notes
Demonstrates Ticket 14. This heading has no body and no child headings, so it renders as a statement of itself: white slide, the words at statement size, no sidebar rail, no duplicated title. Before, this became an empty list with the title one word per line.
:::

### A heading with a paragraph is a statement beside its title
{id=orm-statement}

The sidebar carries the title; the paragraph is the point. The measure stays short enough to read from the back of the room, and the block sits centred on both axes.

:::notes
The standard statement layout: tint sidebar title (A3 regime for text layouts), paragraph copy at body size.
:::

### A wholly bold paragraph is your claim
{id=orm-claim}

**The slide never shrinks your words below 31 pixels.**

Everything else on a slide can move, widen or step down, but no running text on a 1600-pixel stage renders under the floor. Bold inside a sentence is still a **highlight**; a paragraph that is entirely bold is a claim and renders larger, in ink, never in colour.

:::notes
Decision C1: whole-bold paragraph = claim (larger, ink). Inline bold = accent highlight. Also states the ADR-0005 type floor, which Ticket 17 now enforces for nested items, tables, code and attributions.
:::

## Quotes
{id=orm-sec-quotes}

### Dean W. Ball, Among the Agents
{id=orm-quote-short}

> By the end of this year, the least important thing you will be able to do with frontier AI systems will be getting chatbots to answer questions.

:::notes
Short quote. No dash line, so the slide title becomes the attribution and the on-slide title is hidden (Decision D1). Narrowest panel on the width ramp, base type size.
:::

### McCarthy et al, 1955
{id=orm-quote-medium}

> The study is to proceed on the basis of the conjecture that **every aspect of learning or any other feature of intelligence** can in principle be so precisely described that a **machine can be made to simulate it**.

:::notes
Medium quote with boxed emphasis. Same type size as the short one; the panel is wider because there are more words (Decision I: more words increase width, never decrease type).
:::

### McCarthy et al, 1955
{id=orm-quote-medium-2}

> An attempt will be made to find **how to make machines use language**, form abstractions and concepts, solve kinds of problems now reserved for humans, and improve themselves. We think that a significant advance can be made in one or more of these problems if a carefully selected group of scientists **work on it together for a summer**.

:::notes
The second McCarthy quote from your AI-history deck. In the old model the 220-character threshold flipped this one into a smaller type tier; now it is the same size as the previous slide with a wider panel.
:::

### Stephen King on tools
{id=orm-quote-long}

> I want to suggest that to write to your best abilities, it behooves you to construct your own toolbox and then build up enough muscle so you can carry it with you. Then, instead of looking at a hard job and getting discouraged, you will perhaps seize the correct tool and get immediately to work.

— Stephen King, On Writing

:::notes
Long quote with an explicit dash-line attribution inside the panel. The panel reaches its maximum width; type steps down only if the stage height is exhausted, and never below the floor. A quote that cannot fit at the floor raises a quote-too-long warning in the outline instead of shrinking.
:::

## Pictures and video
{id=orm-sec-media}

### A video and a screenshot share the stage
{id=orm-media-row}

![A short video clip](assets/sample-clip-a.mp4)

![A landscape picture](assets/placeholder-landscape.png)

:::notes
Ticket 15. A media-only slide groups any mix of video, images and embeds into one row, sized by each item's real aspect ratio, centred between the title rule and the bottom bar. The video's aspect is measured when its metadata loads, so there is no black letterbox band.
:::

### A tall screenshot is shown whole
{id=orm-media-portrait}

![A tall picture](assets/placeholder-portrait.png)

:::notes
Ticket 17: portrait media is contained, never cropped. Before, the top and bottom of a tall picture like this were cut off.
:::

### Bullets beside a picture
{id=orm-slot-right}
{image=right}

![A square picture](assets/placeholder-square.png)

- The picture takes a column, the words take the other
- Copy is vertically centred at one body size
- Author placement wins: this slide says image=right

:::notes
The generalised media slot (Ticket 3). The media-placement option is the author's to set; Auto puts the picture on the left.
:::

### Bullets beside a video and a picture
{id=orm-slot-stacked}

- Two pieces of media stack in the media column
- Both keep their aspect and neither is cropped
- The words stay one size regardless of how many pictures

![A second short video clip](assets/sample-clip-b.mp4)

![A picture of bars](assets/placeholder-bars.png)

:::notes
Decision B2: several media beside text always stack in the media column. Ticket 15 lets video join that stack.
:::

### Grep and Grok
{id=orm-image-claim}
{image-claim}

![A picture of notes](assets/placeholder-notes.png)

- Grep is retrieval — exact, literal, tireless
- Grok is understanding — fuzzy, contextual, judgemental

:::notes
Image-claim layout: a picture with a short claim list. The picture is contained and the claim text sits at claim size.
:::

## Lists
{id=orm-sec-lists}

### Where the sidebar title lives
{id=orm-list-plain}{font-title=xl} {font-body=xl}

- Lists keep the tint sidebar title (rule A3)
- Full-band structures such as tables, charts, timelines and cards take the top title with a hairline
- The title is never demoted to a small mono kicker
- The kicker is reserved for the section name

:::notes
The title regime is one rule resolved in one place (Ticket 2, stage module). Every layout declares its regime in the registry.
:::

### Strengths and dangers of grouped lists
{id=orm-list-grouped}{font-title=xl} {font-body=l}

- Strengths
  - Group headings and their bullets read as one block
  - Nested items are ink, at body size, never grey or tiny
- Dangers
  - A short list can leave most of its column empty
  - That is the open Decision L: keep the air, grow the type, or turn groups into columns

:::notes
Grouped list. Ticket 17 lifted nested items from 29–30px grey to body size in ink. What fills the rest of the column is the decision sheet you have in Dev Traffic Control.
:::

### Three types of tools
{id=orm-list-keyvalue}{font-body=xl} {font-title=xl}

- Computer commands
  - cd
  - ls
  - mkdir
- CLI tools
  - git
  - gh
  - wrangler
- API services
  - Lab notebooks
  - Canvas

:::notes
The key/value list from Intern to Toolmaker. Items were 19px; now they render at the floor.
:::

### Roles of AI in study
{id=orm-table}{table}{font-body=xl}

- Capabilities
  - answer questions, summarise, translate
  - write code, manage a code base
  - plan, work with files, run utilities
- Where
  - ChatGPT, Gemini, Claude
  - Cursor, Lovable, AI Studio
  - Codex, Claude Code, Antigravity

:::notes
Table: full-band structure, so the title sits on top with the hairline rule. Cells are at the type floor after Ticket 17.
:::

## Structures
{id=orm-sec-structures}

### Five years of AI in five lines
{id=orm-timeline} {timeline=pills}

- 2022: ChatGPT launches
- 2023: GPT-4 arrives
- 2024: Tool use expands
- 2025: Weekly use reaches a billion
- 2026: Agents take multi-step work

:::notes
Timeline: top title regime, labels at the floor.
:::

### Three roles of AI
{id=orm-cards}{cards} {iconlist}

- AI as Oracle
- AI as Intern
- AI as Toolmaker

:::notes
Cards: top title with rule; the card grid no longer repeats the title inside the grid.
:::

### What the tool does and what you do
{id=orm-compare}
{compare}

#### What TalkWeaver decides
{id=3ajhx}

Where the title goes, how wide a quote is, how pictures share a row, how big the type is.

#### What you decide
{id=o2fq1}

The words, the order, the pictures, and any override you write as a token.

:::notes
Compare layout: two columns from two level-four headings.
:::

### How a slide is composed
{id=orm-code}
{code}

```python
def compose(slide):
    layout = infer_layout(slide)          # from content shape
    layout = author_tokens_win(slide, layout)
    regime = title_regime_for(layout)     # one registry, one rule
    return stage(layout, regime, type_floor=31)
```

:::notes
Code is an element on a slide, at the floor, in a monospace face.
:::

## Author tokens win
{id=orm-sec-tokens}

### This heading has children but asks for a top title
{id=orm-token-wins}
{titletop}

- A heading with child headings used to become a divider no matter what you wrote
- Now any explicit token wins over the structural default
- A token the structure has to drop shows as a warning in the outline

#### A child heading under it
{id=orm-token-child}

The parent above kept its list and its top title. Nothing was silently overridden.

:::notes
Ticket 1: author wins. The parent has a body and a child; the titletop token is honoured and the slide stays a content slide.
:::

### Which layout would you write by hand?
{id=orm-poll} {poll=multiple}

- A quote
- A list beside a picture
- A statement
- I let the slide decide
- adding one more
- and one more

:::notes
Ticket 5: a poll slide compiles a presenter-visible frame (question, poll type, join placeholder, state chip) instead of an empty slide. The live poll replaces the frame in place.
:::

### Test open question poll
{id=be755} {poll=open}

### Links
{id=orm-links}
{links}

[TalkWeaver website](https://talkweaver.app)

[An example link](https://example.com)

:::notes
The links slide carries its own links; the deck's link index is appended only when an authored links slide has none of its own (Decision H).
:::
