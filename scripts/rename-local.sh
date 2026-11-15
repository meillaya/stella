#!/usr/bin/env sh
# Rename the local checkout from flow-qs to stella after the session ends.
# Run this from outside the repository, then reopen DeepSeek Harness at the new path.
set -eu
OLD="${OLD_DIR:-$HOME/Documents/flow-qs}"
NEW="${NEW_DIR:-$HOME/Documents/stella}"
if [ ! -d "$OLD" ]; then
  echo "not found: $OLD" >&2
  exit 1
fi
if [ -e "$NEW" ]; then
  echo "refusing to overwrite existing: $NEW" >&2
  exit 1
fi
if [ -n "${STELLA_SESSION_ACTIVE:-}" ]; then
  echo "close the active Harness session first" >&2
  exit 1
fi
mv "$OLD" "$NEW"
echo "moved $OLD -> $NEW"
echo "Reopen DeepSeek Harness at $NEW; the git remote is already renamed."
