# Transcript Formats

The LectureNotesSkill supports four transcript input formats. Format is auto-detected by file extension and content structure.

## MacWhisper JSON

**Detection:** `.json` extension with `segments` array

**Structure:**
```json
{
  "text": "Full transcript text...",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 5.2,
      "text": " Welcome to today's workshop.",
      "tokens": [50364, 5765, ...],
      "temperature": 0.0,
      "avg_logprob": -0.23,
      "compression_ratio": 1.45,
      "no_speech_prob": 0.02
    }
  ],
  "language": "en"
}
```

**Extraction rules:**
- Use `segments[].text` for content (trim leading spaces)
- Use `segments[].start` and `segments[].end` for timing
- The top-level `text` field contains the full transcript but lacks timing
- Segments are ordered chronologically
- Join consecutive segments for slide mapping (don't treat each segment as a separate unit)

**Grouping strategy:**
- Group segments into ~30-second chunks for topic detection
- Look for natural pause points (segments with higher `no_speech_prob`)

## SRT (SubRip)

**Detection:** `.srt` extension

**Structure:**
```
1
00:00:00,000 --> 00:00:05,200
Welcome to today's workshop.

2
00:00:05,500 --> 00:00:10,100
We're going to look at AI coding.

```

**Extraction rules:**
- Parse entry number, timestamp line, and text lines
- Timestamps: `HH:MM:SS,mmm --> HH:MM:SS,mmm`
- Text may span multiple lines within an entry
- Entries separated by blank lines
- Strip HTML tags if present (`<i>`, `<b>`, etc.)

## VTT (WebVTT)

**Detection:** `.vtt` extension or starts with `WEBVTT`

**Structure:**
```
WEBVTT

00:00:00.000 --> 00:00:05.200
Welcome to today's workshop.

00:00:05.500 --> 00:00:10.100
We're going to look at AI coding.
```

**Extraction rules:**
- Skip the `WEBVTT` header and any metadata lines
- Timestamps use `.` instead of `,` for milliseconds
- Optional cue identifiers before timestamp lines
- May include positioning cues (`align:`, `position:`) — ignore these
- Strip HTML tags if present

## Plain Text

**Detection:** `.txt` extension or no recognized format markers

**Structure:**
```
Welcome to today's workshop. We're going to look at AI coding
and how it can help with mathematics education.

The first thing I want to show you is...
```

**Extraction rules:**
- No timing information available — rely entirely on content matching
- Split into paragraphs on double newlines
- Use paragraph order as a proxy for temporal order
- Topic matching is the primary mapping strategy
- May need more aggressive slide-title matching since timing can't help

## General Tips

- **Speaker diarization:** If the transcript includes speaker labels (e.g., `Speaker 1:`, `[John]:`), extract the primary speaker and filter out audience questions/comments
- **Filler words:** Ignore "um", "uh", "you know", "like" when matching to slide content
- **Timestamps as anchors:** When timestamps are available, use them to estimate which slides were active (presentations typically spend 1-3 minutes per slide)
- **Slide title mentions:** Speakers often say the slide title or a close variant when transitioning slides — use fuzzy matching
