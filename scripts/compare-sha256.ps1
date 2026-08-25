# Compare SHA256 for two files or two folders after copying.
# Usage:
#   Double-click compare-sha256.cmd
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File compare-sha256.ps1
#   ... -Source "path\to\a.rar" -Target "path\to\b.rar"
#   ... -Source "path\to\folderA" -Target "path\to\folderB"

param(
  [string]$Source = '',
  [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show-StepHint([string] $Message, [string] $Title = 'SHA256 Comparison') {
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}

function Show-ResultBox([string] $Message, [bool] $Ok) {
  $icon = if ($Ok) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Error }
  [void][System.Windows.Forms.MessageBox]::Show($Message, 'SHA256 Comparison', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function Ask-Kind([string] $Title) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(380, 130)
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = 'Choose File or Folder to compare.'
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(16, 18)
  $form.Controls.Add($label)

  # Set DialogResult on the Button itself (do not Close() in a Click handler).
  $btnFile = New-Object System.Windows.Forms.Button
  $btnFile.Text = 'File'
  $btnFile.Size = New-Object System.Drawing.Size(100, 32)
  $btnFile.Location = New-Object System.Drawing.Point(16, 70)
  $btnFile.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $form.Controls.Add($btnFile)

  $btnFolder = New-Object System.Windows.Forms.Button
  $btnFolder.Text = 'Folder'
  $btnFolder.Size = New-Object System.Drawing.Size(100, 32)
  $btnFolder.Location = New-Object System.Drawing.Point(132, 70)
  $btnFolder.DialogResult = [System.Windows.Forms.DialogResult]::No
  $form.Controls.Add($btnFolder)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = 'Cancel'
  $btnCancel.Size = New-Object System.Drawing.Size(100, 32)
  $btnCancel.Location = New-Object System.Drawing.Point(248, 70)
  $btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($btnCancel)
  $form.CancelButton = $btnCancel

  $result = $form.ShowDialog()
  $form.Dispose()
  if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { return 'file' }
  if ($result -eq [System.Windows.Forms.DialogResult]::No) { return 'folder' }
  Write-Host 'Cancelled.'
  exit 0
}

function Pick-File([string] $Title, [string] $InitialDirectory) {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = $Title
  $dialog.Filter = 'All files (*.*)|*.*|Archives (*.rar;*.7z;*.zip)|*.rar;*.7z;*.zip|SHA256 (*.sha256)|*.sha256'
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

function Pick-Folder([string] $Title, [string] $InitialDirectory) {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $Title
  $dialog.ShowNewFolderButton = $false
  if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.SelectedPath = $InitialDirectory
  }
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Cancelled.'
    exit 0
  }
  return $dialog.SelectedPath
}

function Pick-PathByKind([string] $Kind, [string] $Title, [string] $InitialDirectory) {
  if ($Kind -eq 'folder') { return (Pick-Folder $Title $InitialDirectory) }
  return (Pick-File $Title $InitialDirectory)
}

function Get-PathKind([string] $Path) {
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) { return 'folder' }
  return 'file'
}

function Get-Sha256Hex([string] $FilePath) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
}

function Get-FileRecord([string] $Path) {
  $item = Get-Item -LiteralPath $Path
  Write-Host "Calculating SHA256: $($item.FullName)  ($([math]::Round($item.Length / 1GB, 3)) GB)"
  return [PSCustomObject]@{
    Rel = $item.Name
    Bytes = $item.Length
    Sha256 = (Get-Sha256Hex $item.FullName)
  }
}

function Get-FolderRecords([string] $Root) {
  $rootFull = (Get-Item -LiteralPath $Root).FullName
  $files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction SilentlyContinue)
  Write-Host "Hashing folder: $rootFull  ($($files.Count) files)"
  $map = @{}
  $i = 0
  foreach ($f in $files) {
    $i++
    $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\')
    if ($i % 100 -eq 0 -or $i -eq $files.Count) {
      Write-Host "  $i / $($files.Count)  $rel"
    }
    $map[$rel.ToLowerInvariant()] = [PSCustomObject]@{
      Rel = $rel
      Bytes = $f.Length
      Sha256 = (Get-Sha256Hex $f.FullName)
    }
  }
  return $map
}

$startDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

if (-not $Source.Trim()) {
  Show-StepHint "Step 1: Select the source.`nChoose File or Folder, then pick the original copy."
  $kind = Ask-Kind 'Step 1: File or Folder'
  $Source = Pick-PathByKind $kind 'Step 1: Select the source' $startDir
} else {
  $kind = Get-PathKind $Source
}

if (-not (Test-Path -LiteralPath $Source)) { throw "Source not found: $Source" }

if (-not $Target.Trim()) {
  $targetHint = Split-Path -Parent $Source
  if (-not $targetHint) { $targetHint = $startDir }
  Show-StepHint "Step 2: Select the target ($kind).`nThis is usually the copy on a USB drive or another computer."
  $Target = Pick-PathByKind $kind 'Step 2: Select the target' $targetHint
}

if (-not (Test-Path -LiteralPath $Target)) { throw "Target not found: $Target" }

$kindTarget = Get-PathKind $Target
if ($kindTarget -ne $kind) {
  throw "Source is a $kind but target is a $kindTarget. Both must be files or both must be folders."
}

Write-Host ''
Write-Host "Kind:   $kind"
Write-Host "Source: $Source"
Write-Host "Target: $Target"
Write-Host ''

