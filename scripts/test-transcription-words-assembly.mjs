// How the bundled transcription script builds words from Parakeet's aligned tokens (video ticket
// 01; assemble_words in resources/agent-setup/transcription/parakeet_to_srt.py). Pure: synthetic
// token lists, no Parakeet, no model; the script imports parakeet_mlx only when it transcribes.
// Needs a python3; without one it is skipped with a message.
//   - a token with a leading space starts a word, the others continue it;
//   - opening punctuation (a quote, ¿, «, an opening bracket) goes in front of the FOLLOWING word,
//     and the word starts when that punctuation does;
//   - trailing punctuation goes on the word before it, even after a space;
//   - a sentence of punctuation only adds to the word before it, or nothing when there is none;
//   - an empty sentence, or one with no tokens, gives no words;
//   - times are seconds rounded to whole milliseconds.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../resources/agent-setup/transcription/parakeet_to_srt.py', import.meta.url))
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { timeout: 20_000 }).status === 0)
if (!python) {
  console.log('SKIP transcription word assembly: no python3 (3.8 or newer) on this computer')
  process.exit(0)
}

// Each case: sentences as lists of [text, start, end]; null stands for a sentence with no tokens list.
const CASES = {
  plain: [[[' Hel', 0.0, 0.1], ['lo', 0.1, 0.2], [' world', 0.3, 0.6]]],
  leadingQuote: [[[' "', 1.0, 1.04], ['Hel', 1.04, 1.2], ['lo', 1.2, 1.3], [',', 1.3, 1.32], [' world', 1.4, 1.7], ['"', 1.7, 1.72], ['.', 1.72, 1.74]]],
  inverted: [[[' ¿', 0.0, 0.05], ['Qué', 0.05, 0.3], ['?', 0.3, 0.32]], [[' «', 1.0, 1.02], ['Bon', 1.02, 1.2], ['jour', 1.2, 1.4], ['»', 1.4, 1.42]]],
  bracketMidSentence: [[[' see', 0.0, 0.2], [' (', 0.3, 0.32], ['this', 0.32, 0.5], [')', 0.5, 0.52]]],
  trailingCommaAfterSpace: [[[' word', 0.0, 0.4], [' ,', 0.4, 0.45], [' next', 0.5, 0.8]]],
  punctuationOnlySentence: [[[' Yes', 0.0, 0.3]], [[' .', 0.3, 0.35]]],
  punctuationOnlyFirst: [[[' "', 0.0, 0.1]], [[' …', 0.1, 0.2]]],
  openingWithNoWordAfter: [[[' end', 0.0, 0.3], [' "', 0.3, 0.35]]],
  emptySentences: [[], null, [[' ', 0.0, 0.1]], [[' only', 0.2, 0.4]]],
  rounding: [[[' a', 0.12349, 0.2], ['b', 0.2, 0.45678]]],
}

const program = `
import importlib.util, json, sys
from types import SimpleNamespace as NS
spec = importlib.util.spec_from_file_location("parakeet_to_srt", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert "parakeet_mlx" not in sys.modules, "parakeet_mlx was imported"
cases = json.loads(sys.stdin.read())
out = {}
for name, sentences in cases.items():
    built = [NS(tokens=None) if s is None else NS(tokens=[NS(text=t, start=a, end=b) for t, a, b in s]) for s in sentences]
    out[name] = mod.words_from_result(NS(sentences=built))
print(json.dumps(out))
`
const run = spawnSync(python, ['-I', '-c', program, script], { input: JSON.stringify(CASES), encoding: 'utf8', timeout: 60_000 })
assert.equal(run.status, 0, `the assembly program failed:\n${run.stderr}`)
const got = JSON.parse(run.stdout)
const texts = (name) => got[name].map((w) => w.text)
let passed = 0
const ok = (label) => { passed += 1; console.log(`  ok ${passed}. ${label}`) }

assert.deepEqual(got.plain, [{ text: 'Hello', start: 0, end: 0.2 }, { text: 'world', start: 0.3, end: 0.6 }])
ok('a leading space starts a word; other tokens continue it')

assert.deepEqual(texts('leadingQuote'), ['"Hello,', 'world".'])
assert.equal(got.leadingQuote[0].start, 1.0, 'the word starts with its opening quote')
assert.equal(got.leadingQuote[1].end, 1.74, 'the closing quote and full stop extend the last word')
ok('an opening quote goes on the following word; the closing quote and comma on the word before')

assert.deepEqual(texts('inverted'), ['¿Qué?', '«Bonjour»'])
assert.deepEqual(texts('bracketMidSentence'), ['see', '(this)'])
ok('¿, « and an opening bracket attach forward, their closers backward')

assert.deepEqual(texts('trailingCommaAfterSpace'), ['word,', 'next'])
ok('trailing punctuation after a space still goes on the word before')

assert.deepEqual(texts('punctuationOnlySentence'), ['Yes.'])
assert.ok(got.punctuationOnlySentence[0].start >= 0 && got.punctuationOnlySentence[0].end <= 0.3, 'punctuation from another sentence must not extend the word beyond its own segment')
assert.deepEqual(texts('punctuationOnlyFirst'), [])
assert.deepEqual(texts('openingWithNoWordAfter'), ['end"'])
assert.equal(got.openingWithNoWordAfter[0].end, 0.35, 'trailing pending punctuation in the same sentence retains its end')
ok('punctuation never stands alone: it joins the word before, or is dropped when there is none')

assert.deepEqual(texts('emptySentences'), ['only'])
ok('empty sentences (no tokens, or only blank ones) give no words')

assert.deepEqual(got.rounding, [{ text: 'ab', start: 0.123, end: 0.457 }])
ok('times are seconds rounded to whole milliseconds')

for (const [name, words] of Object.entries(got)) {
  for (const w of words) assert.ok(!/^[\p{P}\s]*$/u.test(w.text), `${name}: "${w.text}" is not punctuation alone`)
}
ok('no case produced a word of punctuation alone')
console.log(`transcription word assembly: ${passed} checks passed`)
