#!/bin/sh
# Higher-precision control, public downloads/local files only. Run via agent-run.
set -eu
python3 scripts/precise-word-timing/fetch-english.py --fp32
node scripts/precise-word-timing/benchmark-language.mjs en 2 fp32
node scripts/precise-word-timing/benchmark-language.mjs cs 4 fp32
node scripts/precise-word-timing/score-models.mjs fp32-
node scripts/precise-word-timing/summarise-scores.mjs fp32-
