// SD-17: test collectDeckLinks — replica convention. This file is SELF-CONTAINED: the function
// is duplicated inline here and must NOT import from the compiler source (the replica convention
// keeps the test runnable without a build step and makes the contract explicit). When the
// implementation in 08-source-adapters.mjs changes, update this replica to match.

// ── Replica of collectDeckLinks from compiler/scripts/lib/08-source-adapters.mjs ──────────────
function collectDeckLinks(slides) {
  const RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const seen = new Set();
  const result = [];
  for (const slide of slides) {
    const lines = Array.isArray(slide.sourceLines) ? slide.sourceLines : [];
    for (const line of lines) {
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(line)) !== null) {
        const text = m[1];
        const url = m[2];
        if (seen.has(url)) continue;
        seen.add(url);
        result.push({ text: text === url ? url : text, url });
      }
    }
  }
  return result;
}
// ────────────────────────────────────────────────────────────────────────────────────────────────

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

// 1. Empty slides array → []
ck(JSON.stringify(collectDeckLinks([])) === "[]", "empty slides → []");

// 2. Single slide with one link
const r2 = collectDeckLinks([{ sourceLines: ["[Click here](https://example.com)"] }]);
ck(r2.length === 1, "single link: length 1");
ck(r2[0].text === "Click here", "single link: text");
ck(r2[0].url === "https://example.com", "single link: url");

// 3. Two slides with the same URL → dedupe to one entry
const r3 = collectDeckLinks([
  { sourceLines: ["[First](https://dedupe.io)"] },
  { sourceLines: ["[Second](https://dedupe.io)"] },
]);
ck(r3.length === 1, "dedupe: only one entry");
ck(r3[0].text === "First", "dedupe: first-seen text wins");

// 4. Anchor text equals URL → URL is used as display text
const r4 = collectDeckLinks([{ sourceLines: ["[https://foo.com](https://foo.com)"] }]);
ck(r4.length === 1, "text=url: length 1");
ck(r4[0].text === "https://foo.com", "text=url: text is the URL");
ck(r4[0].url === "https://foo.com", "text=url: url");

// 5. http and https both collected; ftp:// NOT collected
const r5 = collectDeckLinks([{
  sourceLines: [
    "[HTTP link](http://http-example.com)",
    "[HTTPS link](https://https-example.com)",
    "[FTP link](ftp://ftp-example.com)",
  ]
}]);
ck(r5.length === 2, "http+https collected, ftp skipped: length 2");
ck(r5.some((l) => l.url === "http://http-example.com"), "http collected");
ck(r5.some((l) => l.url === "https://https-example.com"), "https collected");
ck(!r5.some((l) => l.url.startsWith("ftp://")), "ftp NOT collected");

// 6. Multiple links on one line, all collected
const r6 = collectDeckLinks([{
  sourceLines: ["[A](https://alpha.com) and [B](https://beta.com) and [C](https://gamma.com)"]
}]);
ck(r6.length === 3, "multiple links per line: length 3");
ck(r6[0].url === "https://alpha.com", "multi-link line: first url");
ck(r6[1].url === "https://beta.com", "multi-link line: second url");
ck(r6[2].url === "https://gamma.com", "multi-link line: third url");

// 7. Order: first-seen across slides is preserved
const r7 = collectDeckLinks([
  { sourceLines: ["[Z](https://z-first.com)"] },
  { sourceLines: ["[A](https://a-second.com)"] },
]);
ck(r7[0].url === "https://z-first.com", "order: first slide first");
ck(r7[1].url === "https://a-second.com", "order: second slide second");

// 8. Slide with no sourceLines key → treated as empty (no crash)
const r8 = collectDeckLinks([{ id: "no-source-lines" }]);
ck(r8.length === 0, "missing sourceLines: no crash, empty result");

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: collectDeckLinks (SD-17)");
