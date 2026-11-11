# Research folder

- Every talk may have a `research/` folder beside its outline. File gathered material there, not in the outline, until a slide uses it.
- One unit = one Markdown file with frontmatter: `title`, `kind`, `prompt` (the question that produced it), `sources`, `created`, `project`, `by`. Artefacts (a table, an image, a widget) sit beside it.
- Kinds: `evidence`, `table`, `visualisation`, `snippet`, `search`, `widget`.
- `sources` entries: `url:<address>` or `file:<path>`. Cite where the material came from; never retype a quotation without its source.
- A folder named `research` (any case) is reserved: never a talk, category, outline or abstract. Creating, renaming, cloning or moving anything to that name is refused. Never treat its files as talks.
- The app's Research panel inserts items and makes slides from them. You do not need it to file material: write the files.

- App route: palette "Capture to research…", "Reveal research folder"; the in-process `research.capture` verb needs `scout` on the machine. Use it only when exposed; otherwise use `scout capture` as above in the skill.
