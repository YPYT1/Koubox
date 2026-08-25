# Compare two .sha256 checksum list files (fast; does not re-hash data files).
# Usage:
#   Double-click compare-sha256-lists.cmd
#   compare-sha256-lists.cmd "E:\kubox\models.sha256" "D:\Project\Koubox\models.sha256"
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File compare-sha256-lists.ps1 -Source a.sha256 -Target b.sha256

param(
  [string]$Source = '',
  [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Show-Hint([string] $Message) {
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    'Compare SHA256 Lists',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}

function Show-ResultBox([string] $Message, [bool] $Ok) {
  $icon = if ($Ok) {
    [System.Windows.Forms.MessageBoxIcon]::Information
  } else {
    [System.Windows.Forms.MessageBoxIcon]::Error
  }
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    'Compare SHA256 Lists',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    $icon
  )
}

function Pick-Sha256File([string] $Title, [string] $InitialDirectory) {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = $Title
  $dialog.Filter = 'SHA256 lists (*.sha256)|*.sha256|All files (*.*)|*.*'
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.InitialDirectory = $InitialDirectory
  }
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Cancelled.'
    exit 0
  }
  return $dialog.FileName
}

function Read-Sha256Map([string] $ManifestPath) {
  if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Checksum file not found: $ManifestPath"
  }
  $map = @{}
  $lineNo = 0
  foreach ($raw in Get-Content -LiteralPath $ManifestPath) {
    $lineNo++
    $line = $raw.Trim()
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }
    if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})\s+(?<name>.+)$') {
      throw "Invalid checksum line ${lineNo} in ${ManifestPath}: $raw"
    }
    $hash = $Matches['hash'].ToLowerInvariant()
    $name = $Matches['name'].Trim().Replace('/', '\')
    $key = $name.ToLowerInvariant()
    if ($map.ContainsKey($key)) {
      throw "Duplicate path in ${ManifestPath}: $name"
    }
    $map[$key] = [PSCustomObject]@{
      Rel = $name
      Sha256 = $hash
    }
  }
  if ($map.Count -eq 0) {
    throw "No hash lines found in: $ManifestPath"
  }
  return $map
}

$startDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

if (-not $Source.Trim()) {
  Show-Hint "Step 1: Select the SOURCE .sha256 file.`nExample: models.sha256 on your PC."
  $Source = Pick-Sha256File 'Step 1: Select SOURCE .sha256' $startDir
}
if (-not $Target.Trim()) {
  $hint = Split-Path -Parent $Source
  if (-not $hint) { $hint = $startDir }
  Show-Hint "Step 2: Select the TARGET .sha256 file.`nExample: the copy on a USB drive."
  $Target = Pick-Sha256File 'Step 2: Select TARGET .sha256' $hint
}

$Source = $Source.Trim()
$Target = $Target.Trim()

Write-Host ''
Write-Host "Source: $Source"
Write-Host "Target: $Target"
Write-Host ''

$left = Read-Sha256Map $Source
$right = Read-Sha256Map $Target

$leftKeys = @($left.Keys)
$rightKeys = @($right.Keys)

$missing = @($leftKeys | Where-Object { -not $right.ContainsKey($_) } | ForEach-Object { $left[$_].Rel } | Sort-Object)
$extra = @($rightKeys | Where-Object { -not $left.ContainsKey($_) } | ForEach-Object { $right[$_].Rel } | Sort-Object)
$changed = @()
foreach ($key in ($leftKeys | Where-Object { $right.ContainsKey($_) } | Sort-Object)) {
  if ($left[$key].Sha256 -ne $right[$key].Sha256) {
    $changed += [PSCustomObject]@{
      Rel = $left[$key].Rel
      Source = $left[$key].Sha256
      Target = $right[$key].Sha256
    }
  }
}

Write-Host ("Source entries: {0}" -f $leftKeys.Count)
Write-Host ("Target entries: {0}" -f $rightKeys.Count)
Write-Host ("Only in source:    {0}" -f $missing.Count)
Write-Host ("Only in target:    {0}" -f $extra.Count)
Write-Host ("Hash different:    {0}" -f $changed.Count)
Write-Host ''
Write-Host '======== RESULT ========'

function Write-PathList([string] $Label, [string[]] $Items) {
  if ($Items.Count -eq 0) { return }
  Write-Host $Label -ForegroundColor Red
  $Items | Select-Object -First 50 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  if ($Items.Count -gt 50) {
    Write-Host ("  ... {0} more" -f ($Items.Count - 50)) -ForegroundColor Red
  }
}

if ($missing.Count -eq 0 -and $extra.Count -eq 0 -and $changed.Count -eq 0) {
  $msg = @(
    'SAME'
    "Both .sha256 lists are identical ($($leftKeys.Count) entries)."
    "Source: $Source"
    "Target: $Target"
  ) -join "`n"
  Write-Host 'SAME' -ForegroundColor Green
  Write-Host "Both .sha256 lists are identical ($($leftKeys.Count) entries)." -ForegroundColor Green
  Show-ResultBox $msg $true
  exit 0
}

Write-Host 'DIFFERENT' -ForegroundColor Red
Write-Host 'The two .sha256 lists are NOT the same.' -ForegroundColor Red
Write-PathList ("Entries only in source ($($missing.Count)):") $missing
Write-PathList ("Entries only in target ($($extra.Count)):") $extra

$boxLines = @(
  'DIFFERENT'
  'The two .sha256 lists are NOT the same.'
  "Only in source: $($missing.Count)"
  "Only in target: $($extra.Count)"
  "Hash different: $($changed.Count)"
)

if ($changed.Count -gt 0) {
  Write-Host ("Entries with different SHA256 ($($changed.Count)):") -ForegroundColor Red
  $boxLines += ''
  $boxLines += 'Different entries:'
  $changed | Select-Object -First 50 | ForEach-Object {
    Write-Host ("  {0}" -f $_.Rel) -ForegroundColor Red
    Write-Host ("    source {0}" -f $_.Source) -ForegroundColor Red
    Write-Host ("    target {0}" -f $_.Target) -ForegroundColor Red
    $boxLines += "  $($_.Rel)"
  }
  if ($changed.Count -gt 50) {
    Write-Host ("  ... {0} more" -f ($changed.Count - 50)) -ForegroundColor Red
    $boxLines += "  ... $($changed.Count - 50) more"
  }
}
if ($missing.Count -gt 0) {
  $boxLines += ''
  $boxLines += 'Only in source:'
  $missing | Select-Object -First 20 | ForEach-Object { $boxLines += "  $_" }
}
if ($extra.Count -gt 0) {
  $boxLines += ''
  $boxLines += 'Only in target:'
  $extra | Select-Object -First 20 | ForEach-Object { $boxLines += "  $_" }
}

Show-ResultBox ($boxLines -join "`n") $false
exit 1
