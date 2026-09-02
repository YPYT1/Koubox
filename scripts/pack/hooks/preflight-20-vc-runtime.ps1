$system32 = Join-Path $env:SystemRoot 'System32'
foreach ($dll in @($manifest.vcRuntimeDlls)) {
  Assert-PackPath (Join-Path $system32 $dll) "本机 VC++ 运行库 $dll"
}
Write-Host "本机 VC++ 运行库齐全（$($manifest.vcRuntimeDlls.Count) 个 DLL，打包时会复制进 torch / python / ffmpeg）。"
