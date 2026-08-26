import { app, dialog, session, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOGIN_PARTITION } from './cookies'

/** Electron / Chromium cache dirs under userData. Never delete these while Chromium is running. */
const USERDATA_CACHE_NAMES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'VideoDecodeStats',
  'blob_storage'
]

const PENDING_DISK_CLEAR_FLAG = 'koubox-pending-disk-clear'

export type AppDataRoots = {
  mode: 'development' | 'packaged'
  userData: string
  logs: string
}

export type ClearAppCacheResult = {
  cancelled: boolean
  cleared: string[]
  failed: Array<{ path: string; error: string }>
  roots: AppDataRoots
}

export function resolveAppDataRoots(projectDirectory: string): AppDataRoots {
  const userData = app.getPath('userData')
  const mode = app.isPackaged ? 'packaged' : 'development'
  const logs = app.isPackaged ? join(userData, 'logs') : join(projectDirectory, 'logs')
  return { mode, userData, logs }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function yieldMain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function todayLogDirName(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

async function removePathAsync(
  target: string,
  cleared: string[],
  failed: Array<{ path: string; error: string }>
): Promise<void> {
  if (!existsSync(target)) return
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
    cleared.push(target)
  } catch (error) {
    failed.push({ path: target, error: error instanceof Error ? error.message : String(error) })
  }
  await yieldMain()
}

/**
 * Must run before any BrowserWindow / session disk cache opens.
 * Fixes Chromium "entry_impl.cc No file for …" after a mid-run cache wipe.
 */
export async function purgeChromiumDiskCaches(userData: string): Promise<void> {
  for (const name of USERDATA_CACHE_NAMES) {
    const target = join(userData, name)
    if (!existsSync(target)) continue
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // Still locked from a previous crash; Chromium will recreate what it can.
    }
  }
}

export async function applyPendingDiskClear(projectDirectory: string): Promise<void> {
  const roots = resolveAppDataRoots(projectDirectory)
  const flagPath = join(roots.userData, PENDING_DISK_CLEAR_FLAG)
  await purgeChromiumDiskCaches(roots.userData)

  if (!existsSync(flagPath)) return

  try {
    if (existsSync(roots.logs)) {
      await rm(roots.logs, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
    }
    if (roots.mode === 'packaged') {
      const legacyLogs = join(projectDirectory, 'logs')
      if (legacyLogs !== roots.logs && existsSync(legacyLogs)) {
        await rm(legacyLogs, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
      }
    }
  } catch {
    // Log wipe is best-effort before logger opens.
  }

  try {
    unlinkSync(flagPath)
  } catch {
    // flag may be recreated next clear
  }
}

function markPendingDiskClear(userData: string): void {
  writeFileSync(join(userData, PENDING_DISK_CLEAR_FLAG), `${Date.now()}\n`, 'utf8')
}

async function clearOldLogDirs(
  logsRoot: string,
  cleared: string[],
  failed: Array<{ path: string; error: string }>
): Promise<void> {
  if (!existsSync(logsRoot)) return
  const today = todayLogDirName()
  let names: string[] = []
  try {
    names = readdirSync(logsRoot)
  } catch (error) {
    failed.push({ path: logsRoot, error: error instanceof Error ? error.message : String(error) })
    return
  }
  for (const name of names) {
    if (name === today) continue
    await removePathAsync(join(logsRoot, name), cleared, failed)
  }
}

export async function clearAppCache(options: {
  projectDirectory: string
  parentWindow?: BrowserWindow
  closeLoginWindow?: () => void
}): Promise<ClearAppCacheResult> {
  const roots = resolveAppDataRoots(options.projectDirectory)
  const modeLabel = roots.mode === 'packaged' ? '打包模式（userdata）' : '开发模式（项目目录）'
  const dialogOptions = {
    type: 'warning' as const,
    buttons: ['取消', '确认清理'],
    defaultId: 0,
    cancelId: 0,
    title: '清理缓存与登录数据',
    message: '确定清理缓存、登录状态与任务记录？',
    detail: [
      `当前：${modeLabel}`,
      `用户数据：${roots.userData}`,
      `日志目录：${roots.logs}`,
      '',
      '将清理：会话缓存、登录 Cookie / 平台登录配置、任务记录、旧日志。',
      '磁盘 Cache 会在下次启动时彻底清除（避免运行中删除导致卡死）。',
      '不会删除：模型、yt-dlp / FFmpeg、输出视频目录。'
    ].join('\n')
  }
  const choice = options.parentWindow && !options.parentWindow.isDestroyed()
    ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)
  if (choice.response !== 1) {
    return { cancelled: true, cleared: [], failed: [], roots }
  }

  await sleep(40)
  await yieldMain()

  const cleared: string[] = []
  const failed: Array<{ path: string; error: string }> = []

  options.closeLoginWindow?.()

  try {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearStorageData({
      storages: ['shadercache', 'cachestorage', 'serviceworkers']
    })
    cleared.push('session.defaultSession.clearCache()')
  } catch (error) {
    failed.push({
      path: 'session.defaultSession.clearCache()',
      error: error instanceof Error ? error.message : String(error)
    })
  }
  await yieldMain()

  try {
    const loginSession = session.fromPartition(LOGIN_PARTITION)
    await loginSession.clearStorageData()
    await loginSession.clearCache()
    cleared.push(LOGIN_PARTITION)
  } catch (error) {
    failed.push({
      path: LOGIN_PARTITION,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  await yieldMain()

  // Do NOT delete Cache/GPUCache while Chromium is running — that causes
  // entry_impl.cc "No file for …" and freezes the window.
  markPendingDiskClear(roots.userData)
  cleared.push(`pending-disk-clear → ${PENDING_DISK_CLEAR_FLAG}`)

  await clearOldLogDirs(roots.logs, cleared, failed)
  if (roots.mode === 'packaged') {
    const legacyLogs = join(options.projectDirectory, 'logs')
    if (legacyLogs !== roots.logs) await clearOldLogDirs(legacyLogs, cleared, failed)
  }

  const kouboxTempRoot = join(tmpdir(), 'koubox-temp')
  if (existsSync(kouboxTempRoot)) await removePathAsync(kouboxTempRoot, cleared, failed)

  try {
    mkdirSync(join(roots.logs, todayLogDirName()), { recursive: true })
  } catch {
    // Logger will recreate on next write if needed.
  }

  return { cancelled: false, cleared, failed, roots }
}
