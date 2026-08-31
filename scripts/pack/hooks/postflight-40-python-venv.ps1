$packedPython = Join-Path $resources 'python\Scripts\python.exe'
$sitePackages = Join-Path $resources 'python\Lib\site-packages'
$packedPythonSource = Join-Path $resources 'python\src'
Assert-PackPath $packedPython '包内 Python'

foreach ($package in @($manifest.pythonSitePackages)) {
  Assert-PackSitePackage -SitePackagesRoot $sitePackages -PackageName $package -Label "包内 site-packages\$package"
}

Remove-PackPythonCaches $packedPythonSource
$pythonCaches = @(Get-ChildItem -LiteralPath $packedPythonSource -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
if ($pythonCaches.Count -gt 0) {
  throw ("校验失败：包内 Python 源码含 __pycache__：`n" + ($pythonCaches.FullName -join "`n"))
}

$importText = Invoke-PackPythonImportProbe `
  -PythonExecutable $packedPython `
  -Probe $manifest.pythonImportProbe `
  -PythonSourceDirectory $packedPythonSource `
  -TorchLibDirectory (Join-Path $sitePackages 'torch\lib')
Write-Host $importText.Trim()
if ($importText -notmatch 'pack-runtime-ok') {
  throw '校验失败：包内 Python venv import 探测未通过。'
}

$postImportCaches = @(Get-ChildItem -LiteralPath $packedPythonSource -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue)
if ($postImportCaches.Count -gt 0) {
  throw '校验失败：包内 import 后重新生成了 __pycache__。'
}
Write-Host '包内 Python venv 完整且 import 探测通过。'
