# 六个工具端到端冒烟：需 GPU、models/、vendor/、python/.venv
# 用法：pnpm smoke
# 可选：$env:KOUBOX_SMOKE_DOWNLOAD_URL = 'https://www.tiktok.com/@user/video/123'
# 默认使用 TikTok 链接 + 本地桩下载（不依赖外网）。

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
$env:KOUBOX_SMOKE = '1'
pnpm --filter @koubox/core exec vitest run test/smoke-six-tools.integration.test.ts
