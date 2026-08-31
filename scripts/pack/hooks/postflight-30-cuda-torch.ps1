$sitePackages = Join-Path $resources 'python\Lib\site-packages'
Assert-PackNativeLibs -SitePackagesRoot $sitePackages -RelativePaths @($manifest.pythonNativeLibs) -Label '包内 Python CUDA 原生库'
Write-Host "包内 torch / ctranslate2 CUDA 原生库齐全（$($manifest.pythonNativeLibs.Count) 个受控文件）。"
