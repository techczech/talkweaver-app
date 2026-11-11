#!/usr/bin/env node
// Deterministic, offline 150-slide stress vault. Refuses to overwrite an existing destination.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
const dest = resolve(process.argv[2] || "");
if (!process.argv[2] || existsSync(dest))
  throw Error("Usage: node scripts/perf/make-large-talk-fixture.mjs NEW_VAULT_FOLDER");
const talk = join(dest, "synthetic-large-talk");
for (const sub of ["assets", "widgets"])
  mkdirSync(join(talk, sub), { recursive: true });
function crc(b) {
  let c = -1;
  for (const n of b) {
    c ^= n;
    for (let k = 0; k < 8; k++)
      c = c >>> 1 ^ (c & 1 ? 3988292384 : 0);
  }
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type), h = Buffer.alloc(4), tail = Buffer.alloc(4);
  h.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([h, t, data, tail]);
}
let seed = 20261106;
const images = [];
for (let i = 0; i < 4; i++) {
  const w = 1600, h = 1e3, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 1; x <= w * 3; x++) {
      seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
      raw[y * (w * 3 + 1) + x] = seed >>> 24;
    }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(join(talk, "assets", `noise-${i}.png`), png);
  images.push(png.length);
}
const html = '<!doctype html><meta charset="utf-8"><title>Synthetic widget</title><canvas width="800" height="450"></canvas><button>Step</button><script>let n=0;const c=document.querySelector("canvas").getContext("2d");function draw(){c.fillStyle="#162f46";c.fillRect(0,0,800,450);c.fillStyle="white";c.font="36px sans-serif";c.fillText("Synthetic interactive widget "+n,30,120)}document.querySelector("button").onclick=()=>{n++;draw()};draw()<\/script>';
for (let i = 0; i < 12; i++)
  writeFileSync(join(talk, "widgets", `widget-${i}.html`), html);
writeFileSync(join(talk, "assets", "page.html"), html);
writeFileSync(join(talk, "assets", "reference.md"), "### Referenced material\n\n- A reusable point\n- Another point\n");
const rows = ["---", "title: Synthetic large talk", "auto_title_slide: false", "auto_thanks_slide: false", "---", "", "# Synthetic large talk", ""];
const mix = { prose: 0, chat: 0, terminal: 0, widget: 0, html: 0, reference: 0, image: 0 };
for (let i = 0; i < 150; i++) {
  const kind = ["prose", "chat", "terminal", "widget", "html", "reference", "image"][i % 7];
  mix[kind]++;
  rows.push(`### Synthetic slide ${String(i + 1).padStart(3, "0")}`, `{id=perf-${i + 1}}`, "");
  if (kind === "prose")
    rows.push(...Array.from({ length: 8 }, (_, k) => `- Synthetic point ${k + 1}: compare the evidence, inspect the result and retain the source.`));
  if (kind === "chat")
    rows.push('{chat-lanes model="Synthetic model"}', "", "```chat", "user: Compare these measurements.", "model-reasoning (2s): Check the evidence before drawing a conclusion.", 'tool-call: measure {"sample":150}', "tool-results: Median 24 ms; tail 110 ms.", "bot: The tail needs investigation.", "```");
  if (kind === "terminal")
    rows.push("{terminal}", "", "```terminal", "$ measure --slides 150", "Preparing source\u2026", "150 slides ready", "```");
  if (kind === "widget")
    rows.push(`[Simulation: widgets/widget-${i % 12}.html]`);
  if (kind === "html")
    rows.push("[Embed: assets/page.html]");
  if (kind === "reference")
    rows.push("{from=synthetic-large-talk#perf-1}");
  if (kind === "image")
    rows.push(`![Synthetic noise](assets/noise-${i % 4}.png)`);
  rows.push("", ":::notes", "Synthetic speaker notes: check the result and retain uncertainty.", ":::", "");
}
writeFileSync(join(talk, "synthetic-large-talk-outline.md"), rows.join("\n"));
console.log(JSON.stringify({ slides: 150, mix, imageBytes: images }));
