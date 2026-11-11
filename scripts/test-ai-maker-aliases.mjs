// AI maker and product names resolve to their own marks (extra.json), and the single
// ordinary words inside those names never summon a logo on their own.
import { svglBrandMatch, classifyBrandSvg, iconSvg } from "../compiler/scripts/lib/05-icons.mjs";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

const want = {
  "Amazon": "amazon-web-services", "Amazon Nova": "amazon-nova", "Amazon Q": "amazon-q",
  "Amazon Web Services": "amazon-web-services",
  "Xiaomi MiMo": "xiaomi-mimo", "MiMo": "xiaomi-mimo", "Nano Banana": "nano-banana",
  "Black Forest Labs": "black-forest-labs", "Falcon": "tii", "Falcon 3": "tii", "Falcon H1": "tii", "TII Falcon": "tii", "TII (Falcon)": "tii", "TII": "tii",
  "Reflection AI": "reflection-ai", "Ant Group": "ant-group", "Allen Institute for AI": "ai2",
  "Ai2": "ai2", "Zhipu AI": "zhipu-ai", "Luma AI": "luma-ai", "Sakana AI": "sakana-ai",
  "AI21 Labs": "ai21-labs", "Aleph Alpha": "aleph-alpha", "OpenAI Whisper": "openai", "Whisper large-v3": "openai", "Whisper": "openai",
  "NVIDIA Parakeet": "nvidia", "Parakeet TDT": "nvidia", "Parakeet": "nvidia", "Veo": "google", "Veo 3": "google",
  "ByteDance Seed": "bytedance", "Seedance": "bytedance", "HyperCLOVA X": "naver", "METR": "metr",
  "Epoch AI": "epoch-ai", "Arena AI": "arena-ai", "arena.ai": "arena-ai", "LMArena": "arena-ai", "LM Arena": "arena-ai", "Chatbot Arena": "arena-ai", "Artificial Analysis": "artificial-analysis", "Thinking Machines": "thinking-machines", "Thinking Machines Lab": "thinking-machines", "Thinking Machines Inkling": "thinking-machines", "Inkling": "thinking-machines", "Inkling 2": "thinking-machines", "Synthesia": "synthesia", "Sarvam AI": "sarvam-ai",
  "Copilot": "microsoft-copilot", "Microsoft Copilot": "microsoft-copilot", "GitHub Copilot": "github-copilot",
};
for (const [text, key] of Object.entries(want)) {
  ck(svglBrandMatch(text, { brandContext: true }) === key,
    `"${text}" resolves to ${key} (got ${svglBrandMatch(text, { brandContext: true })})`);
}

// Single ordinary words must not gain these marks, in prose or in a brand context.
const mine = new Set(["amazon-nova", "xiaomi-mimo", "nano-banana", "black-forest-labs", "tii", "reflection-ai",
  "ant-group", "ai2", "zhipu-ai", "luma-ai", "sakana-ai", "ai21-labs", "aleph-alpha", "arena-ai", "artificial-analysis", "thinking-machines"]);
for (const w of ["reflection", "group", "labs", "black", "nano", "banana", "forest", "alpha", "allen", "institute", "arena", "analysis", "artificial", "thinking", "machines"]) {
  for (const opts of [{}, { brandContext: true }]) {
    const r = svglBrandMatch(w, opts);
    ck(!mine.has(r), `"${w}" alone (${opts.brandContext ? "brand" : "prose"}) must not resolve to ${r}`);
  }
}
// Not TII, and a bare Amazon in prose never becomes the Nova model mark.
for (const prose of ["a falcon flew", "CrowdStrike Falcon", "SpaceX Falcon 9", "the peregrine falcon"]) {
  for (const opts of [{}, { brandContext: true }]) {
    ck(svglBrandMatch(prose, opts) !== "tii", `"${prose}" must not resolve to tii`);
  }
}
for (const prose of ["bought it on Amazon", "the Amazon rainforest"]) {
  for (const opts of [{}, { brandContext: true }]) {
    const r = svglBrandMatch(prose, opts);
    ck(r !== "amazon-nova", `"${prose}" must not resolve to amazon-nova (got ${r})`);
  }
}
// Ordinary English words must not gain a product logo.
for (const prose of ["a whisper", "the parakeet", "plant a seed", "a whisper of doubt in the room", "Whisper quietly to the group", "I saw a Parakeet in the garden", "seed funding", "I had an inkling", "not an Inkling of doubt"]) {
  for (const opts of [{}, { brandContext: true }]) {
    const r = svglBrandMatch(prose, opts);
    ck(r === null, `ordinary prose "${prose}" (${opts.brandContext ? "brand" : "prose"}) gains no logo (got ${r})`);
  }
}
for (const prose of ["a reflection on teaching practice", "the group met on Tuesday", "the labs were closed"]) {
  ck(!mine.has(svglBrandMatch(prose)), `prose stays clean: ${prose}`);
}

// Embedded raster marks (site icons) are drawable, colour-only; empty or external images are not.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
ck(classifyBrandSvg(`<svg viewBox="0 0 1 1"><image href="data:image/png;base64,${png}" width="1" height="1"/></svg>`) === "colored", "SVG wrapping a data: PNG is drawable");
ck(classifyBrandSvg(`<svg viewBox="0 0 1 1"><image href="data:image/webp;base64,${png}" width="1" height="1"/></svg>`) === "colored", "data: WebP is drawable");
ck(classifyBrandSvg(`<svg viewBox="0 0 1 1"><image width="1" height="1"/></svg>`) === "empty", "<image> without href is empty");
ck(classifyBrandSvg(`<svg viewBox="0 0 1 1"><image href="https://example.com/x.png" width="1" height="1"/></svg>`) === "empty", "<image> with external href is empty");
ck(classifyBrandSvg(`<svg viewBox="0 0 1 1"><image href="data:image/svg+xml;base64,${png}"/></svg>`) === "empty", "data: SVG image is not accepted");
for (const k of ["metr", "synthesia", "thinking-machines"]) {
  const out = iconSvg("svgl:" + k);
  ck(/<image\b/.test(out), `${k} renders its embedded image`);
  ck(/<image\b/.test(iconSvg("svgl:" + k, { monochrome: true })), `${k} is left as is in monochrome mode`);
}

if (fail) process.exit(1);
console.log("PASS: AI maker and product aliases");
