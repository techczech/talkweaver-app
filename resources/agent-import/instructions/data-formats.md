# Import cleanup data formats

Write one suggestion per slide as `suggestions/slide-NNN.json`.

```json
{
  "slideNumber": 1,
  "category": "layout",
  "evidence": ["slides/001/original.png", "slides/001/decision.json"],
  "rationale": "The source contains one claim and no supporting body copy.",
  "markdown": "### Claim\n{id=pptx-example-001} {statement}",
  "sourcePreserving": true
}
```

`category` must be `structure`, `layout`, `accessibility` or `editorial`. `evidence` must name at least one file in the pack. `markdown` must contain the complete proposed slide block. Do not add fields that instruct TalkWeaver to read or write another path.
