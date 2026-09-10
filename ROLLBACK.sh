#!/usr/bin/env bash
set -euo pipefail
source_file='/mnt/d/Project/Koubox/python/src/koubox_runtime/japanese_boundary_model.py'
modified_file='/mnt/d/Project/Koubox/MODIFIED_FILE'
backup_file='/mnt/d/Project/Koubox/MODIFIED_FILE.rollback-copy'
cp "$modified_file" "$backup_file"
cp "$source_file" "$modified_file"
if [[ "$(sha256sum "$modified_file" | cut -d' ' -f1)" != "$(sha256sum "$source_file" | cut -d' ' -f1)" ]]; then
  echo 'rollback verification failed' >&2
  exit 1
fi
cp "$backup_file" "$modified_file"
rm "$backup_file"
echo 'rollback verification passed; MODIFIED_FILE restored to modified-copy state'
