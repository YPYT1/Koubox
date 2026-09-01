$mainIndex = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\src\main\index.ts') -Raw
if ($mainIndex -notmatch 'usePortableUserData') {
  throw '预检失败：主进程缺少便携 userdata 逻辑。'
}
if ($mainIndex -notmatch 'pinBundledPaths:\s*app\.isPackaged') {
  throw '预检失败：主进程未在打包态锁定包内工具/模型路径。'
}

$desktopPkg = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\package.json') -Raw
Assert-PackPath (Join-Path $root 'scripts\prepare-playwright-browsers.mjs') 'Playwright 浏览器准备脚本'
if ($desktopPkg -match 'wheels') {
  throw '失败：extraResources 里出现了 wheels，whl 不应打进安装包。'
}
if ($desktopPkg -match '"from":\s*"\.\./\.\./models"') {
  throw '失败：extraResources 不应复制开发机 models；便携包只保留空 models 目录。'
}
if ($desktopPkg -notmatch '"from":\s*"../../python/\.venv"') {
  throw '预检失败：打包没有包含 python/.venv。'
}
if ($desktopPkg -notmatch '"target":\s*\[\s*"dir"\s*\]') {
  throw '预检失败：Win 产物应为 dir（解压即用），不是 nsis。'
}

Assert-PackPath (Join-Path $root 'vendor\yt-dlp\yt-dlp.exe') 'yt-dlp'
Assert-PackPath (Join-Path $root 'vendor\deno\deno.exe') 'Deno'
Assert-PackPath (Join-Path $root 'vendor\ffmpeg\bin\ffmpeg.exe') 'ffmpeg'
$vendorLinks = @()
foreach ($name in @('deno', 'ffmpeg', 'yt-dlp')) {
  $item = Get-Item -LiteralPath (Join-Path $root "vendor\$name") -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $vendorLinks += "$name -> $($item.Target)"
  }
}
if ($vendorLinks.Count -gt 0) {
  Write-Host ("开发机 vendor 含软链接/Junction（after-pack 会解引用成实体）：`n  " + ($vendorLinks -join "`n  "))
} else {
  Write-Host '开发机 vendor 已是实体目录。'
}
Assert-PackPath (Join-Path $root 'node_modules\.pnpm\playwright@1.62.1\node_modules\playwright\package.json') 'Playwright Node 依赖'

$repoDrive = (Split-Path -Qualifier $root).TrimEnd(':')
$freeGb = [math]::Round((Get-PSDrive -Name $repoDrive).Free / 1GB, 2)
if ($freeGb -lt 25) {
  throw "预检失败：${repoDrive}: 剩余 ${freeGb} GB，打包需要大约 25 GB 空闲。"
}
Write-Host "${repoDrive}: 剩余 ${freeGb} GB"

$electronDist = Join-Path $root 'node_modules\.pnpm\electron@33.4.11\node_modules\electron\dist\electron.exe'
Assert-PackPath $electronDist '本地 Electron（避免打包时再下载）'

$proxy = "http://127.0.0.1:$ProxyPort"
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
  Set-Item -Path "Env:$name" -Value $proxy
}
Write-Host "代理已固定为 $proxy"

node (Join-Path $root 'scripts\prepare-playwright-browsers.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "预检失败：Playwright 浏览器准备失败，退出码 $LASTEXITCODE"
}

$whl = Join-Path $root 'python\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl'
if (Test-Path -LiteralPath $whl) {
  Write-Host "开发机保留了 torch whl（不会打进包）：$whl"
}
