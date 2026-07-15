import { strict as assert } from "node:assert";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY, resolveDynamicTrigger } from "../compiler/scripts/triggers.mjs";
import { parseHeadingAttrs } from "../compiler/scripts/lib/02-triggers-layout.mjs";
import { prepareSource } from "../compiler/scripts/lib/08-source-adapters.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const registryPath = join(root, "src/shared/layout-registry/entries.ts");
const generatedPath = join(root, "compiler/scripts/lib/trigger-dictionary.generated.mjs");
const samplerPath = join(root, "docs/layout-sampler-outline.md");
const samplePath = join(root, ".tmp-layout-registry-sample.md");

const DYNAMIC_TRIGGER_REPRESENTATIVES = ["countdown-digits-90s", "countdown-bar-3min"];
const VALID_KINDS = new Set(["layout", "component", "modifier", "container"]);
const VALID_STATUSES = new Set(["stable", "unverified", "experimental"]);

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  return undefined;
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function extractLayouts() {
  const sourceText = readFileSync(registryPath, "utf8");
  const source = ts.createSourceFile(registryPath, sourceText, ts.ScriptTarget.Latest, true);
  let layouts = null;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "LAYOUTS") continue;
      const init = decl.initializer;
      if (init && ts.isArrayLiteralExpression(init)) layouts = init;
    }
  });
  assert(layouts, "LAYOUTS array not found in renderer registry");
  return layouts.elements.map((entry) => {
    assert(ts.isObjectLiteralExpression(entry), "Every registry entry must be an object literal");
    const out = {};
    for (const prop of entry.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propName(prop.name);
      if (key) out[key] = literalValue(prop.initializer);
    }
    return out;
  });
}

function bareWordsFromTrigger(trigger) {
  return [...String(trigger ?? "").matchAll(/\{([^}=,\s:]+)\}/g)].map((m) => m[1]);
}

function compilerAcceptsTrigger(trigger) {
  const text = String(trigger ?? "").trim();
  if (!text.startsWith("{")) return true;
  const parsed = parseHeadingAttrs(`Probe ${text}`);
  return !parsed.warnings.some((warning) => warning.startsWith("unknown-trigger:"));
}

const entries = extractLayouts();
const sampler = readFileSync(samplerPath, "utf8");

assert(entries.length > 0, "Registry must contain entries");

for (const entry of entries) {
  assert(entry.name, "Every registry entry needs a name");
  assert(entry.trigger, `${entry.name}: missing trigger`);
  assert(VALID_KINDS.has(entry.kind), `${entry.name}: invalid or missing kind`);
  assert(Array.isArray(entry.aliases), `${entry.name}: aliases must be an array`);
  assert(VALID_STATUSES.has(entry.status), `${entry.name}: invalid or missing status`);
  assert(typeof entry.sample === "string" && entry.sample.trim(), `${entry.name}: missing sample`);
  assert(typeof entry.description === "string" && entry.description.trim(), `${entry.name}: missing description`);
  assert(Array.isArray(entry.triggerWords), `${entry.name}: triggerWords must be an array`);
  if (entry.kind === "container") assert.equal(entry.sectionOnly, true, `${entry.name}: containers must be section-only`);
}

const missingSamplerNames = entries.map((entry) => entry.name).filter((name) => !sampler.includes(name));
assert.deepEqual(missingSamplerNames, [], `Registry name(s) missing from docs/layout-sampler-outline.md: ${missingSamplerNames.join(", ")}`);

const registryWords = new Set(entries.flatMap((entry) => entry.triggerWords));

const compilerWords = Object.keys(TRIGGER_DICTIONARY).sort();
const missingFromRegistry = compilerWords.filter((word) => !registryWords.has(word));
assert.deepEqual(missingFromRegistry, [], `Compiler trigger(s) missing from registry: ${missingFromRegistry.join(", ")}`);
const missingFromCompiler = [...registryWords].filter((word) => !TRIGGER_DICTIONARY[word]).sort();
assert.deepEqual(missingFromCompiler, [], `Registry trigger(s) missing from compiler: ${missingFromCompiler.join(", ")}`);
assert.deepEqual(VALUE_TRIGGER_DICTIONARY.accent, ['cobalt', 'emerald', 'vermilion', 'forest'], 'named section accents are generated into the value-trigger dictionary');
assert.deepEqual(VALUE_TRIGGER_DICTIONARY.iconlist, ['boxes', 'list'], 'iconlist variants are generated into the value-trigger dictionary');
assert.deepEqual(VALUE_TRIGGER_DICTIONARY.statement, ['default', 'tint', 'poster'], 'statement variants are generated into the value-trigger dictionary');
assert.deepEqual(VALUE_TRIGGER_DICTIONARY.bg, ['cobalt', 'emerald', 'vermilion', 'forest'], 'named background tints are generated into the value-trigger dictionary');

const { generateTriggerDictionarySource } = await import("./generate-trigger-dictionary.mjs");
assert.equal(readFileSync(generatedPath, "utf8"), await generateTriggerDictionarySource(), "Generated trigger dictionary is stale");

const registryTriggerFailures = [];
for (const entry of entries) {
  if (entry.kind === "element") continue;
  if (!compilerAcceptsTrigger(entry.trigger)) registryTriggerFailures.push(`${entry.name}:${entry.trigger}`);
  for (const alias of entry.aliases) {
    if (!TRIGGER_DICTIONARY[alias] && !resolveDynamicTrigger(alias) && !compilerAcceptsTrigger(`{${alias}}`)) {
      registryTriggerFailures.push(`${entry.name} alias:${alias}`);
    }
  }
}
assert.deepEqual(registryTriggerFailures, [], `Registry trigger(s) not accepted by compiler: ${registryTriggerFailures.join(", ")}`);

for (const word of DYNAMIC_TRIGGER_REPRESENTATIVES) {
  assert(resolveDynamicTrigger(word), `Dynamic trigger representative does not resolve: ${word}`);
}

const sampleFailures = [];
for (const entry of entries) {
  const content = entry.sample;
  try {
    const model = await prepareSource(samplePath, content, `sample-${entry.name}`, statSync(registryPath));
    const warnings = model.warnings ?? [];
    const unknown = warnings.filter((warning) => String(warning).startsWith("unknown-trigger:"));
    if (unknown.length) sampleFailures.push(`${entry.name}: ${unknown.join(", ")}`);
  } catch (error) {
    sampleFailures.push(`${entry.name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}
assert.deepEqual(sampleFailures, [], `Registry sample syntax failure(s):\n${sampleFailures.join("\n")}`);

console.log(`layout-registry parity: ${entries.length} entries cover ${compilerWords.length} compiler triggers`);
