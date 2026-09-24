# Data Formats

## slideNotes.json

Per-slide summaries stored as a flat JSON object with string keys.

**Location:** `src/data/slideNotes.json`

**Schema:**
```json
{
  "1": "One to three sentence summary of what was said about slide 1.",
  "3": "Summary for slide 3. Not every slide needs an entry.",
  "5": "Maya explained how volunteers check dates before the calendar is published."
}
```

**Rules:**
- Keys are slide numbers as strings (not zero-indexed)
- Values are 1-3 sentence summaries in third person
- Use the speaker's name, not "the speaker"
- Not every slide needs an entry — skip slides with minimal transcript coverage
- Use past tense for what was said/shown
- Empty object `{}` is the default stub

**Usage:** The slideNotes data is available for display in individual slide views. The PPT2HandoutSkill template includes this file as a stub but does not currently render it in the UI — it's available for future enhancement or custom integration.

## lectureNotes.ts

Section-by-section narrative lecture notes as a TypeScript module.

**Location:** `src/data/lectureNotes.ts`

**Schema:**
```typescript
export interface LectureSection {
  sectionTitle: string;   // Section name from presentation.json
  slideRange: string;     // e.g., "1-22", "23-46"
  narrative: string;      // Markdown-like narrative text
}

export const lectureNotes: LectureSection[] = [
  {
    sectionTitle: "Introduction and Getting to Know Each Other",
    slideRange: "1-22",
    narrative: `**Key points:**

- First key point
- Second key point
- Third key point
- Fourth key point

### Subsection Heading

Prose paragraph with [slide 5](/slides/5) references and **bold terms**.

### Another Subsection

More prose...`
  },
  // ... more sections
];
```

**Rules:**
- Use template literals (backticks) for narrative strings to preserve newlines
- Escape backticks inside narratives with backslash: `` \` ``
- `sectionTitle` should match (or closely match) section titles from `presentation.json`
- `slideRange` format: `"startSlide-endSlide"` using 1-based slide numbers
- Empty array `[]` is the default stub (Notes link hidden in UI)

### Narrative Format

The narrative string supports a subset of Markdown:

| Syntax | Rendered as |
|--------|-------------|
| `**text**` | Bold (`<strong>`) |
| `*text*` | Italic (`<em>`) |
| `` `text` `` | Inline code (`<code>`) |
| `[text](url)` | External link |
| `[slide N](/slides/N)` | Internal slide link (SPA navigation) |
| `### Heading` | Section heading (`<h3>`) |
| `- item` | Bullet list item |
| Double newline | Paragraph break |

**Internal slide links** use the path `/slides/N` and are rendered as `<a>` tags with `data-slide-link="true"` and class `slide-link`. The LectureNotesPage component intercepts clicks on these to open a slide preview sidebar showing the screenshot. Each section also has a "Show Slides" toggle button that displays all section slides in the sidebar.

### Conditional Rendering

The PPT2HandoutSkill template conditionally shows the Notes nav link and keyboard shortcut based on `lectureNotes.length > 0`. When the array is empty (the default stub), no Notes link appears and the `n` keyboard shortcut is disabled. Populating the array is all that's needed — no manual uncommenting or configuration required.

Files that check `lectureNotes.length`:
- `SiteHeader.tsx` — nav link visibility
- `useGlobalKeyboard.ts` — `n` keyboard shortcut
- `KeyboardShortcutsModal.tsx` — shortcut help entry
