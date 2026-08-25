# 口播匣增量便携包（不含 models）
# 用法：
#   pnpm pack:portable:nomodels
#   pnpm pack:portable:nomodels -- -Version 0.5.0
#
# 产物目录：apps/desktop/release/Koubox-<version>
# 含：python / python-home / vendor；不含模型权重。
# 用户把旧版 resources\models 拷进来，或在「模型与环境」选择外置 models。
# 本包只保留空的 resources\models（不含 demucs 等子目录）。

param(
  [string]$Version = '',
  [int]$ProxyPort = 0,
  [switch]$CleanOnly,
  [switch]$SkipPackage,
  [switch]$KeepRelease,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$main = Join-Path $PSScriptRoot 'pack-portable.ps1'
$forward = @{
  SkipModels = $true
  ProxyPort = $ProxyPort
}
if ($Version.Trim()) { $forward.Version = $Version.Trim() }
if ($CleanOnly) { $forward.CleanOnly = $true }
if ($SkipPackage) { $forward.SkipPackage = $true }
if ($KeepRelease) { $forward.KeepRelease = $true }
if ($VerifyOnly) { $forward.VerifyOnly = $true }

& $main @forward
