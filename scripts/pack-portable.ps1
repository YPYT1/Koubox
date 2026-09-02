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
# 钩子脚本目录：scripts/pack/hooks/
# 共享清单：    scripts/pack/manifests/pack-manifest.json
#
# 说明：
# - 不打包 python/wheels（2.6GB 的 torch.whl）
# - 不打包 AppData 登录态 / Cookie；便携版用 exe 旁 userdata（空目录）
# - 打包版强制使用 resources 内的 vendor / python
# - resources/models 只创建空目录，模型由用户手动放入
# - 开发机 vendor 若是 Junction，after-pack 会解引用成实体，避免分发后断链
# - 分发给用户时请只压缩 Koubox-x.y.z 目录，不要压缩整个 apps/desktop/release

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

$packLib = Join-Path $PSScriptRoot 'pack\lib\common.ps1'
$packHooks = Join-Path $PSScriptRoot 'pack\hooks'
. $packLib
$manifest = Get-PackManifest

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
  Invoke-PackHooks -Phase 'preflight' -HooksDirectory $packHooks
  Write-Host '预检通过。'
}

function Invoke-Postflight {
  Write-Host '== 打包结果校验 =='
  Invoke-PackHooks -Phase 'postflight' -HooksDirectory $packHooks
  Write-Host ''
  Write-Host '便携目录已生成（解压即用）：'
  Write-Host $distDir
  Write-Host '双击 口播匣.exe。工具路径会指向 resources\；请把模型手动放入 resources\models，登录需用户自己完成。'
  Write-Host "分发时请只压缩整个 $distFolderName（含空 userdata），不要压缩整个 apps/desktop/release。"
  Write-Host 'vendor 已要求为实体文件；若 postflight 报 Junction，说明 after-pack 解引用失败。'
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
