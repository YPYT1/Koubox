$bin = Join-Path $resources 'vendor\ffmpeg\bin'
Assert-PackFileSet -Directory $bin -Files @($manifest.ffmpegExpectedFiles) -Label '包内 ffmpeg vendor'
Invoke-PackFfmpegSmoke -FfmpegExecutable (Join-Path $bin 'ffmpeg.exe') -Label '包内 ffmpeg'
Write-Host "包内 ffmpeg vendor 完整且可执行（$($manifest.ffmpegExpectedFiles.Count) 个受控文件）。"
