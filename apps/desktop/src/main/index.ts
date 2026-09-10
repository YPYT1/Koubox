import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createYtdlpUpdateManager, startLocalApi } from '@koubox/core'
import {
  assertCredentials,
  HttpLicenseTransport,
  LicenseController,
  SecureFileLicenseStore,
  type LicenseCredentials,
  type LicenseDevScenario,
  type LicenseSnapshot
} from '@koubox/license-client'
import { defaultPlatformAuth, PLATFORM_HOMEPAGES, type YtdlpCookiePlatformId } from '@koubox/shared'
import { closeLogger, initLogger, createLogger } from '@koubox/shared/logger'
import { buildLoginCookieStatus, applyLoginSessionProxy, resolvePlatformAuthentication } from './cookies'
import { resolveFacebookAnonymousWithChromium } from './facebook-browser'
import { clearAppCache, resolveAppDataRoots, applyPendingDiskClear } from './clear-cache'
import { resolveTikTokBrowserMedia } from './tiktok-browser'
import { downloadTikTokWithReference } from './tiktok-reference'

let mainWindow: BrowserWindow | undefined
let loginWindow: BrowserWindow | undefined
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined
let licenseController: LicenseController | undefined
let quitCleanupStarted = false

const REMOTE_LICENSE_API_URL = 'https://koubox-license.ypyt147.workers.dev'

const DEVELOPMENT_LICENSE = {
  apiUrl: REMOTE_LICENSE_API_URL,
  token: 'KB-TKN-RV7D-KBNT-5RBQ',
  apiKey: 'KB-KEY-8WBT-97BB-KN4U-NXD3-RPVS',
  packageCredentialVersion: 2
}

type LicensePackageConfig = LicenseCredentials & {
  apiUrl: string
  packageCredentialVersion: number
}

function assertRemoteLicenseApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`授权服务地址无效：${apiUrl}`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`授权服务必须使用 HTTPS 远端地址，当前为：${trimmed}`)
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    throw new Error(`授权服务禁止使用本地地址，当前为：${trimmed}`)
  }
  return trimmed.replace(/\/$/, '')
}

function readLicensePackageConfig(): LicensePackageConfig {
  if (!app.isPackaged) {
    return {
      apiUrl: assertRemoteLicenseApiUrl(process.env.KOUBOX_LICENSE_API_URL?.trim() || DEVELOPMENT_LICENSE.apiUrl),
      token: process.env.KOUBOX_LICENSE_TOKEN?.trim() || DEVELOPMENT_LICENSE.token,
      apiKey: process.env.KOUBOX_LICENSE_API_KEY?.trim() || DEVELOPMENT_LICENSE.apiKey,
      packageCredentialVersion: Number(process.env.KOUBOX_LICENSE_CREDENTIAL_VERSION || DEVELOPMENT_LICENSE.packageCredentialVersion)
    }
  }
  const filePath = join(process.resourcesPath, 'license', 'license-package.json')
  if (!existsSync(filePath)) throw new Error(`安装包缺少授权配置：${filePath}`)
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  const credentials = assertCredentials(value)
  const apiUrl = typeof value.apiUrl === 'string' ? assertRemoteLicenseApiUrl(value.apiUrl) : ''
  const packageCredentialVersion = Number(value.packageCredentialVersion)
  if (!apiUrl || !Number.isInteger(packageCredentialVersion) || packageCredentialVersion < 1) {
    throw new Error('安装包授权配置无效。')
  }
  return { ...credentials, apiUrl, packageCredentialVersion }
}

function licenseStatus(): LicenseSnapshot {
  if (!licenseController) throw new Error('授权模块尚未初始化。')
  return licenseController.getSnapshot()
}

function sendLicenseStatus(snapshot = licenseStatus()): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license:status', snapshot)
}

function requestLicenseEditor(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license:open-editor')
}

/** 便携包：用户数据与 Cookie 放在 exe 旁 userdata，不共用开发机 AppData。 */
function usePortableUserData(): void {
  if (!app.isPackaged) return
  const portable = join(dirname(process.execPath), 'userdata')
  mkdirSync(portable, { recursive: true })
  app.setPath('userData', portable)
}

