import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpmRoot = join(repoRoot, 'node_modules', '.pnpm')
const candidates = existsSync(pnpmRoot)
  ? readdirSync(pnpmRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^playwright-core@/i.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((entry) => join(pnpmRoot, entry.name, 'node_modules', 'playwright-core', '.local-browsers'))
  : []

const source = candidates.find((candidate) => existsSync(candidate))
  ?? join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers')
const destination = join(repoRoot, '.pack', 'playwright-browsers')

if (!existsSync(source)) throw new Error(`找不到 Playwright 浏览器目录：${source}`)

rmSync(destination, { recursive: true, force: true })
cpSync(source, destination, { recursive: true, verbatimSymlinks: false })

const chromiumExecutable = readdirSync(destination, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^chromium-/i.test(entry.name))
  .map((entry) => join(destination, entry.name, 'chrome-win64', 'chrome.exe'))
  .find((candidate) => existsSync(candidate))

if (!chromiumExecutable) throw new Error(`Playwright 浏览器已复制，但没有找到 Chromium：${destination}`)
console.log(`Playwright 浏览器已准备：${chromiumExecutable}`)
