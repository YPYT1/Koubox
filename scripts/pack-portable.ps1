$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

function Assert-Path([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "预检失败：找不到 $Label：$Path"
  }
}

function Assert-NotPacked([string] $Haystack, [string] $Needle, [string] $Label) {
  if ($Haystack -match $Needle) {
    throw "预检失败：$Label"
  }
}

Write-Host '== 口播匣便携包预检 =='

$desktopPkg = Get-Content -LiteralPath (Join-Path $root 'apps\desktop\package.json') -Raw
Assert-NotPacked $desktopPkg 'wheels' 'extraResources 里出现了 wheels，whl 不应打进安装包。'
if ($desktopPkg -notmatch '"from":\s*"../../python/\.venv"') {
  throw '预检失败：打包没有包含 python/.venv。'
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

$venvPython = Join-Path $root 'python\.venv\Scripts\python.exe'
$torchInfo = & $venvPython -c "import torch; print(torch.__version__); print(int(torch.cuda.is_available()))"
$lines = $torchInfo -split '\r?\n'
Write-Host "torch $($lines[0])  cuda=$($lines[1])"
if ($lines[0] -notmatch 'cu12') {
  throw "预检失败：venv 里的 torch 不是 CUDA 包：$($lines[0])"
}

$whl = Join-Path $root 'python\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl'
if (Test-Path -LiteralPath $whl) {
  Write-Host "开发机保留了 torch whl（不会打进包）：$whl"
}

Write-Host '预检通过，开始 electron-builder（dir，解压即用）...'
pnpm --filter @koubox/desktop package
if ($LASTEXITCODE -ne 0) {
  throw "electron-builder 失败，退出码 $LASTEXITCODE"
}

$unpacked = Join-Path $root 'apps\desktop\release\win-unpacked'
$exe = Join-Path $unpacked '口播匣.exe'
$resources = Join-Path $unpacked 'resources'

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

$whlHits = @(Get-ChildItem -LiteralPath (Join-Path $resources 'python') -Filter '*.whl' -File -ErrorAction SilentlyContinue)
$whlHits += @(Get-ChildItem -LiteralPath $resources -Filter 'wheels' -Directory -ErrorAction SilentlyContinue)
if ($whlHits.Count -gt 0) {
  throw ("校验失败：包内出现了 wheels/whl：`n" + ($whlHits.FullName -join "`n"))
}

$packedPython = Join-Path $resources 'python\Scripts\python.exe'
$env:PYTHONPATH = Join-Path $resources 'python\src'
$importOut = & $packedPython -c "import torch, koubox_runtime; print(torch.__version__); print('runtime-ok')"
Write-Host $importOut
if ($importOut -notmatch 'runtime-ok') {
  throw '校验失败：包内 Python 无法 import koubox_runtime / torch。'
}

Write-Host ''
Write-Host "便携目录已生成（解压即用，双击 口播匣.exe）："
Write-Host $unpacked
Write-Host '把整个 win-unpacked 文件夹打成 7z/zip 发给用户即可。whl 未打入包内。'