if ($kind -eq 'file') {
  $left = Get-FileRecord $Source
  $right = Get-FileRecord $Target
  Write-Host ''
  Write-Host ("Source  Name   {0}" -f $left.Name)
  Write-Host ("        Size   {0} bytes" -f $left.Bytes)
  Write-Host ("        SHA256 {0}" -f $left.Sha256)
  Write-Host ("Target  Name   {0}" -f $right.Name)
  Write-Host ("        Size   {0} bytes" -f $right.Bytes)
  Write-Host ("        SHA256 {0}" -f $right.Sha256)
  Write-Host ''
  $sizeOk = $left.Bytes -eq $right.Bytes
  $hashOk = $left.Sha256 -eq $right.Sha256
  Write-Host '======== RESULT ========'
  if ($sizeOk -and $hashOk) {
    $msg = @(
      'SAME'
      'Source and target files are identical.'
      ("Size:   {0} bytes" -f $left.Bytes)
      ("SHA256: {0}" -f $left.Sha256)
    ) -join "`n"
    Write-Host 'SAME' -ForegroundColor Green
    Write-Host 'Source and target files are identical.' -ForegroundColor Green
    Write-Host ("Size:   {0} bytes" -f $left.Bytes)
    Write-Host ("SHA256: {0}" -f $left.Sha256)
    Show-ResultBox $msg $true
    exit 0
  }
  $lines = @('DIFFERENT', 'Source and target files are NOT the same.')
  Write-Host 'DIFFERENT' -ForegroundColor Red
  Write-Host 'Source and target files are NOT the same.' -ForegroundColor Red
  if (-not $sizeOk) {
    $line = "Size differs: source=$($left.Bytes) bytes, target=$($right.Bytes) bytes (diff=$([math]::Abs($left.Bytes - $right.Bytes)))."
    Write-Host $line -ForegroundColor Red
    $lines += $line
  }
  if (-not $hashOk) {
    $line = 'SHA256 differs:'
    Write-Host $line -ForegroundColor Red
    Write-Host ("  source {0}" -f $left.Sha256) -ForegroundColor Red
    Write-Host ("  target {0}" -f $right.Sha256) -ForegroundColor Red
    $lines += $line
    $lines += "  source $($left.Sha256)"
    $lines += "  target $($right.Sha256)"
  }
  Show-ResultBox ($lines -join "`n") $false
  exit 1
}

$leftMap = Get-FolderRecords $Source
$rightMap = Get-FolderRecords $Target
$leftKeys = @($leftMap.Keys)
$rightKeys = @($rightMap.Keys)

$missing = @($leftKeys | Where-Object { -not $rightMap.ContainsKey($_) } | ForEach-Object { $leftMap[$_].Rel } | Sort-Object)
$extra = @($rightKeys | Where-Object { -not $leftMap.ContainsKey($_) } | ForEach-Object { $rightMap[$_].Rel } | Sort-Object)
$changed = @()
foreach ($key in ($leftKeys | Where-Object { $rightMap.ContainsKey($_) } | Sort-Object)) {
  $a = $leftMap[$key]
  $b = $rightMap[$key]
  if ($a.Sha256 -ne $b.Sha256 -or $a.Bytes -ne $b.Bytes) {
    $changed += [PSCustomObject]@{
      Rel = $a.Rel
      SourceBytes = $a.Bytes
      TargetBytes = $b.Bytes
      SourceHash = $a.Sha256
      TargetHash = $b.Sha256
    }
  }
}

Write-Host ''
Write-Host ("Source files: {0}" -f $leftKeys.Count)
Write-Host ("Target files: {0}" -f $rightKeys.Count)
Write-Host ("Only in source:    {0}" -f $missing.Count)
Write-Host ("Only in target:    {0}" -f $extra.Count)
Write-Host ("Content different: {0}" -f $changed.Count)
Write-Host ''
Write-Host '======== RESULT ========'

function Write-PathList([string] $Label, [string[]] $Items) {
  if ($Items.Count -eq 0) { return }
  Write-Host $Label -ForegroundColor Red
  $Items | Select-Object -First 50 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  if ($Items.Count -gt 50) { Write-Host ("  ... {0} more" -f ($Items.Count - 50)) -ForegroundColor Red }
}

if ($missing.Count -eq 0 -and $extra.Count -eq 0 -and $changed.Count -eq 0) {
  $msg = @(
    'SAME'
    "Both folders are identical ($($leftKeys.Count) files)."
    "Source: $Source"
    "Target: $Target"
  ) -join "`n"
  Write-Host 'SAME' -ForegroundColor Green
  Write-Host "Both folders are identical ($($leftKeys.Count) files)." -ForegroundColor Green
  Show-ResultBox $msg $true
  exit 0
}

Write-Host 'DIFFERENT' -ForegroundColor Red
Write-Host 'The two folders are NOT the same.' -ForegroundColor Red
Write-PathList ("Files only in source ($($missing.Count)):") $missing
Write-PathList ("Files only in target ($($extra.Count)):") $extra
$boxLines = @(
  'DIFFERENT'
  'The two folders are NOT the same.'
  "Only in source: $($missing.Count)"
  "Only in target: $($extra.Count)"
  "Content different: $($changed.Count)"
)
if ($changed.Count -gt 0) {
  Write-Host ("Files with different content ($($changed.Count)):") -ForegroundColor Red
  $boxLines += ''
  $boxLines += 'Different files:'
  $changed | Select-Object -First 50 | ForEach-Object {
    Write-Host ("  {0}" -f $_.Rel) -ForegroundColor Red
    if ($_.SourceBytes -ne $_.TargetBytes) {
      Write-Host ("    size   source=$($_.SourceBytes)  target=$($_.TargetBytes)") -ForegroundColor Red
    }
    if ($_.SourceHash -ne $_.TargetHash) {
      Write-Host ("    sha256 source=$($_.SourceHash)") -ForegroundColor Red
      Write-Host ("           target=$($_.TargetHash)") -ForegroundColor Red
    }
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
