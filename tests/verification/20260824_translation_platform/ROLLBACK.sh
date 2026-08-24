#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"
ARTIFACT_DIR="$(cd "$(dirname "$0")" && pwd)"
restore() {
  local relative="$1"
  local safe="${relative//\//__}"
  mkdir -p "$ROOT_DIR/$(dirname "$relative")"
  cp "$ARTIFACT_DIR/baseline__${safe}" "$ROOT_DIR/$relative"
}
restore "python/src/koubox_runtime/translate.py"
restore "packages/core/src/tasks.ts"
restore "packages/shared/src/index.ts"
restore "apps/desktop/src/renderer/src/pages/RequirementOnePage.tsx"
restore "apps/desktop/src/renderer/src/pages/TaskHistoryPage.tsx"
restore "apps/desktop/src/renderer/src/styles/app.css"
echo "Rollback restored the six baseline files."
