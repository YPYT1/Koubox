$venvRoot = Join-Path $root 'python\.venv'
$sitePackages = Join-Path $venvRoot 'Lib\site-packages'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
Assert-PackPath $venvPython 'Python 虚拟环境'

foreach ($package in @($manifest.pythonSitePackages)) {
  Assert-PackSitePackage -SitePackagesRoot $sitePackages -PackageName $package -Label "venv site-packages\$package"
}

Assert-PackNativeLibs -SitePackagesRoot $sitePackages -RelativePaths @($manifest.pythonNativeLibs) -Label '开发机 Python CUDA 原生库'

$importText = Invoke-PackPythonImportProbe `
  -PythonExecutable $venvPython `
  -Probe $manifest.pythonImportProbe `
  -PythonSourceDirectory (Join-Path $root 'python\src') `
  -TorchLibDirectory (Join-Path $sitePackages 'torch\lib')
Write-Host $importText.Trim()
if ($importText -notmatch 'pack-runtime-ok') {
  throw '预检失败：开发机 venv import 探测未通过。'
}

$torchVersion = ($importText -split '\r?\n' | Where-Object { $_ -match '^\d' } | Select-Object -First 1)
if ($torchVersion -notmatch 'cu12') {
  throw "预检失败：venv 里的 torch 不是 CUDA 包：$torchVersion"
}
Write-Host "开发机 venv 完整，torch=$torchVersion。"
