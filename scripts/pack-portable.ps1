# 口播匣便携包打包脚本
# 用法：
#   pnpm pack:portable
#   pnpm pack:portable -- -Version 0.2.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-portable.ps1 -Version 0.2.0
#   ... -CleanOnly              只删除旧 release 产物（含 Koubox-*）
#   ... -SkipPackage            只预检，不真正打包（给你手动打包前验证）
#   ... -Version 0.2.0          指定发布版本（写入 apps/desktop/package.json，目录名 Koubox-0.2.0）
#   ... -ProxyPort 7897         打包时临时设置代理（默认留空，不注入代理）
#   ... -KeepRelease            打包前不删旧产物（默认会删）
#   ... -SkipModels             不打包 models（增量更新包；用户自备 / 外置模型）
#
# 压缩包请用 WinRAR 手动打（推荐「最好」）。脚本只产出目录，不压缩，不生成 .sha256 / COPY。
# SHA256 对比请自行用 E:\kubox\compare-sha256.cmd（或 scripts\compare-sha256.cmd）。
#
# 推荐流程：
#   1. pnpm pack:portable -- -Version 0.4.0          → 生成 Koubox-0.4.0 目录
#   2. WinRAR 压缩该目录为 Koubox-0.4.0.rar（最好）
#   不含 models 的增量包：
#   pnpm pack:portable:nomodels -- -Version 0.4.0
#
# 说明：
# - 不打包 python/wheels（2.6GB 的 torch.whl）
# - 不打包 AppData 登录态 / Cookie；便携版用 exe 旁 userdata（空目录）
# - 完整包：resources 含 models / vendor / python / python-home
# - -SkipModels：不打模型权重，只保留空 resources\models + README

param(
  [string]$Version = '',
  [int]$ProxyPort = 0,
  [switch]$CleanOnly,
  [switch]$SkipPackage,
  [switch]$KeepRelease,
  [switch]$VerifyOnly,
  [switch]$SkipModels
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
if ($SkipModels) {
  Write-Host '模式：不含 models（增量更新包）'
}
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
  if (-not $SkipModels) {
    Assert-Path (Join-Path $root 'models\faster-whisper-large-v3\model.bin') 'Whisper 模型'
    Assert-Path (Join-Path $root 'models\HYMT21.8B\model.safetensors') '翻译模型'
    Assert-Path (Join-Path $root 'models\demucs') 'Demucs 模型目录'
  } else {
    Write-Host '跳过本机 models 预检（本包不打入 models）。'
  }
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

  foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {
    if ($ProxyPort -gt 0) {
      Set-Item -Path "Env:$name" -Value "http://127.0.0.1:$ProxyPort"
    } elseif (Test-Path -LiteralPath "Env:$name") {
      Remove-Item -LiteralPath "Env:$name"
    }
  }
  if ($ProxyPort -gt 0) {
    Write-Host "代理已设置为 http://127.0.0.1:$ProxyPort"
  } else {
    Write-Host '代理：留空（未设置）'
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
  Assert-Path (Join-Path $resources 'vendor\ffmpeg\bin\ffmpeg.exe') '包内 ffmpeg'
  Assert-Path (Join-Path $resources 'python\Scripts\python.exe') '包内 Python'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\c10.dll') '包内 torch c10.dll'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\MSVCP140.dll') '包内 VC++ MSVCP140（WinError 126 依赖）'
  Assert-Path (Join-Path $resources 'python\Lib\site-packages\torch\lib\VCRUNTIME140.dll') '包内 VC++ VCRUNTIME140'
  Assert-Path (Join-Path $resources 'python\src\koubox_runtime') '包内 Python 源码'
  Assert-Path (Join-Path $resources 'python-home\python.exe') '包内 python-home'

  if ($SkipModels) {
    $modelsDir = Join-Path $resources 'models'
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $modelsDir 'README.txt') -Encoding UTF8 -Value @(
      '本包未内置模型（增量更新包）。'
      ''
      '请把旧版 Koubox 的 resources\models 整目录拷到这里，或在「模型与环境」里选择外置 models 目录。'
      '拷贝 / 外置后的 models 下需含：demucs、faster-whisper-large-v3、HYMT21.8B。'
    )
    $leaked = @(
      Get-ChildItem -LiteralPath $modelsDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'README.txt' }
    )
    if ($leaked.Count -gt 0) {
      throw ("校验失败：-SkipModels 包内不应出现模型文件：`n" + ($leaked.FullName -join "`n"))
    }
    Write-Host 'models：仅空目录 + README（未打入权重与子目录）。'
  } else {
    Assert-Path (Join-Path $resources 'models\faster-whisper-large-v3\model.bin') '包内 Whisper'
    Assert-Path (Join-Path $resources 'models\HYMT21.8B\model.safetensors') '包内翻译模型'
  }

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
  $env:Path = "$torchLib;$env:Path"
  $importOut = & $packedPython -c "import torch, koubox_runtime; print(torch.__version__); print('runtime-ok')"
  $importText = ($importOut | Out-String)
  Write-Host $importText.Trim()
  if ($importText -notmatch 'runtime-ok') {
    throw '校验失败：包内 Python 无法 import koubox_runtime / torch。'
  }

  Write-Host ''
  Write-Host '便携目录已生成（解压即用）：'
  Write-Host $distDir
  if ($SkipModels) {
    Write-Host '本包不含模型权重。请拷贝旧版 resources\models，或在「模型与环境」选择外置 models。'
  } else {
    Write-Host '双击 口播匣.exe。工具/模型路径会指向 resources\；登录需用户自己完成。'
  }
  Assert-NoReparsePoints $distDir
  Write-Host "把整个 $distFolderName 用 WinRAR 打成 $distFolderName.rar（压缩方式：最好）。"
  Write-Host '复制后用 E:\kubox\compare-sha256.cmd 自行对比 SHA256（脚本不生成校验文件）。'
}

