export const ROWS = `turn user "You": Compare the sample quotes.
turn thought "Thought for 3 s" open=off: Check the inputs first.
  detail:
    Use the same group size for each quote.
turn tool-call "Read the quote files" id=quotes: read_files sample-quotes/
  detail:
    {"limit":3}
turn tool-result "3 quotes found" ref=quotes: Cedar £840; Harbour £960; Grove £1,100.
turn status "Comparison ready" state=done: Cedar costs least for 40 people.
turn files "Found 3 files": sample-quotes/
  ├─ cedar.md
  ├─ harbour.md
  └─ grove.md
turn answer "Agent": The comparison is ready.`
