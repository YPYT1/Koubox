$bin = Join-Path $root 'vendor\ffmpeg\bin'
Assert-PackFileSet -Directory $bin -Files @($manifest.ffmpegExpectedFiles) -Label '开发机 ffmpeg vendor'
Invoke-PackFfmpegSmoke -FfmpegExecutable (Join-Path $bin 'ffmpeg.exe') -Label '开发机 ffmpeg'
Write-Host "开发机 ffmpeg vendor 完整（$($manifest.ffmpegExpectedFiles.Count) 个受控文件）。"