function Get-ReparsePoints([string] $Root) {
  return @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
}

function Assert-NoReparsePoints([string] $Root) {
  $links = Get-ReparsePoints $Root
  if ($links.Count -gt 0) {
    $sample = ($links | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join "`n"
    throw "校验失败：便携目录内仍有 $($links.Count) 个软链接/Junction，压缩或复制后可能变空目录：`n$sample"
  }
  Write-Host "软链接检查通过（0 个 ReparsePoint）。"
}

# ---- main ----
if ($VerifyOnly) {
  Write-Host '打包脚本不生成校验文件。请用 E:\kubox\compare-sha256.cmd 自行对比源文件与副本。'
  exit 0
}

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

Write-Host "开始 electron-builder（dir），完成后将目录改名为 $distFolderName ..."
$desktopPkgBackup = $null
if ($SkipModels) {
  $desktopPkgBackup = Get-Content -LiteralPath $desktopPkgPath -Raw
  if ($desktopPkgBackup -notmatch '"from":\s*"\.\./\.\./models"') {
    throw '预检失败：apps/desktop/package.json 未找到 models extraResources，无法剥离。'
  }
  $patched = [regex]::Replace(
    $desktopPkgBackup,
    '\s*\{\s*"from":\s*"\.\./\.\./models"\s*,\s*"to":\s*"models"\s*\}\s*,?',
    ''
  )
  if ($patched -eq $desktopPkgBackup) {
    throw '未能从 package.json 去掉 models extraResources。'
  }
  [System.IO.File]::WriteAllText($desktopPkgPath, $patched)
  Write-Host '已临时从 electron-builder 配置中移除 models。'
}

try {
  pnpm --filter @koubox/desktop package
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder 失败，退出码 $LASTEXITCODE"
  }
} finally {
  if ($null -ne $desktopPkgBackup) {
    [System.IO.File]::WriteAllText($desktopPkgPath, $desktopPkgBackup)
    Write-Host '已恢复 apps/desktop/package.json。'
  }
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
