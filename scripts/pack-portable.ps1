# 口播匣便携包打包脚本
# 用法：
#   pnpm pack:portable
#   pnpm pack:portable -- -Version 0.2.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-portable.ps1 -Version 0.2.0
#   ... -CleanOnly              只删除旧 release 产物（含 Koubox-*）
#   ... -SkipPackage            只预检，不真正打包（给你手动打包前验证）
#   ... -PostflightOnly         只复验已经生成的 Koubox-x.y.z 目录
#   ... -Version 0.2.0          指定发布版本（写入 apps/desktop/package.json，目录名 Koubox-0.2.0）
#   ... -ProxyPort 7897         代理端口，默认 7897
#
# 说明：
# - 不打包 python/wheels（2.6GB 的 torch.whl）
# - 不打包 AppData 登录态 / Cookie；便携版用 exe 旁 userdata（空目录）
# - 打包版强制使用 resources 内的 vendor / python
# - resources/models 只创建空目录，模型由用户手动放入

param(
  [string]$Version = '',
  [int]$ProxyPort = 7897,
  [switch]$CleanOnly,
  [switch]$SkipPackage,
  [switch]$PostflightOnly
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$desktopPkgPath = Join-Path $root 'apps\desktop\package.json'
$rootPkgPath = Join-Path $root 'package.json'

function Assert-Semver([string] $Value) {
  if ($Value -notmatch '^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$') {
    throw "版本号格式无效：$Value（示例：0.2.0、1.0.0-beta.1）"
  }
}

function Set-JsonVersion([string] $FilePath, [string] $NewVersion) {
  $text = Get-Content -LiteralPath $FilePath -Raw
  if ($text -notmatch '"version"\s*:') {
    throw "无法在 $FilePath 找到 version 字段"
  }
  $next = [regex]::Replace($text, '("version"\s*:\s*")[^"]+(")', "`${1}$NewVersion`${2}", 1)
  if ($next -eq $text) {
    throw "未能更新 $FilePath 的版本号"
  }
  [System.IO.File]::WriteAllText($FilePath, $next)
}

$desktopPkgJson = Get-Content -LiteralPath $desktopPkgPath -Raw | ConvertFrom-Json
if ($Version.Trim()) {
  $Version = $Version.Trim()
  Assert-Semver $Version
  if ([string]$desktopPkgJson.version -ne $Version) {
    Write-Host "写入版本 $Version -> apps/desktop/package.json"
    Set-JsonVersion $desktopPkgPath $Version
    $rootJson = Get-Content -LiteralPath $rootPkgPath -Raw | ConvertFrom-Json
    if ([string]$rootJson.version -ne $Version) {
      Write-Host "写入版本 $Version -> package.json"
      Set-JsonVersion $rootPkgPath $Version
    }
    $desktopPkgJson = Get-Content -LiteralPath $desktopPkgPath -Raw | ConvertFrom-Json
  }
}

$appEnglishName = 'Koubox'
$appVersion = [string]$desktopPkgJson.version
Write-Host "打包版本：$appVersion"
$distFolderName = "$appEnglishName-$appVersion"

$releaseDir = Join-Path $root 'apps\desktop\release'
$builderUnpacked = Join-Path $releaseDir 'win-unpacked'
$distDir = Join-Path $releaseDir $distFolderName
$exe = Join-Path $distDir '口播匣.exe'
$resources = Join-Path $distDir 'resources'

function Assert-Path([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "失败：找不到 $Label：$Path"
  }
}

function Assert-NotPacked([string] $Haystack, [string] $Needle, [string] $Label) {
  if ($Haystack -match $Needle) {
    throw "失败：$Label"
  }
}

function Remove-PythonCaches([string]$TargetRoot) {
  $sourceRoot = [IO.Path]::GetFullPath($TargetRoot)
  $caches = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
  foreach ($cache in $caches) {
    $resolved = [IO.Path]::GetFullPath($cache.FullName)
    if (-not $resolved.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理 Python 缓存目录之外的路径：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  $remaining = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    throw "Python 源码仍包含 __pycache__：$sourceRoot"
  }
}

function Remove-PythonSourceCaches {
  Remove-PythonCaches (Join-Path $root 'python\src')
}

function Remove-OldRelease {
  if (-not (Test-Path -LiteralPath $releaseDir)) {
    Write-Host "无旧产物：$releaseDir"
    return
  }
  Stop-ProcessesForRelease $releaseDir
  $resolvedRelease = [IO.Path]::GetFullPath($releaseDir)
  $desktopRoot = [IO.Path]::GetFullPath((Join-Path $root 'apps\desktop'))
  if (-not $resolvedRelease.StartsWith($desktopRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝删除仓库 apps/desktop 之外的目录：$resolvedRelease"
  }
  Write-Host "删除旧打包产物：$resolvedRelease"
  $lastDeleteError = $null
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $resolvedRelease -Recurse -Force -ErrorAction Stop
      $lastDeleteError = $null
      break
    } catch {
      $lastDeleteError = $_.Exception
      Write-Host "旧产物删除重试 $attempt/5：$($_.Exception.Message)"
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
  if ($lastDeleteError -and (Test-Path -LiteralPath $resolvedRelease)) {
    Write-Host '常规删除重试仍失败，改用 .NET 扩展路径删除。'
    try {
      [IO.Directory]::Delete("\\?\$resolvedRelease", $true)
    } catch {
      $remaining = @(Get-ChildItem -LiteralPath $resolvedRelease -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 12 -ExpandProperty FullName)
      $detail = if ($remaining.Count -gt 0) { $remaining -join "`n" } else { '(目录内容不可枚举)' }
      throw "旧打包产物删除失败：$resolvedRelease`n$($_.Exception.Message)`n残留示例：`n$detail"
    }
  }
  if (Test-Path -LiteralPath $resolvedRelease) {
    throw "旧打包产物未彻底删除：$resolvedRelease"
  }
}

function Stop-ProcessesForRelease([string]$TargetDirectory) {
  if (-not (Test-Path -LiteralPath $TargetDirectory)) { return }
  $targetPrefix = (Resolve-Path -LiteralPath $TargetDirectory).Path.TrimEnd('\') + '\'
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
      $executablePath = [string]$_.ExecutablePath
      $executablePath -and $executablePath.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($processes.Count -eq 0) { return }
    foreach ($process in ($processes | Sort-Object ProcessId -Descending)) {
      Write-Host "结束占用旧发布目录的进程：$($process.Name) PID $($process.ProcessId)"
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
  }
  throw "无法结束旧发布目录中的残留进程：$TargetDirectory"
}

function Invoke-Preflight {
  Write-Host '== 预检 =='
  Remove-PythonSourceCaches

  $mainIndex = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\src\main\index.ts') -Raw
  if ($mainIndex -notmatch 'usePortableUserData') {
    throw '预检失败：主进程缺少便携 userdata 逻辑。'
  }
  if ($mainIndex -notmatch 'pinBundledPaths:\s*app\.isPackaged') {
    throw '预检失败：主进程未在打包态锁定包内工具/模型路径。'
  }

  $desktopPkg = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\package.json') -Raw
  Assert-Path (Join-Path $root 'scripts\prepare-playwright-browsers.mjs') 'Playwright 浏览器准备脚本'
  Assert-NotPacked $desktopPkg 'wheels' 'extraResources 里出现了 wheels，whl 不应打进安装包。'
  Assert-NotPacked $desktopPkg '"from":\s*"\.\./\.\./models"' 'extraResources 不应复制开发机 models；便携包只保留空 models 目录。'
  if ($desktopPkg -notmatch '"from":\s*"../../python/\.venv"') {
    throw '预检失败：打包没有包含 python/.venv。'
  }
  if ($desktopPkg -notmatch '"target":\s*\[\s*"dir"\s*\]') {
    throw '预检失败：Win 产物应为 dir（解压即用），不是 nsis。'
  }

  Assert-Path (Join-Path $root 'vendor\yt-dlp\yt-dlp.exe') 'yt-dlp'
  Assert-Path (Join-Path $root 'vendor\deno\deno.exe') 'Deno'
  Assert-Path (Join-Path $root 'vendor\ffmpeg\bin\ffmpeg.exe') 'ffmpeg'
  Assert-Path (Join-Path $root 'vendor\ffmpeg\bin\ffprobe.exe') 'ffprobe'
  Assert-Path (Join-Path $root 'node_modules\.pnpm\playwright@1.62.1\node_modules\playwright\package.json') 'Playwright Node 依赖'
  Assert-Path (Join-Path $root 'python\.venv\Scripts\python.exe') 'Python 虚拟环境'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\torch') '已安装的 torch'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\yt_dlp') '参考 TikTok 下载器 yt-dlp 依赖'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\curl_cffi') '参考 TikTok 下载器 curl_cffi 依赖'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\faster_whisper') '精准 SRT Faster-Whisper 依赖'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\janome') '精准 SRT Janome 依赖'
  Assert-Path (Join-Path $root 'python\src\stable_whisper\LICENSE') 'stable-ts MIT LICENSE'
  Assert-Path (Join-Path $root 'python\src\stable_whisper\SHA256SUMS.txt') 'stable-ts SHA256 清单'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\precise_srt.py') '精准 SRT Python 模块'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\precise_srt_terms.toml') '精准 SRT 内置规则'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\precise_srt_segmentation.py') '精准 SRT 分段模块'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\precise_srt_retry.py') '精准 SRT 复识别模块'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\precise_srt_worker.py') '精准 SRT worker 模块'
  Assert-Path (Join-Path $root 'python\src\koubox_runtime\reference_tiktok\sites\tiktok.py') '复制的 TikTok 下载器源码'

  $freeGb = [math]::Round((Get-PSDrive -Name D).Free / 1GB, 2)
  if ($freeGb -lt 25) {
    throw "预检失败：D 盘剩余 ${freeGb} GB，打包需要大约 25 GB 空闲。"
  }
  Write-Host "D 盘剩余 ${freeGb} GB"

  $venvPython = Join-Path $root 'python\.venv\Scripts\python.exe'
  $torchInfo = & $venvPython -c "import torch; print(torch.__version__); print(int(torch.cuda.is_available()))"
  $lines = @($torchInfo -split '\r?\n' | Where-Object { $_ -ne '' })
  Write-Host "torch $($lines[0])  cuda=$($lines[1])"
  if ($lines[0] -notmatch 'cu12') {
    throw "预检失败：venv 里的 torch 不是 CUDA 包：$($lines[0])"
  }

  $whl = Join-Path $root 'python\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl'
  if (Test-Path -LiteralPath $whl) {
    Write-Host "开发机保留了 torch whl（不会打进包）：$whl"
  }

  $electronDist = Join-Path $root 'node_modules\.pnpm\electron@33.4.11\node_modules\electron\dist\electron.exe'
  Assert-Path $electronDist '本地 Electron（避免打包时再下载）'

  $proxy = "http://127.0.0.1:$ProxyPort"
  foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {
    Set-Item -Path "Env:$name" -Value $proxy
  }
  Write-Host "代理已固定为 $proxy"

  node (Join-Path $root 'scripts\prepare-playwright-browsers.mjs')
  if ($LASTEXITCODE -ne 0) {
    throw "预检失败：Playwright 浏览器准备失败，退出码 $LASTEXITCODE"
  }

  Write-Host '预检通过。'
}