usePortableUserData()

// 开发模式只复用主分支的运行环境；模型、vendor、Python venv 不从当前副本寻找。
const MAIN_BRANCH_ROOT = 'D:\\Project\\Koubox'

function findModelsDirectory(): string {
  const directory = app.isPackaged ? join(process.resourcesPath, 'models') : join(MAIN_BRANCH_ROOT, 'models')
  if (!existsSync(directory)) throw new Error(`运行环境缺少模型目录：${directory}`)
  return directory
}

function findWindowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : resolve(process.cwd(), '../../png/口播匣icon.png')
}

function findVendorDirectory(): string {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'vendor')
    : join(MAIN_BRANCH_ROOT, 'vendor')
  if (!existsSync(directory)) throw new Error(`运行环境缺少 vendor 目录：${directory}`)
  return directory
}

function findProjectDirectory(): string {
  return app.isPackaged ? process.resourcesPath : resolve(process.cwd(), '../..')
}

function findPythonProjectDirectory(): string {
  const directory = app.isPackaged ? join(process.resourcesPath, 'python') : join(MAIN_BRANCH_ROOT, 'python')
  if (!existsSync(directory)) throw new Error(`运行环境缺少 Python 项目：${directory}`)
  return directory
}

function findBundledPythonExecutable(): string | undefined {
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'python', 'Scripts', 'python.exe')
    : join(MAIN_BRANCH_ROOT, 'python', '.venv', 'Scripts', 'python.exe')
  if (!existsSync(executable)) throw new Error(`运行环境缺少 Python：${executable}`)
  return executable
}

function patchBundledPythonHome(): void {
  if (!app.isPackaged) return
  const cfgPath = join(process.resourcesPath, 'python', 'pyvenv.cfg')
  const home = join(process.resourcesPath, 'python-home')
  const homePython = join(home, 'python.exe')
  if (!existsSync(cfgPath)) throw new Error(`打包环境缺少 Python 配置：${cfgPath}`)
  if (!existsSync(homePython)) {
    throw new Error(
      `打包环境缺少 Python 运行时：${homePython}。若你是把安装目录从其他盘复制/移动到当前位置，请重新完整复制整个 Koubox 文件夹（确保 resources\\python-home 内有数千个文件），或重新解压发布包。`
    )
  }
  const cfg = readFileSync(cfgPath, 'utf8')
  const next = cfg.replace(/^home\s*=\s*.+$/m, `home = ${home}`)
  if (next !== cfg) writeFileSync(cfgPath, next, 'utf8')
}

function isDebugModeEnabled(): boolean {
  return Boolean(localApi?.getConfig().debugMode)
}

function toggleDevTools(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (!isDebugModeEnabled()) {
    if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools()
    return false
  }
  if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools()
  else mainWindow.webContents.openDevTools({ mode: 'detach' })
  return true
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll()
  const open = () => {
    toggleDevTools()
  }
  globalShortcut.register('F12', open)
  globalShortcut.register('CommandOrControl+Shift+I', open)
  globalShortcut.register('CommandOrControl+Shift+Alt+L', requestLicenseEditor)
}

async function openLoginWindow(platformId: YtdlpCookiePlatformId): Promise<void> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.setTitle(`登录 ${platformId}`)
    await loginWindow.loadURL(PLATFORM_HOMEPAGES[platformId])
    loginWindow.focus()
    return
  }
  const proxy = localApi?.getConfig().ytdlpProxy ?? ''
  await applyLoginSessionProxy(proxy)

  loginWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: `登录 ${platformId}`,
    icon: findWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:koubox-ytdlp-login',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  loginWindow.setMenuBarVisibility(false)
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      width: 1100,
      height: 780,
      parent: loginWindow,
      title: '登录',
      icon: findWindowIcon(),
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:koubox-ytdlp-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    child.setMenuBarVisibility(false)
    void child.loadURL(url)
    return { action: 'deny' }
  })
  await loginWindow.loadURL(PLATFORM_HOMEPAGES[platformId])
  loginWindow.on('closed', () => {
    loginWindow = undefined
  })
}

