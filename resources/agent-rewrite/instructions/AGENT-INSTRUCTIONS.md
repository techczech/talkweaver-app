---
name: LectureNotesSkill
description: >
  Generate narrative lecture notes from a transcript and a PPT2HandoutSkill presentation.
  Maps transcript segments to slides, generates per-slide summaries, and produces
  section-by-section narrative prose with slide references. Uses parallel agents for
  fast multi-section generation. Triggers on: "lecture notes", "generate notes from transcript",
  "add notes", "/LectureNotesSkill".
---

# Lecture Notes from Transcript

## TalkWeaver Run-pack boundary

When this guide is bundled by TalkWeaver, it lives under
`<talk>/agent-rewrite/<run-id>/instructions/`. All inputs and outputs belong to that one Run. Ignore
legacy files directly under `<talk>/agent-rewrite/`. TalkWeaver owns the Run pack's `cleaned.json`
and `notes.json`; never create, edit, replace, or delete those files. Notes drafts go only in
`parts/`, and Clean drafts go only in `cleaned/`.

Generate narrative lecture notes from a presentation transcript and integrate them into a PPT2HandoutSkill handout site.

## Usage

```
/LectureNotesSkill <path-to-transcript>
```

The transcript can be a MacWhisper JSON export, SRT, VTT, or plain text file. The skill reads `src/data/presentation.json` from the current working directory to map transcript content to slides.

## Prerequisites

- A working PPT2HandoutSkill handout site (with `src/data/presentation.json`)
- A transcript file from the presentation recording
- The handout site must have the lecture notes infrastructure (included in PPT2HandoutSkill template)

## Core Principles

1. **Third person, speaker by name** - Never use "I" or "we"; refer to the speaker by name
2. **Parallel section generation** - Use Task agents for each section simultaneously
3. **Slide references throughout** - Link to specific slides using `[slide N](/slides/N)` syntax
4. **Key points first** - Every section starts with a bullet summary before prose

---

## Workflow

### Step 1: Read Inputs

1. **Read the transcript file** — detect format automatically:
   - MacWhisper JSON (`.json`) — see [references/transcript-formats.md](references/transcript-formats.md)
   - SRT (`.srt`) — numbered entries with timestamps
   - VTT (`.vtt`) — WebVTT with timestamps
   - Plain text (`.txt`) — no timestamps, just text

2. **Read `src/data/presentation.json`** from the current working directory
   - Extract section structure, slide titles, slide content summaries
   - Build a slide title index for matching

3. **Extract speaker name** from `src/data/sessionInfo.ts` or ask the user

### Step 2: Map Transcript to Slides

Match transcript segments to slides using:
- **Title matching** — look for slide titles mentioned in the transcript
- **Topic transitions** — detect when the speaker moves to a new topic
- **Explicit references** — "on this slide", "as you can see", "next slide"
- **Temporal ordering** — assume slides proceed in order

Build a mapping: `{ slideNumber: transcriptSegment }`

**Report mapping quality** to the user:
- **Strong matches** — most slides have clear transcript segments
- **Partial matches** — some slides matched, others inferred
- **Minimal matches** — mostly inferred from ordering; ask user for help

### Step 3: Generate slideNotes.json

For each mapped slide, write a 1-3 sentence summary:
- Third person, speaker by name
- Capture the key point of what was said about that slide
- Save to `src/data/slideNotes.json`

Format:
```json
{
  "1": "Maya introduced the fictional community garden's planting calendar.",
  "5": "She explained how volunteers check dates before the calendar is published.",
  ...
}
```

Keys are slide numbers as strings. Not every slide needs an entry.

### Step 4: Define Section Boundaries

Use the presentation's section structure from `presentation.json`:
- Each section becomes a lecture notes section
- Assign transcript chunks to each section based on slide mappings
- Create a section list:

```typescript
interface SectionPlan {
  title: string;
  slideRange: string;       // e.g., "1-22"
  transcriptChunk: string;  // relevant transcript text
  slideTitles: string[];    // titles of slides in this section
}
```

### Step 5: Launch Parallel Section Agents

This is the key multi-agent step. Launch one `Task` agent per section using `haiku` model for speed.

**Launch all agents in a single message** for parallel execution:

```typescript
// For each section, launch a Task agent:
Task({
  subagent_type: 'general-purpose',
  model: 'haiku',
  prompt: `Generate a lecture narrative for the section "${section.title}" (slides ${section.slideRange}).

Speaker: ${speakerName}

Slides in this section:
${section.slideTitles.map((t, i) => `- Slide ${startSlide + i}: ${t}`).join('\n')}

Transcript for this section:
${section.transcriptChunk}

${NARRATIVE_STYLE_GUIDE}

Return ONLY the narrative text, starting with **Key points:** bullet list.`
})
```

See [references/narrative-format.md](references/narrative-format.md) for the full style guide to include in agent prompts.

### Step 6: Assemble lectureNotes.ts

Collect all section narratives from the parallel agents and write the TypeScript file:

```typescript
// src/data/lectureNotes.ts
export interface LectureSection {
  sectionTitle: string;
  slideRange: string;
  narrative: string;
}

export const lectureNotes: LectureSection[] = [
  {
    sectionTitle: "Introduction",
    slideRange: "1-22",
    narrative: `**Key points:**

- First key point
- Second key point

### Subsection heading

Prose paragraph with [slide 5](/slides/5) references...`
  },
  // ... more sections
];
```

Use template literals (backticks) for the narrative strings to preserve newlines.

See [references/data-formats.md](references/data-formats.md) for complete schema details.

### Step 7: Verify

```bash
npm run build
```

- The build should succeed with no TypeScript errors
- The Notes link should appear automatically in the nav bar (conditional rendering)
- The Notes link should appear **right after Slides** in the nav order (Home → Slides → Notes → ...). If the template places it elsewhere, move the `lectureNotes.length > 0` block in `src/components/layout/SiteHeader.tsx` to after the Slides link.
- Tell the user to check at `http://localhost:5173/#/lecture-notes`

**Tell the user:**
> The lecture notes have been generated. Please check:
> - Notes link appears in the navigation bar
> - All sections are present with correct slide ranges
> - Narrative reads naturally and captures the key points
> - Per-section "Show Slides" buttons open a slide preview sidebar
> - Clicking slide links in the narrative opens the sidebar (not navigating away)
> - Sidebar shows all section slides as stacked screenshot thumbnails
> - No major content is missing or misattributed

---

## References

- [Transcript Formats](references/transcript-formats.md) - Handling for MacWhisper JSON, SRT, VTT, plain text
- [Narrative Format](references/narrative-format.md) - Style guide for generated prose
- [Data Formats](references/data-formats.md) - Schema for slideNotes.json and lectureNotes.ts
