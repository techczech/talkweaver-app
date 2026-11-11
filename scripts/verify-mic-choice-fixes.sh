#!/bin/sh
# Run under agent-run; keep each result even when another check fails.
failed=0
for check in recording-empty-segments microphone-choice run-audio recording-permissions recording-stream recording-paths present-audio-loss recording-recovery-real; do
  npm run "test:$check" > "docs/design/microphone-choice/built/review-fixes/$check.log" 2>&1
  result=$?
  echo "$check: $result"
  if [ "$result" != 0 ]; then failed=1; fi
done
npm run typecheck > docs/design/microphone-choice/built/review-fixes/typecheck.log 2>&1
result=$?
echo "typecheck: $result"
if [ "$result" != 0 ]; then failed=1; fi
npm run build > docs/design/microphone-choice/built/review-fixes/build.log 2>&1
result=$?
echo "build: $result"
if [ "$result" != 0 ]; then failed=1; fi
if [ "$result" = 0 ]; then
  npm run test:microphone-choice:built > docs/design/microphone-choice/built/review-fixes/built-journey.log 2>&1
  result=$?
  echo "built journey: $result"
  if [ "$result" != 0 ]; then failed=1; fi
fi
exit "$failed"
