---
title: Save static offline web pages
---

## Save an offline HTML page

`webPage.saveOffline` is an in-process content verb (direct posture). Input: `outlinePath` of a talk in an open writable vault and `source` (public HTTP(S) URL or relative local HTML embed path). It returns an exclusive `assets/` HTML copy, title, image/data-file counts and omission count. The same sanitised snapshot and guarded importer serve the UI. It saves static rendered content and loaded JSON as inert text; it does not preserve interactive scripts or promise an arbitrary web application works offline. Callers apply the returned embed path through the outline's normal writer; keep the original URL as a link. The file operation never overwrites the outline or another asset.
