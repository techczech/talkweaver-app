# Edits code of earlier releases

The edits store and edits format of two published releases, exactly as tagged, so tests can run their real
reader and writer against files this build writes, and the other way round (two Macs on different versions):

- `v0.44.0/` — `git show v0.44.0:src/main/recording-edits-store.ts` and `…:src/shared/recording-edits.ts` (format 4)
- `v0.44.5/` — the same files at `v0.44.5` (format 5)

`scripts/test-recording-edits-compat.mjs` checks these copies against the tags when the tags are present, and
uses them as they are otherwise. Never edit them.
