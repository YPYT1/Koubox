const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')

const manifestPath = join(__dirname, '../../../scripts/pack/manifests/pack-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const VC_RUNTIME_DLLS = manifest.vcRuntimeDlls

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

/**
 * 开发机 vendor/{deno,ffmpeg,yt-dlp} 常是指向其他工程的软链/Junction。
 * electron-builder 会原样打进包，分发后必断；这里解引用成实体目录。
 * Windows 上对 Junction 只能 unlink/rmdir，不能 rmSync({recursive:true})，否则可能删掉源目录内容。
 */
function removeReparsePoint(path) {
  const stat = lstatSync(path)
  if (!stat.isSymbolicLink()) {
    throw new Error(`期望删除软链接/Junction，但路径不是重解析点：${path}`)
  }
  unlinkSync(path)
}

function materializePath(dest) {
  const stat = lstatSync(dest)
  if (!stat.isSymbolicLink()) return false
  const real = realpathSync(dest)
  removeReparsePoint(dest)
  cpSync(real, dest, { recursive: true, verbatimSymlinks: false })
  const next = lstatSync(dest)
  if (next.isSymbolicLink()) {
    throw new Error(`解引用后仍是软链接：${dest}（源 ${real}）`)
  }
  return true
}

function materializeVendorTree(vendorRoot) {
  if (!existsSync(vendorRoot)) {
    throw new Error(`打包后找不到 vendor：${vendorRoot}`)
  }
  const materialized = []
  for (const name of ['deno', 'ffmpeg', 'yt-dlp']) {
    const dest = join(vendorRoot, name)
    if (!existsSync(dest)) {
      throw new Error(`打包后缺少 vendor\\${name}：${dest}`)
    }
    if (materializePath(dest)) {
      materialized.push(name)
    }
  }
  // 防止目录内还有嵌套 Junction（例如 bin 子目录）
  for (const name of ['deno', 'ffmpeg', 'yt-dlp']) {
    const root = join(vendorRoot, name)
    const stack = [root]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = join(current, entry.name)
        let childStat
        try {
          childStat = lstatSync(child)
        } catch {
          continue
        }
        if (childStat.isSymbolicLink()) {
          materializePath(child)
          materialized.push(`${name}/…/${entry.name}`)
          if (lstatSync(child).isDirectory()) stack.push(child)
          continue
        }
        if (childStat.isDirectory()) stack.push(child)
      }
    }
  }
  for (const relative of ['deno\\deno.exe', 'ffmpeg\\bin\\ffmpeg.exe', 'yt-dlp\\yt-dlp.exe']) {
    const file = join(vendorRoot, relative)
    if (!existsSync(file)) {
      throw new Error(`vendor 解引用后仍缺少：${file}`)
    }
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`vendor 关键文件仍是软链接：${file}`)
    }
  }
  if (materialized.length > 0) {
    console.log(`[after-pack] 已将 vendor 软链接解引用为实体：${materialized.join(', ')}`)
  } else {
    console.log('[after-pack] vendor 已是实体目录，无需解引用')
  }
}

module.exports = async function afterPack(context) {
  const resources = join(context.appOutDir, 'resources')
  // Models are intentionally user-supplied. Keep the canonical directory in
  // every packaged build, but never copy development-machine model weights.
  mkdirSync(join(resources, 'models'), { recursive: true })

  materializeVendorTree(join(resources, 'vendor'))

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
  const ffmpegBin = join(resources, 'vendor', 'ffmpeg', 'bin')
  if (!existsSync(torchLib)) {
    throw new Error(`打包后找不到 torch\\lib：${torchLib}`)
  }
  // WinError 126 常见原因：目标机没有 VC++ Redistributable。把运行库放到 torch / python / ffmpeg 同目录。
  copyVcRuntime([torchLib, scripts, pythonHome, ffmpegBin])
}
