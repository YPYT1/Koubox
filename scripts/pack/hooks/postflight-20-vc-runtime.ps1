foreach ($relative in @($manifest.vcRuntimeTargetSubdirs)) {
  $dir = Join-Path $resources ($relative -replace '/', '\')
  Assert-PackFileSet -Directory $dir -Files @($manifest.vcRuntimeDlls) -Label "包内 VC++ 目录 $relative"
}
Write-Host "包内 VC++ 运行库已复制到 torch / python / ffmpeg（$($manifest.vcRuntimeDlls.Count) x $($manifest.vcRuntimeTargetSubdirs.Count) 处）。"
