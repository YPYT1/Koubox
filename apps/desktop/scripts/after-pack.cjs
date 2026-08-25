const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')

const VC_RUNTIME_DLLS = [
  'MSVCP140.dll',
  'MSVCP140_1.dll',
  'MSVCP140_2.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
  'CONCRT140.dll'
]

function copyOneVcDll(src, dest) {
  if (existsSync(dest)) {
    try {
      unlinkSync(dest)
    } catch {
      // 刚从 python-home 递归拷贝出来的 DLL 可能被杀软/索引短暂占用；已有文件可直接沿用。
      return
    }
  }
  try {
    cpSync(src, dest)
  } catch (error) {
    if (existsSync(dest)) return
    throw error
  }
}

function copyVcRuntime(targets) {
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  for (const name of VC_RUNTIME_DLLS) {
    const src = join(system32, name)
    if (!existsSync(src)) {
      throw new Error(`打包需要 Visual C++ 运行库 ${name}，本机 System32 中找不到：${src}`)
    }
    for (const dir of targets) {
      mkdirSync(dir, { recursive: true })
      copyOneVcDll(src, join(dir, name))
    }
  }
}

/** uv 的 cpython-3.12-windows-*-none 常常是 Junction；必须解引用后再实体拷贝，否则压缩/移动会变成空目录。 */
function copyPythonHomeReal(sourceHome, destHome) {
  const realHome = realpathSync(sourceHome)
  if (existsSync(destHome)) {
    rmSync(destHome, { recursive: true, force: true })
  }
  cpSync(realHome, destHome, { recursive: true, verbatimSymlinks: false })
  const destStat = lstatSync(destHome)
  if (destStat.isSymbolicLink()) {
    throw new Error(`python-home 复制后仍是软链接（源 ${sourceHome} → ${realHome}）。便携包不能依赖开发机 uv 路径。`)
  }
  const homePython = join(destHome, 'python.exe')
  if (!existsSync(homePython)) {
    throw new Error(`复制 Python home 后仍找不到：${homePython}（源：${realHome}）`)
  }
}

module.exports = async function afterPack(context) {
  const resources = join(context.appOutDir, 'resources')
  const cfgPath = join(resources, 'python', 'pyvenv.cfg')
  if (!existsSync(cfgPath)) {
    throw new Error(`打包后找不到 Python 配置：${cfgPath}`)
  }
  const cfg = readFileSync(cfgPath, 'utf8')
  const match = cfg.match(/^home\s*=\s*(.+)$/m)
  if (!match) {
    throw new Error('pyvenv.cfg 没有 home，无法打包可迁移的 Python。')
  }
  const home = match[1].trim()
  if (!existsSync(home)) {
    throw new Error(`Python home 不存在：${home}`)
  }
  const pythonHome = join(resources, 'python-home')
  copyPythonHomeReal(home, pythonHome)

  // 写成当前 appOutDir 下的绝对路径（此时通常是 win-unpacked）。
  // pack-portable 改名为 Koubox-x.y.z 后会再改写；应用启动时 patchBundledPythonHome 也会改写。
  const nextCfg = cfg.replace(/^home\s*=\s*.+$/m, `home = ${pythonHome}`)
  writeFileSync(cfgPath, nextCfg, 'utf8')

  const torchLib = join(resources, 'python', 'Lib', 'site-packages', 'torch', 'lib')
  const scripts = join(resources, 'python', 'Scripts')
  if (!existsSync(torchLib)) {
    throw new Error(`打包后找不到 torch\\lib：${torchLib}`)
  }
  // WinError 126 常见原因：目标机没有 VC++ Redistributable。把运行库放到 c10.dll 同目录。
  copyVcRuntime([torchLib, scripts, pythonHome])
}
