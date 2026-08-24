const { cpSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

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
  cpSync(home, join(resources, 'python-home'), { recursive: true })
}
