function Get-PackManifest {
  $manifestPath = Join-Path $PSScriptRoot '..\manifests\pack-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "找不到打包清单：$manifestPath"
  }
  return (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
}

function Assert-PackPath([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "失败：找不到 $Label：$Path"
  }
}

function Assert-PackFileSet {
  param(
    [Parameter(Mandatory = $true)][string] $Directory,
    [Parameter(Mandatory = $true)][string[]] $Files,
    [Parameter(Mandatory = $true)][string] $Label
  )
  if (-not (Test-Path -LiteralPath $Directory)) {
    throw "失败：$Label 目录不存在：$Directory"
  }
  $missing = @()
  $empty = @()
  foreach ($file in $Files) {
    $path = Join-Path $Directory $file
    if (-not (Test-Path -LiteralPath $path)) {
      $missing += $file
      continue
    }
    if ((Get-Item -LiteralPath $path).Length -le 0) {
      $empty += $file
    }
  }
  if ($missing.Count -gt 0) {
    throw ("失败：$Label 缺少文件：`n" + ($missing -join "`n"))
  }
  if ($empty.Count -gt 0) {
    throw ("失败：$Label 存在空文件：`n" + ($empty -join "`n"))
  }
}

function Assert-PackSitePackage {
  param(
    [Parameter(Mandatory = $true)][string] $SitePackagesRoot,
    [Parameter(Mandatory = $true)][string] $PackageName,
    [Parameter(Mandatory = $true)][string] $Label
  )
  $directory = Join-Path $SitePackagesRoot $PackageName
  $moduleFile = Join-Path $SitePackagesRoot "$PackageName.py"
  if (Test-Path -LiteralPath $directory) { return }
  if (Test-Path -LiteralPath $moduleFile) { return }
  throw "失败：找不到 $Label：$directory（或 $moduleFile）"
}

function Assert-PackNativeLibs {
  param(
    [Parameter(Mandatory = $true)][string] $SitePackagesRoot,
    [Parameter(Mandatory = $true)][string[]] $RelativePaths,
    [Parameter(Mandatory = $true)][string] $Label
  )
  $missing = @()
  foreach ($relative in $RelativePaths) {
    $path = Join-Path $SitePackagesRoot ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path)) {
      $missing += $relative
    }
  }
  if ($missing.Count -gt 0) {
    throw ("失败：$Label 缺少原生库：`n" + ($missing -join "`n"))
  }
}

function Invoke-PackPythonImportProbe {
  param(
    [Parameter(Mandatory = $true)][string] $PythonExecutable,
    [Parameter(Mandatory = $true)][string] $Probe,
    [string] $PythonSourceDirectory = '',
    [string] $TorchLibDirectory = ''
  )
  $savedPythonPath = $env:PYTHONPATH
  $savedPath = $env:Path
  $savedNoBytecode = $env:PYTHONDONTWRITEBYTECODE
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($PythonSourceDirectory) {
      $env:PYTHONPATH = $PythonSourceDirectory
    }
    $env:PYTHONDONTWRITEBYTECODE = '1'
    if ($TorchLibDirectory) {
      $env:Path = if ($savedPath) { "$TorchLibDirectory;$savedPath" } else { $TorchLibDirectory }
    }
    $output = & $PythonExecutable -c $Probe 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw ("Python import 探测失败（退出码 $LASTEXITCODE）：`n$output")
    }
    return $output
  } finally {
    $ErrorActionPreference = $prevEap
    $env:PYTHONPATH = $savedPythonPath
    $env:Path = $savedPath
    $env:PYTHONDONTWRITEBYTECODE = $savedNoBytecode
  }
}

function Invoke-PackFfmpegSmoke {
  param(
    [Parameter(Mandatory = $true)][string] $FfmpegExecutable,
    [Parameter(Mandatory = $true)][string] $Label
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $FfmpegExecutable -version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw ("失败：$Label ffmpeg -version 退出码 $LASTEXITCODE（常见于 DLL 缺失 / WinError 126）。`n$output")
    }
    if ($output -notmatch 'ffmpeg version') {
      throw "失败：$Label ffmpeg -version 输出异常。"
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Remove-PackPythonCaches([string] $TargetRoot) {
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

function Invoke-PackHooks {
  param(
    [Parameter(Mandatory = $true)][string] $Phase,
    [Parameter(Mandatory = $true)][string] $HooksDirectory
  )
  $hooks = @(Get-ChildItem -LiteralPath $HooksDirectory -Filter "$Phase-*.ps1" | Sort-Object Name)
  if ($hooks.Count -eq 0) {
    throw "找不到 $Phase 钩子：$HooksDirectory\$Phase-*.ps1"
  }
  foreach ($hook in $hooks) {
    Write-Host "-- $Phase hook: $($hook.Name) --"
    . $hook.FullName
  }
}
