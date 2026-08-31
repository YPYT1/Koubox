Assert-PackPath $exe '口播匣.exe'
Assert-PackPath (Join-Path $resources 'vendor\yt-dlp\yt-dlp.exe') '包内 yt-dlp'
Assert-PackPath (Join-Path $resources 'vendor\deno\deno.exe') '包内 Deno'
Assert-PackPath (Join-Path $resources 'app.asar') '包内 Electron 应用'

$packedModels = Join-Path $resources 'models'
Assert-PackPath $packedModels '包内空 models 目录'
$packedModelEntries = @(Get-ChildItem -LiteralPath $packedModels -Force -ErrorAction SilentlyContinue)
if ($packedModelEntries.Count -ne 0) {
  throw ("校验失败：resources\models 必须为空，发现：`n" + ($packedModelEntries.FullName -join "`n"))
}
Write-Host 'resources\models 已验证为空；模型需由用户手动放入。'

$playwrightChrome = Get-ChildItem -LiteralPath (Join-Path $resources 'playwright-browsers') -Recurse -Filter 'chrome.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $playwrightChrome) {
  throw "校验失败：包内缺少 Playwright Chromium：$(Join-Path $resources 'playwright-browsers')"
}
Write-Host "Playwright Chromium：$($playwrightChrome.FullName)"

$cfgPath = Join-Path $resources 'python\pyvenv.cfg'
$pyHome = Join-Path $resources 'python-home'
$pyHomeExe = Join-Path $pyHome 'python.exe'
Assert-PackPath $cfgPath '包内 pyvenv.cfg'
Assert-PackPath $pyHomeExe '包内 CPython home\python.exe'

$homeItem = Get-Item -LiteralPath $pyHome -Force
if ($homeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "校验失败：resources\python-home 仍是软链接/Junction（目标：$($homeItem.Target)）。便携包必须是实体文件，请检查 after-pack 是否解引用复制。"
}

$homeFileCount = @(Get-ChildItem -LiteralPath $pyHome -Recurse -File -ErrorAction SilentlyContinue).Count
if ($homeFileCount -lt 100) {
  throw "校验失败：resources\python-home 文件过少（$homeFileCount），CPython 未完整打进包。"
}
Write-Host "python-home 文件数：$homeFileCount（实体目录，非软链接）"
$cfg = Get-Content -LiteralPath $cfgPath -Raw
$next = [regex]::Replace($cfg, '(?m)^home\s*=\s*.+$', "home = $pyHome")
if ($next -ne $cfg) {
  [System.IO.File]::WriteAllText($cfgPath, $next)
  Write-Host "已改写 pyvenv.cfg home -> $pyHome"
}

$forbidden = @(
  (Join-Path $resources 'python\wheels'),
  (Join-Path $distDir 'userdata\runtime.json'),
  (Join-Path $distDir 'userdata\ytdlp-cookies.txt'),
  (Join-Path $resources 'ytdlp-cookies.txt'),
  (Join-Path $resources 'runtime.json')
)
foreach ($path in $forbidden) {
  if (Test-Path -LiteralPath $path) {
    throw "校验失败：包内不应存在用户态/Cookie/whl：$path"
  }
}

$whlHits = @(Get-ChildItem -LiteralPath (Join-Path $resources 'python') -Filter '*.whl' -File -ErrorAction SilentlyContinue)
if ($whlHits.Count -gt 0) {
  throw ("校验失败：包内出现了 whl：`n" + ($whlHits.FullName -join "`n"))
}

$userdata = Join-Path $distDir 'userdata'
New-Item -ItemType Directory -Path $userdata -Force | Out-Null
Set-Content -LiteralPath (Join-Path $userdata 'README.txt') -Encoding UTF8 -Value @(
  '此目录存放便携版用户配置与登录 Cookie。'
  '首次启动后自动生成。分发压缩包前请保持为空（可保留本 README）。'
  '请勿把开发机的 AppData 或已登录的 userdata 打进发布包。'
)
