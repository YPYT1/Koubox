# Write a .sha256 sidecar for one file or one folder.
# Usage:
#   make-sha256.cmd
#   make-sha256.cmd "E:\kubox"
#   make-sha256.cmd "E:\kubox\Koubox-0.5.0.rar"
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File make-sha256.ps1 -Path "E:\kubox"
#
# File   -> <filename>.sha256 next to the file
# Folder -> <foldername>.sha256 in the parent folder (one hash line per file)

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs = @(),
  [string]$Path = ''
)

$ErrorActionPreference = 'Stop'

function Ensure-WinForms {
  if (-not ('System.Windows.Forms.Form' -as [type])) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
  }
}

function Show-Hint([string] $Message) {
  Ensure-WinForms
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    'Make SHA256',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}

function Ask-Kind {
  Ensure-WinForms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Make SHA256'
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(380, 130)
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Choose what to hash.`nA .sha256 file will be written next to it."
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(16, 14)
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

function Pick-File([string] $InitialDirectory) {
  Ensure-WinForms
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select a file to hash'
  $dialog.Filter = 'All files (*.*)|*.*|Archives (*.rar;*.7z;*.zip)|*.rar;*.7z;*.zip'
  $dialog.CheckFileExists = $true
  if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.InitialDirectory = $InitialDirectory
  }
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Cancelled.'
    exit 0
  }
  return $dialog.FileName
}

function Pick-Folder([string] $InitialDirectory) {
  Ensure-WinForms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select a folder to hash'
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

function Get-SidecarPath([string] $ItemPath, [bool] $IsFolder) {
  if ($IsFolder) {
    $parent = Split-Path -Parent $ItemPath
    $name = Split-Path -Leaf $ItemPath
    return (Join-Path $parent "$name.sha256")
  }
  return "$ItemPath.sha256"
}

function Resolve-InputPath {
  if ($Path.Trim()) { return $Path.Trim() }
  if ($RemainingArgs.Count -gt 0) { return ($RemainingArgs -join ' ').Trim() }
  return ''
}

$cliMode = $false
$startDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Path = Resolve-InputPath

if ($Path) {
  $cliMode = $true
} else {
  $kind = Ask-Kind
  if ($kind -eq 'folder') {
    $Path = Pick-Folder $startDir
  } else {
    $Path = Pick-File $startDir
  }
}

if (-not (Test-Path -LiteralPath $Path)) { throw "Path not found: $Path" }

$item = Get-Item -LiteralPath $Path
$isFolder = [bool]$item.PSIsContainer
$sidecar = Get-SidecarPath $item.FullName $isFolder
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

if (-not $isFolder) {
  Write-Host "Calculating SHA256: $($item.FullName)  ($([math]::Round($item.Length / 1GB, 3)) GB)"
  $hash = Get-Sha256Hex $item.FullName
  $text = @(
    '# SHA256'
    "# File: $($item.Name)"
    "# Bytes: $($item.Length)"
    "# Generated: $stamp"
    "$hash  $($item.Name)"
  ) -join "`r`n"
  [System.IO.File]::WriteAllText($sidecar, $text + "`r`n")
  Write-Host "Wrote $sidecar"
  Write-Host "  $hash  $($item.Name)"
  if (-not $cliMode) { Show-Hint "Wrote:`n$sidecar`n`n$hash" }
  exit 0
}

$rootFull = $item.FullName
$files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction SilentlyContinue |
  Sort-Object FullName)
Write-Host "Hashing folder: $rootFull  ($($files.Count) files)"
$lines = @(
  '# SHA256 manifest'
  "# Folder: $($item.Name)"
  "# Root: $rootFull"
  "# Files: $($files.Count)"
  "# Generated: $stamp"
  ''
)
$i = 0
foreach ($f in $files) {
  $i++
  $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\')
  if ($i % 100 -eq 0 -or $i -eq $files.Count) {
    Write-Host "  $i / $($files.Count)  $rel"
  }
  $hash = Get-Sha256Hex $f.FullName
  $lines += "$hash  $rel"
}
[System.IO.File]::WriteAllText($sidecar, (($lines -join "`r`n") + "`r`n"))
Write-Host "Wrote $sidecar"
if (-not $cliMode) { Show-Hint "Wrote:`n$sidecar`n`n$($files.Count) files hashed." }
exit 0
