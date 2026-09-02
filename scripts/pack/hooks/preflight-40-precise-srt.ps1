Remove-PackPythonCaches (Join-Path $root 'python\src')

Assert-PackPath (Join-Path $root 'python\src\stable_whisper\LICENSE') 'stable-ts MIT LICENSE'
Assert-PackPath (Join-Path $root 'python\src\stable_whisper\SHA256SUMS.txt') 'stable-ts SHA256 清单'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\precise_srt.py') '精准 SRT Python 模块'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\precise_srt_terms.toml') '精准 SRT 内置规则'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\precise_srt_segmentation.py') '精准 SRT 分段模块'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\precise_srt_retry.py') '精准 SRT 复识别模块'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\precise_srt_worker.py') '精准 SRT worker 模块'
Assert-PackPath (Join-Path $root 'python\src\koubox_runtime\reference_tiktok\sites\tiktok.py') '复制的 TikTok 下载器源码'

Write-Host '精准 SRT 源码与 stable-ts 清单就绪。'
