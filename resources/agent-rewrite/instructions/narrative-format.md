# Narrative Format Style Guide

This document defines the style for generated lecture narratives. Include this guide (or a condensed version) in each section agent's prompt.

## Structure

Each section narrative follows this structure:

```
**Key points:**

- First key point (4-6 items total)
- Second key point
- Third key point
- Fourth key point

### Subsection Heading

Prose paragraph describing what the speaker covered. Reference specific slides
with [slide N](/slides/N) syntax. Bold **key terms** on first mention.

### Another Subsection

More prose paragraphs...
```

### Key Points Block

- Always start with `**Key points:**` followed by a blank line
- 4-6 bullet items, each one sentence
- Capture the most important takeaways from the section
- Use the speaker's name, not "the speaker"

### Subsection Headings

- Use `### Heading` (h3 level)
- Descriptive, specific headings (not generic like "Discussion" or "Details")
- 2-5 subsections per section depending on content density
- Each subsection should cover a coherent sub-topic

### Prose Paragraphs

- 2-4 paragraphs per subsection
- Each paragraph 3-5 sentences
- Focus on what was said and demonstrated, not audience reactions
- Include specific examples, tools, or concepts mentioned

## Voice and Tone

### Third Person, Speaker by Name

**Correct:**
> Maya demonstrated how a page builder can turn a recipe outline into a website.

**Incorrect:**
> I showed how a page builder can turn a recipe outline into a website.
> The speaker demonstrated how a page builder can turn a recipe outline into a website.

- Always use the speaker's actual name
- Use past tense for what was said/shown
- Use present tense for facts and concepts ("AI models are good at...")

### Academic but Accessible

- Clear, direct prose — not overly formal
- Explain technical terms briefly on first mention
- Assume the reader has the same background as the presentation audience

## Slide References

### Format

Use markdown link syntax with internal paths:
```
[slide N](/slides/N)
```

Examples:
- `([slide 5](/slides/5))` — parenthetical reference
- `as shown on [slide 12](/slides/12)` — inline reference
- `[slides 3-5](/slides/3)` — range reference (link to first slide)

### When to Reference

- **Every slide in the section's slide range must be referenced at least once** — no slides should be left unreferenced
- When mentioning a specific visual, demo, or example shown on a slide
- When a key concept is introduced on a particular slide
- 2-4 slide references per subsection is typical

## Formatting

### Bold

- Bold **key terms** on first meaningful use
- Bold **tool names** and **product names**: **Claude Code**, **ChatGPT**
- Don't bold common words or overuse bold

### Inline Code

- Use backticks for code elements: `npm run build`, `presentation.json`
- Use for file names, commands, code snippets
- Don't use for regular technical terms (use bold instead)

### Links

- Internal slide links: `[slide N](/slides/N)`
- External links only if a URL was explicitly mentioned in the presentation

### Added Content

- Mark anything not present in the transcript with `<!-- added -->…<!-- /added -->`, including short bridges or cross-section links added for readability

## What to Omit

- **Audience interaction** — "Any questions?", applause, laughter, side conversations
- **Filler words** — "um", "uh", "you know", "basically"
- **Repetition** — if the speaker repeated a point, state it once clearly
- **Housekeeping** — "Let me share my screen", "Can everyone see this?"
- **Self-corrections** — "Actually, I meant to say..."
- **Time references** — "Before the break", "We'll come back to this"

## Length Guidelines

- Each section narrative: 300-800 words depending on content density
- Key points: 4-6 bullets
- Total lecture notes for a 1-hour presentation: 2000-5000 words
- For a 2-hour workshop: 4000-8000 words

## Example

```markdown
**Key points:**

- A neighbourhood garden can publish its planting calendar without a specialist developer
- A clear description of each page helps the builder make useful first drafts
- Volunteers can review the calendar before publishing it
- Keep the source notes so the calendar can be updated next season

### Publishing the planting calendar

Maya coordinates a fictional neighbourhood garden. She explained that the group
needed a calendar volunteers could update without learning web development
([slide 5](/slides/5)). The first version listed planting dates; the volunteers
then checked each date against their own notes.

### What the group built

Maya showed the **planting calendar** assembled from a plain text schedule
([slide 13](/slides/13)); a **seed catalogue** transcribed from paper cards
([slide 14](/slides/14)); and a **volunteer checklist** that flags missing
watering assignments ([slide 15](/slides/15)).
```
