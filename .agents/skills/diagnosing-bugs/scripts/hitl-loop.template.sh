#!/bin/sh
# Human-in-the-loop feedback loop template.
#
# Last resort when Phase 1 genuinely cannot build an agent-runnable loop
# (a physical device, a UI interaction with no headless equivalent, a manual
# approval step). This script does not remove the human -- it structures
# around them: prompt exactly what to do, capture exactly what happened,
# write it somewhere the agent can read back. Copy this file, fill in the
# three marked sections, and treat its output file as the Phase 1 command.
set -eu

OUTPUT_FILE="${HITL_OUTPUT_FILE:-hitl-loop-result.txt}"

echo "=== HITL step ==="
# 1. Tell the human exactly what to do, in one or two concrete sentences.
#    Bad: "test the login flow". Good: "open /login, enter test@example.com
#    with password 'wrong', click Submit, and read the error banner text."
echo "TODO: describe the exact action here"
echo

# 2. Ask for exactly the observation that distinguishes red from green.
#    Bad: "did it work?". Good: "paste the exact error banner text, or type
#    NONE if no banner appeared."
printf "Observed result: "
read -r RESULT

# 3. Write it where the agent expects to read it back -- keep the format
#    stable across runs so the same parsing logic works every time.
{
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "result: $RESULT"
} > "$OUTPUT_FILE"

echo
echo "Written to $OUTPUT_FILE"
