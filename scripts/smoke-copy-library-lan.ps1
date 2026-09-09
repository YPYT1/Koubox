$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
  pnpm --filter @koubox/core exec vitest run test/copy-library-store.test.ts test/lan-share-protocol.test.ts
  pnpm typecheck
  pnpm build
  Write-Output 'SMOKE_COPY_LIBRARY_LAN_OK'
} finally {
  Pop-Location
}
