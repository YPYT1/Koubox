Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime') '包内 Python 源码'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\reference_tiktok\sites\tiktok.py') '包内复制的 TikTok 下载器源码'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\precise_srt.py') '包内精准 SRT 模块'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\precise_srt_terms.toml') '包内精准 SRT 内置规则'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\precise_srt_segmentation.py') '包内精准 SRT 分段模块'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\precise_srt_retry.py') '包内精准 SRT 复识别模块'
Assert-PackPath (Join-Path $resources 'python\src\koubox_runtime\precise_srt_worker.py') '包内精准 SRT worker 模块'
Assert-PackPath (Join-Path $resources 'python\src\stable_whisper\LICENSE') '包内 stable-ts MIT LICENSE'

$stableHashFile = Join-Path $resources 'python\src\stable_whisper\SHA256SUMS.txt'
Assert-PackPath $stableHashFile '包内 stable-ts SHA256 清单'
$stableRoot = Join-Path $resources 'python\src\stable_whisper'
foreach ($line in Get-Content -LiteralPath $stableHashFile) {
  if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
  $stableFile = Join-Path $stableRoot $matches[2]
  Assert-PackPath $stableFile "stable-ts 受控文件 $($matches[2])"
  $actualHash = Get-PackFileSha256 $stableFile
  if ($actualHash -ne $matches[1]) {
    throw "校验失败：stable-ts 文件哈希不一致：$($matches[2])"
  }
}
Write-Host '包内精准 SRT 源码与 stable-ts 哈希校验通过。'