function Repair-PackedPyvenvHome {
  # afterPack 写入的是 win-unpacked 绝对路径；目录改名为 Koubox-x.y.z 后必须改写，
  # 否则 uv 的 Scripts\python.exe 会报 No Python at '...win-unpacked\...\python-home'。
  # 应用启动时 patchBundledPythonHome 还会再写一次（用户移动文件夹后仍可用）。
  $cfgPath = Join-Path $resources 'python\pyvenv.cfg'
  $pyHome = Join-Path $resources 'python-home'
  $pyHomeExe = Join-Path $pyHome 'python.exe'
  Assert-Path $cfgPath '包内 pyvenv.cfg'
  Assert-Path $pyHomeExe '包内 CPython home\python.exe'

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
}

function Invoke-Postflight {
  Write-Host '== 打包结果校验 =='
  Assert-Path $exe '口播匣.exe'
  Assert-Path (Join-Path $resources 'vendor\yt-dlp\yt-dlp.exe') '包内 yt-dlp'
  Assert-Path (Join-Path $resources 'vendor\deno\deno.exe') '包内 Deno'
  Assert-Path (Join-Path $resources 'vendor\ffmpeg\bin\ffmpeg.exe') '包内 ffmpeg'
  Assert-Path (Join-Path $resources 'vendor\ffmpeg\bin\ffprobe.exe') '包内 ffprobe'
  Assert-Path (Join-Path $resources 'app.asar') '包内 Electron 应用'
  $packedModels = Join-Path $resources 'models'
  Assert-Path $packedModels '包内空 models 目录'
  $packedModelEntries = @(Get-ChildItem -LiteralPath $packedModels -Force -ErrorAction SilentlyContinue)
  if ($packedModelEntries.Count -ne 0) {
    throw ("校验失败：resources\models 必须为空，发现：`n" + ($packedModelEntries.FullName -join "`n"))
  }
  Write-Host 'resources\models 已验证为空；模型需由用户手动放入。'
  Assert-Path (Join-Path $resources 'python\Scripts\python.exe') '包内 Python'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\c10.dll') '包内 torch c10.dll'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\MSVCP140.dll') '包内 VC++ MSVCP140（WinError 126 依赖）'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\VCRUNTIME140.dll') '包内 VC++ VCRUNTIME140'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\yt_dlp') '包内参考 TikTok yt-dlp'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\curl_cffi') '包内参考 TikTok curl_cffi'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\faster_whisper') '包内 Faster-Whisper'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\janome') '包内 Janome'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime') '包内 Python 源码'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\reference_tiktok\sites\tiktok.py') '包内复制的 TikTok 下载器源码'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\precise_srt.py') '包内精准 SRT 模块'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\precise_srt_terms.toml') '包内精准 SRT 内置规则'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\precise_srt_segmentation.py') '包内精准 SRT 分段模块'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\precise_srt_retry.py') '包内精准 SRT 复识别模块'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime\precise_srt_worker.py') '包内精准 SRT worker 模块'
  Assert-Path (Join-Path $resources 'python\src\stable_whisper\LICENSE') '包内 stable-ts MIT LICENSE'
  $stableHashFile = Join-Path $resources 'python\src\stable_whisper\SHA256SUMS.txt'
  Assert-Path $stableHashFile '包内 stable-ts SHA256 清单'
  $stableRoot = Join-Path $resources 'python\src\stable_whisper'
  foreach ($line in Get-Content -LiteralPath $stableHashFile) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
    $stableFile = Join-Path $stableRoot $matches[2]
    Assert-Path $stableFile "stable-ts 受控文件 $($matches[2])"
    $actualHash = (Get-FileHash -LiteralPath $stableFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $matches[1]) {
      throw "校验失败：stable-ts 文件哈希不一致：$($matches[2])"
    }
  }
  $packedPythonSource = Join-Path $resources 'python\src'
  Remove-PythonCaches $packedPythonSource
  $pythonCaches = @(Get-ChildItem -LiteralPath $packedPythonSource -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
  if ($pythonCaches.Count -gt 0) {
    throw ("校验失败：包内 Python 源码含 __pycache__：`n" + ($pythonCaches.FullName -join "`n"))
  }

  $playwrightChrome = Get-ChildItem -LiteralPath (Join-Path $resources 'playwright-browsers') -Recurse -Filter 'chrome.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $playwrightChrome) {
    throw "校验失败：包内缺少 Playwright Chromium：$(Join-Path $resources 'playwright-browsers')"
  }
  Write-Host "Playwright Chromium：$($playwrightChrome.FullName)"

  Repair-PackedPyvenvHome

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

  # 空 userdata：用户首次启动才生成配置与登录态，不把开发机 Cookie 打进去
  $userdata = Join-Path $distDir 'userdata'
  New-Item -ItemType Directory -Path $userdata -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $userdata 'README.txt') -Encoding UTF8 -Value @(
    '此目录存放便携版用户配置与登录 Cookie。'
    '首次启动后自动生成。分发压缩包前请保持为空（可保留本 README）。'
    '请勿把开发机的 AppData 或已登录的 userdata 打进发布包。'
  )

  $packedPython = Join-Path $resources 'python\Scripts\python.exe'
  $torchLib = Join-Path $resources 'python\Lib\site-packages\torch\lib'
  $env:PYTHONPATH = Join-Path $resources 'python\src'
  $env:PYTHONDONTWRITEBYTECODE = '1'
  $env:Path = "$torchLib;$env:Path"
  $importOut = & $packedPython -c "import torch, koubox_runtime, stable_whisper, janome, faster_whisper; import koubox_runtime.precise_srt, koubox_runtime.precise_srt_segmentation, koubox_runtime.precise_srt_retry, koubox_runtime.precise_srt_worker; print(torch.__version__); print(stable_whisper.__version__); print('precise-srt-runtime-ok')"
  $importText = ($importOut | Out-String)
  Write-Host $importText.Trim()
  if ($importText -notmatch 'precise-srt-runtime-ok') {
    throw '校验失败：包内 Python 无法 import 精准 SRT 运行时依赖。'
  }
  $postImportCaches = @(Get-ChildItem -LiteralPath $packedPythonSource -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
  if ($postImportCaches.Count -gt 0) {
    throw '校验失败：包内 import 后重新生成了 __pycache__。'
  }

  Write-Host ''
  Write-Host '便携目录已生成（解压即用）：'
  Write-Host $distDir
  Write-Host '双击 口播匣.exe。工具路径会指向 resources\；请把模型手动放入 resources\models，登录需用户自己完成。'
  Write-Host "把整个 $distFolderName（含空 userdata）打成 7z/zip 发给用户即可。"
}

# ---- main ----
if ($CleanOnly) {
  Remove-OldRelease
  Write-Host '已清理旧打包产物。'
  exit 0
}

if ($PostflightOnly) {
  Invoke-Postflight
  exit 0
}

Invoke-Preflight

if ($SkipPackage) {
  Write-Host '已跳过真正打包（-SkipPackage）。手动打包请去掉该参数再执行。'
  exit 0
}

Remove-OldRelease

Write-Host "开始 electron-builder（dir），完成后将目录改名为 $distFolderName ..."
pnpm --filter @koubox/desktop package
if ($LASTEXITCODE -ne 0) {
  throw "electron-builder 失败，退出码 $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $builderUnpacked)) {
  throw "打包后找不到 $builderUnpacked"
}
if (Test-Path -LiteralPath $distDir) {
  Remove-Item -LiteralPath $distDir -Recurse -Force
}
Rename-Item -LiteralPath $builderUnpacked -NewName $distFolderName
Write-Host "产物目录：$distDir"

Invoke-Postflight
