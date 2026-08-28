import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createYtdlpUpdateManager, startLocalApi } from '@koubox/core'
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
let quitCleanupStarted = false

/** 便携包：用户数据与 Cookie 放在 exe 旁 userdata，不共用开发机 AppData。 */
function usePortableUserData(): void {
  if (!app.isPackaged) return
  const portable = join(dirname(process.execPath), 'userdata')
  mkdirSync(portable, { recursive: true })
  app.setPath('userData', portable)
}

usePortableUserData()

function findModelsDirectory(): string {
  return process.env.KOUBOX_MODELS_DIR
    ?? (app.isPackaged ? join(process.resourcesPath, 'models') : resolve(process.cwd(), '../../models'))
}

function findWindowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : resolve(process.cwd(), '../../png/口播匣icon.png')
}

function findVendorDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'vendor')
    : resolve(process.cwd(), '../../vendor')
}

function findProjectDirectory(): string {
  return app.isPackaged ? process.resourcesPath : resolve(process.cwd(), '../..')
}

function findPythonProjectDirectory(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python') : resolve(process.cwd(), '../../python')
}

function findBundledPythonExecutable(): string | undefined {
  return app.isPackaged ? join(process.resourcesPath, 'python', 'Scripts', 'python.exe') : undefined
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

function registerDebugShortcuts(): void {
  globalShortcut.unregisterAll()
  const open = () => {
    toggleDevTools()
  }
  globalShortcut.register('F12', open)
  globalShortcut.register('CommandOrControl+Shift+I', open)
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
  // Dev logs → repo/logs；打包便携包 logs → exe 旁 userdata/logs
  initLogger(app.isPackaged ? userData : projectDirectory, {
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
      translationModelDirectory: join(findModelsDirectory(), 'HYMT21.8B'),
      demucsModelDirectory: join(findModelsDirectory(), 'demucs'),
      ytdlpDirectory: join(findVendorDirectory(), 'yt-dlp'),
      ffmpegDirectory: join(findVendorDirectory(), 'ffmpeg', 'bin'),
      denoDirectory: join(findVendorDirectory(), 'deno'),
      translationTargetLanguage: 'zh-Hans',
      asrLanguage: 'auto',
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
      pythonExecutable: '',
      debugMode: false
    },
    projectDirectory,
    pythonProjectDirectory: findPythonProjectDirectory(),
    bundledPythonExecutable: findBundledPythonExecutable(),
    downloadTikTokPublic: (url, directory, fileStem, onLine) => downloadTikTokWithReference({
      url,
      directory,
      fileStem,
      onLine,
      pythonExecutable: findBundledPythonExecutable() ?? join(findPythonProjectDirectory(), '.venv', 'Scripts', 'python.exe'),
      pythonSourceDirectory: join(findPythonProjectDirectory(), 'src'),
      ffmpegDirectory: join(findVendorDirectory(), 'ffmpeg', 'bin')
    }),
    pinBundledPaths: app.isPackaged,
    resolveTikTokBrowserMedia,
    resolveFacebookAnonymousMedia: resolveFacebookAnonymousWithChromium,
    resolvePlatformAuthentication,
    resolveActiveYtdlp: ytdlpUpdates.resolveActive,
    checkYtdlpUpdate: ytdlpUpdates.check,
    installYtdlpUpdate: ytdlpUpdates.install,
    restoreBundledYtdlp: ytdlpUpdates.restore,
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

  registerDebugShortcuts()

  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  mainLog.info('主窗口已创建')
}

ipcMain.handle('devtools:toggle', () => toggleDevTools())

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
