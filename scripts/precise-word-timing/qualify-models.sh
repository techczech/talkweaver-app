#!/bin/sh
set -eu
node scripts/precise-word-timing/benchmark-language.mjs en
node scripts/precise-word-timing/benchmark-language.mjs cs
node scripts/precise-word-timing/score-models.mjs
node scripts/precise-word-timing/summarise-scores.mjs
node scripts/precise-word-timing/listening-samples.mjs
