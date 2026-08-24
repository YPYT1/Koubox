# 口播匣便携包打包脚本
# 用法：
#   pnpm pack:portable
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-portable.ps1
#   ... -CleanOnly              只删除旧 release/win-unpacked
#   ... -SkipPackage            只预检，不真正打包（给你手动打包前验证）
#   ... -ProxyPort 7897         代理端口，默认 7897
#   ... -KeepRelease            打包前不删旧产物（默认会删）
#
# 说明：
# - 不打包 python/wheels（2.6GB 的 torch.whl）
# - 不打包 AppData 登录态 / Cookie；便携版用 exe 旁 userdata（空目录）
# - 打包版强制使用 resources 内的 models / vendor / python

param(
  [int]$ProxyPort = 7897,
  [switch]$CleanOnly,
  [switch]$SkipPackage,
  [switch]$KeepRelease
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$releaseDir = Join-Path $root 'apps\desktop\release'
$unpacked = Join-Path $releaseDir 'win-unpacked'
$exe = Join-Path $unpacked '口播匣.exe'
$resources = Join-Path $unpacked 'resources'

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

function Remove-OldRelease {
  if (-not (Test-Path -LiteralPath $releaseDir)) {
    Write-Host "无旧产物：$releaseDir"
    return
  }
  Write-Host "删除旧打包产物：$releaseDir"
  Remove-Item -LiteralPath $releaseDir -Recurse -Force
}

function Invoke-Preflight {
  Write-Host '== 预检 =='

  $mainIndex = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\src\main\index.ts') -Raw
  if ($mainIndex -notmatch 'usePortableUserData') {
    throw '预检失败：主进程缺少便携 userdata 逻辑。'
  }
  if ($mainIndex -notmatch 'pinBundledPaths:\s*app\.isPackaged') {
    throw '预检失败：主进程未在打包态锁定包内工具/模型路径。'
  }

  $desktopPkg = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\package.json') -Raw
  Assert-NotPacked $desktopPkg 'wheels' 'extraResources 里出现了 wheels，whl 不应打进安装包。'
  if ($desktopPkg -notmatch '"from":\s*"../../python/\.venv"') {
    throw '预检失败：打包没有包含 python/.venv。'
  }
  if ($desktopPkg -notmatch '"target":\s*\[\s*"dir"\s*\]') {
    throw '预检失败：Win 产物应为 dir（解压即用），不是 nsis。'
  }

  Assert-Path (Join-Path $root 'vendor\yt-dlp\yt-dlp.exe') 'yt-dlp'
  Assert-Path (Join-Path $root 'vendor\ffmpeg\bin\ffmpeg.exe') 'ffmpeg'
  Assert-Path (Join-Path $root 'vendor\ffmpeg\bin\ffprobe.exe') 'ffprobe'
  Assert-Path (Join-Path $root 'models\faster-whisper-large-v3\model.bin') 'Whisper 模型'
  Assert-Path (Join-Path $root 'models\HYMT21.8B\model.safetensors') '翻译模型'
  Assert-Path (Join-Path $root 'models\demucs') 'Demucs 模型目录'
  Assert-Path (Join-Path $root 'python\.venv\Scripts\python.exe') 'Python 虚拟环境'
  Assert-Path (Join-Path $root 'python\.venv\Lib\site-packages\torch') '已安装的 torch'

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

  Write-Host '预检通过。'
}

function Invoke-Postflight {
  Write-Host '== 打包结果校验 =='
  Assert-Path $exe '口播匣.exe'
  Assert-Path (Join-Path $resources 'vendor\yt-dlp\yt-dlp.exe') '包内 yt-dlp'
  Assert-Path (Join-Path $resources 'vendor\ffmpeg\bin\ffmpeg.exe') '包内 ffmpeg'
  Assert-Path (Join-Path $resources 'models\faster-whisper-large-v3\model.bin') '包内 Whisper'
  Assert-Path (Join-Path $resources 'models\HYMT21.8B\model.safetensors') '包内翻译模型'
  Assert-Path (Join-Path $resources 'python\Scripts\python.exe') '包内 Python'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch') '包内 torch'
  Assert-Path (Join-Path $resources 'python-home\python.exe') '包内 CPython home'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime') '包内 Python 源码'

  $forbidden = @(
    (Join-Path $resources 'python\wheels'),
    (Join-Path $unpacked 'userdata\runtime.json'),
    (Join-Path $unpacked 'userdata\ytdlp-cookies.txt'),
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
  $userdata = Join-Path $unpacked 'userdata'
  New-Item -ItemType Directory -Path $userdata -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $userdata 'README.txt') -Encoding UTF8 -Value @(
    '此目录存放便携版用户配置与登录 Cookie。'
    '首次启动后自动生成。分发压缩包前请保持为空（可保留本 README）。'
    '请勿把开发机的 AppData 或已登录的 userdata 打进发布包。'
  )

  $packedPython = Join-Path $resources 'python\Scripts\python.exe'
  $env:PYTHONPATH = Join-Path $resources 'python\src'
  $importOut = & $packedPython -c "import torch, koubox_runtime; print(torch.__version__); print('runtime-ok')"
  $importText = ($importOut | Out-String)
  Write-Host $importText.Trim()
  if ($importText -notmatch 'runtime-ok') {
    throw '校验失败：包内 Python 无法 import koubox_runtime / torch。'
  }

  Write-Host ''
  Write-Host '便携目录已生成（解压即用）：'
  Write-Host $unpacked
  Write-Host '双击 口播匣.exe。工具/模型路径会指向 resources\；登录需用户自己完成。'
  Write-Host '把整个 win-unpacked（含空 userdata）打成 7z/zip 发给用户即可。'
}

# ---- main ----
if ($CleanOnly) {
  Remove-OldRelease
  Write-Host '已清理旧打包产物。'
  exit 0
}

Invoke-Preflight

if ($SkipPackage) {
  Write-Host '已跳过真正打包（-SkipPackage）。手动打包请去掉该参数再执行。'
  exit 0
}

if (-not $KeepRelease) {
  Remove-OldRelease
}

Write-Host '开始 electron-builder（dir，解压即用）...'
pnpm --filter @koubox/desktop package
if ($LASTEXITCODE -ne 0) {
  throw "electron-builder 失败，退出码 $LASTEXITCODE"
}

Invoke-Postflight
