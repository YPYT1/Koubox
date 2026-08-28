#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-$SCRIPT_DIR/MODIFIED_FILE.ts}"
SOURCE_FILE="packages/core/src/video-download.ts"
SOURCE_BLOB="78baaaada208deecc0d4bd1e9e3b8939ecdd1b02"

if [[ -f "$REPO_ROOT/.git" ]]; then
  GIT_DIR_RAW="$(sed -n 's/^gitdir: //p' "$REPO_ROOT/.git")"
  GIT_DIR="$(wslpath -u "$GIT_DIR_RAW")"
else
  GIT_DIR="$REPO_ROOT/.git"
fi

git --git-dir="$GIT_DIR" --work-tree="$REPO_ROOT" show "$SOURCE_BLOB" > "$TARGET"
printf 'restored=%s\nsource=%s\nblob=%s\n' "$TARGET" "$SOURCE_FILE" "$SOURCE_BLOB"