async function createWindow(): Promise<void> {
  const projectDirectory = findProjectDirectory()
  const userData = app.getPath('userData')
  // Wipe disk caches before any BrowserWindow opens — avoids Chromium
  // entry_impl.cc "No file for …" freezes after a mid-run cache clear.
  await applyPendingDiskClear(projectDirectory)
  // 所有运行数据统一归档到 Electron userData；开发/构建只改变 userData 根路径。
  initLogger(userData, {
    defaultLevel: app.isPackaged ? 'info' : 'debug',
    defaultVerbose: !app.isPackaged
  })
  const mainLog = createLogger('main')
  mainLog.info('========== 应用启动 ==========')
  mainLog.info('环境信息', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version
  })
  mainLog.info('路径配置', {
    projectDirectory,
    userData,
    documents: app.getPath('documents'),
    logs: app.getPath('logs')
  })
  patchBundledPythonHome()

  const licensePackage = readLicensePackageConfig()
  licenseController = new LicenseController({
    store: new SecureFileLicenseStore(join(userData, 'license', 'state.json'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
    }),
    transport: new HttpLicenseTransport(licensePackage.apiUrl),
    packageCredentials: licensePackage,
    packageCredentialVersion: licensePackage.packageCredentialVersion,
    devMode: !app.isPackaged || process.env.KOUBOX_LICENSE_DEV_MODE === '1',
    onLocked: () => {
      localApi?.cancelActiveTasks('授权宽限已结束，任务已取消。')
      sendLicenseStatus()
    }
  })
  const initialLicense = await licenseController.initialize()
  licenseController.subscribe((snapshot) => {
    mainLog.info('授权状态已更新', {
      phase: snapshot.phase,
      allowed: snapshot.allowed,
      invalidCode: snapshot.invalidCode,
      graceEndsAt: snapshot.graceEndsAt
    })
    sendLicenseStatus(snapshot)
  })

  const bundledYtdlp = join(findVendorDirectory(), 'yt-dlp', 'yt-dlp.exe')
  const denoExecutable = join(findVendorDirectory(), 'deno', 'deno.exe')
  const ytdlpUpdates = createYtdlpUpdateManager({
    bundledExecutable: bundledYtdlp,
    denoExecutable,
    updateDirectory: join(userData, 'vendor-updates', 'yt-dlp')
  })

  localApi = await startLocalApi({
    configFile: join(userData, 'runtime.json'),
    defaults: {
      modelsDirectory: findModelsDirectory(),
      outputDirectory: join(app.getPath('documents'), '口播匣输出'),
      asrModelDirectory: join(findModelsDirectory(), 'faster-whisper-large-v3'),
      asrLightModelDirectory: join(findModelsDirectory(), 'faster-whisper-large-v3-turbo-int8-ct2'),
      defaultAsrModel: 'faster-whisper-large-v3-turbo',
      translationModelDirectory: join(findModelsDirectory(), 'nllb-200-distilled-600M-multilang-ft-ct2'),
      demucsModelDirectory: join(findModelsDirectory(), 'demucs'),
      ytdlpDirectory: join(findVendorDirectory(), 'yt-dlp'),
      ffmpegDirectory: join(findVendorDirectory(), 'ffmpeg', 'bin'),
      denoDirectory: join(findVendorDirectory(), 'deno'),
      translationTargetLanguage: 'zh-Hans',
      asrLanguage: 'ja',
      openOutputOnComplete: false,
      ytdlpProxy: '',
      ytdlpPlatformAuth: defaultPlatformAuth(),
      ytdlpMaxHeight: 0,
      ytdlpExtraArgs: '',
      maxConcurrentTasks: 1,
      translationTemperature: 0.7,
      translationMaxNewTokens: 4096,
      translationTopP: 0.8,
      whisperChunkLengthS: 30,
      pythonExecutable: findBundledPythonExecutable()!,
      debugMode: false,
      lanEnabled: true,
      lanAlias: '口播匣',
      lanPort: 53318,
      lanAutoSave: false,
      lanSaveDirectory: join(app.getPath('documents'), '口播匣分享'),
      lanHistoryEnabled: true
    },
    projectDirectory,
    pythonProjectDirectory: findPythonProjectDirectory(),
    bundledPythonExecutable: findBundledPythonExecutable(),
    downloadTikTokPublic: (url, directory, fileStem, onLine) => downloadTikTokWithReference({
      url,
      directory,
      fileStem,
      onLine,
      pythonExecutable: findBundledPythonExecutable()!,
      pythonSourceDirectory: join(findPythonProjectDirectory(), 'src'),
      ffmpegDirectory: join(findVendorDirectory(), 'ffmpeg', 'bin')
    }),
    pinBundledPaths: true,
    resolveTikTokBrowserMedia,
    resolveFacebookAnonymousMedia: resolveFacebookAnonymousWithChromium,
    resolvePlatformAuthentication,
    resolveActiveYtdlp: ytdlpUpdates.resolveActive,
    checkYtdlpUpdate: ytdlpUpdates.check,
    installYtdlpUpdate: ytdlpUpdates.install,
    restoreBundledYtdlp: ytdlpUpdates.restore,
    assertLicenseAllowed: () => licenseController?.assertAllowed(),
    getAppDataRoots: async () => resolveAppDataRoots(projectDirectory),
    clearAppCache: async () => clearAppCache({
      projectDirectory,
      parentWindow: mainWindow,
      closeLoginWindow: () => {
        if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
      }
    }),
    selectDirectory: async (title, defaultPath) => {
      const dialogOptions: OpenDialogOptions = {
        title,
        defaultPath,
        properties: ['openDirectory', 'createDirectory']
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? undefined : result.filePaths[0]
    },
    selectAudioFile: async (title, defaultPath) => {
      const dialogOptions: OpenDialogOptions = {
        title,
        defaultPath,
        properties: ['openFile'],
        filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'] }]
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? undefined : result.filePaths[0]
    },
    selectFile: async (title, defaultPath, filters) => {
      const dialogOptions: OpenDialogOptions = {
        title,
        defaultPath,
        properties: ['openFile'],
        filters: filters?.length
          ? filters
          : [{ name: '所有文件', extensions: ['*'] }]
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? undefined : result.filePaths[0]
    },
    openPath: async (targetPath) => {
      const error = await shell.openPath(targetPath)
      if (error) throw new Error(error)
    },
    openLoginWindow,
    getLoginCookieStatus: (platformAuth, proxy, platformId) => buildLoginCookieStatus(platformAuth, proxy, platformId)
  })

  if (!initialLicense.allowed) localApi.cancelActiveTasks('授权宽限已结束，任务已取消。')

  mainLog.info('本地 API 已启动', { baseUrl: localApi.baseUrl })
  const initialConfig = localApi.getConfig()
  mainLog.debug('初始配置已加载', {
    modelsDirectory: initialConfig.modelsDirectory,
    asrModelDirectory: initialConfig.asrModelDirectory,
    translationModelDirectory: initialConfig.translationModelDirectory,
    demucsModelDirectory: initialConfig.demucsModelDirectory,
    ytdlpDirectory: initialConfig.ytdlpDirectory,
    ffmpegDirectory: initialConfig.ffmpegDirectory,
    denoDirectory: initialConfig.denoDirectory,
    outputDirectory: initialConfig.outputDirectory,
    ytdlpProxyConfigured: Boolean(initialConfig.ytdlpProxy),
    platformAuth: Object.fromEntries(Object.entries(initialConfig.ytdlpPlatformAuth).map(([id, auth]) => [id, {
      mode: auth.mode,
      cookiesLength: auth.cookies.length,
      cookiesConfigured: Boolean(auth.cookies.trim())
    }])),
    debugMode: initialConfig.debugMode
  })

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: '口播匣',
    icon: findWindowIcon(),
    backgroundColor: '#f0f2f5',
    show: false,  // 先不显示，等内容加载后再显示
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--koubox-api=${localApi.baseUrl}`, `--koubox-token=${localApi.token}`]
    }
  })
  mainWindow.setMenuBarVisibility(false)

  // 内容加载完成后立即显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on('devtools-opened', () => {
    if (!isDebugModeEnabled()) mainWindow?.webContents.closeDevTools()
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const licenseShortcut = (input.control || input.meta) && input.shift && input.alt && input.key.toLowerCase() === 'l'
    if (licenseShortcut) {
      event.preventDefault()
      requestLicenseEditor()
      return
    }
    const editShortcut = input.control || input.meta
    if (editShortcut) {
      const key = input.key.toLowerCase()
      if (key === 'c') {
        event.preventDefault()
        mainWindow?.webContents.copy()
        return
      }
      if (key === 'x') {
        event.preventDefault()
        mainWindow?.webContents.cut()
        return
      }
      if (key === 'v') {
        event.preventDefault()
        mainWindow?.webContents.paste()
        return
      }
      if (key === 'a') {
        event.preventDefault()
        mainWindow?.webContents.selectAll()
        return
      }
    }
    const isF12 = input.key === 'F12' || input.code === 'F12'
    const isDevShortcut = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i' || input.code === 'KeyI')
    if (!isF12 && !isDevShortcut) return
    event.preventDefault()
    if (!isDebugModeEnabled()) {
      if (mainWindow?.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools()
      return
    }
    toggleDevTools()
  })

  registerShortcuts()

  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  sendLicenseStatus(initialLicense)

  mainLog.info('主窗口已创建')
}

ipcMain.handle('devtools:toggle', () => toggleDevTools())
ipcMain.handle('license:get-status', () => licenseStatus())
ipcMain.handle('license:verify', async () => {
  if (!licenseController) throw new Error('授权模块尚未初始化。')
  return licenseController.verifyNow()
})
ipcMain.handle('license:replace', async (_event, value: unknown) => {
  if (!licenseController) throw new Error('授权模块尚未初始化。')
  return licenseController.replaceCredentials(assertCredentials(value))
})
ipcMain.handle('license:simulate', async (_event, scenario: LicenseDevScenario) => {
  if (!licenseController) throw new Error('授权模块尚未初始化。')
  const allowed = new Set<LicenseDevScenario>([
    'valid', 'network-error', 'grace-expired', 'PAIR_MISMATCH', 'TOKEN_NOT_FOUND', 'API_KEY_NOT_FOUND',
    'TOKEN_DISABLED', 'API_KEY_DISABLED', 'TOKEN_REVOKED', 'API_KEY_REVOKED', 'TOKEN_EXPIRED', 'API_KEY_EXPIRED'
  ])
  if (!allowed.has(scenario)) throw new Error('未知的授权开发场景。')
  return licenseController.simulate(scenario)
})
ipcMain.handle('license:reset', async () => {
  if (!licenseController) throw new Error('授权模块尚未初始化。')
  return licenseController.resetToPackage()
})

// 前端日志记录
ipcMain.handle('log:error', (_event, message: string, detail?: unknown) => {
  const frontendLog = createLogger('frontend')
  frontendLog.error(message, detail)
})

ipcMain.handle('log:debug', (_event, message: string, detail?: unknown) => {
  const frontendLog = createLogger('frontend')
  frontendLog.debug(message, detail)
})

ipcMain.handle('log:warn', (_event, message: string, detail?: unknown) => {
  const frontendLog = createLogger('frontend')
  frontendLog.warn(message, detail)
})

ipcMain.handle('log:info', (_event, message: string, detail?: unknown) => {
  const frontendLog = createLogger('frontend')
  frontendLog.info(message, detail)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  licenseController?.dispose()
  void localApi?.close().catch(() => undefined)
})
app.on('will-quit', (event) => {
  globalShortcut.unregisterAll()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  event.preventDefault()
  createLogger('main').info('========== 应用退出 ==========')
  void closeLogger().finally(() => app.quit())
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
