import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { startLocalApi } from '@koubox/core'
import { PLATFORM_COOKIE_RULES, type YtdlpCookiePlatformId } from '@koubox/shared'
import { initLogger, createLogger } from '@koubox/shared/logger'
import {
  applyLoginSessionProxy,
  buildLoginCookieStatus,
  exportLoginCookies,
  loginPartition,
  migrateLegacyLoginCookies
} from './cookies'

let mainWindow: BrowserWindow | undefined
let loginWindow: BrowserWindow | undefined
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined
let cookieDirectory = ''

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

const PLATFORM_LOGIN_URLS: Record<YtdlpCookiePlatformId, string> = {
  youtube: 'https://www.youtube.com/',
  tiktok: 'https://www.tiktok.com/',
  instagram: 'https://www.instagram.com/accounts/edit/',
  facebook: 'https://www.facebook.com/'
}

async function openLoginWindow(platformId: YtdlpCookiePlatformId): Promise<void> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close()
  }
  const proxy = localApi?.getConfig().ytdlpProxy ?? ''
  await applyLoginSessionProxy(platformId, proxy)
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  const title = `${rule?.label ?? platformId} 应用内登录`
  const partition = loginPartition(platformId)

  const nextLoginWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title,
    icon: findWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  loginWindow = nextLoginWindow
  nextLoginWindow.setMenuBarVisibility(false)
  nextLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      width: 1100,
      height: 780,
      parent: nextLoginWindow,
      title: '登录',
      icon: findWindowIcon(),
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    child.setMenuBarVisibility(false)
    void child.loadURL(url)
    return { action: 'deny' }
  })
  await nextLoginWindow.loadURL(PLATFORM_LOGIN_URLS[platformId])
  nextLoginWindow.on('closed', () => {
    if (loginWindow === nextLoginWindow) loginWindow = undefined
  })
}

ipcMain.handle('login:cookie-status', () => {
  const config = localApi?.getConfig()
  return buildLoginCookieStatus(cookieDirectory, config?.ytdlpPlatformAuth, config?.ytdlpProxy)
})

async function createWindow(): Promise<void> {
  const projectDirectory = findProjectDirectory()
  initLogger(projectDirectory)
  const mainLog = createLogger('main')
  mainLog.info('应用启动', { projectDirectory })
  patchBundledPythonHome()

  const userData = app.getPath('userData')
  cookieDirectory = userData
  migrateLegacyLoginCookies(cookieDirectory)

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
      translationTargetLanguage: 'zh-Hans',
      asrLanguage: 'auto',
      openOutputOnComplete: false,
      ytdlpProxy: '',
      ytdlpCookieSource: 'builtin',
      ytdlpCookiesPath: '',
      ytdlpPlatformAuth: {
        youtube: { mode: 'builtin', cookies: '' },
        tiktok: { mode: 'builtin', cookies: '' },
        instagram: { mode: 'paste', cookies: '' },
        facebook: { mode: 'builtin', cookies: '' }
      },
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
    pinBundledPaths: app.isPackaged,
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
    exportLoginCookies: (platformId, platformAuth, proxy) => exportLoginCookies(cookieDirectory, platformId, platformAuth, proxy),
    getLoginCookieStatus: (platformAuth, proxy) => buildLoginCookieStatus(cookieDirectory, platformAuth, proxy)
  })

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: '口播匣',
    icon: findWindowIcon(),
    backgroundColor: '#f0f2f5',
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

  mainWindow.webContents.on('devtools-opened', () => {
    if (!isDebugModeEnabled()) mainWindow?.webContents.closeDevTools()
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
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
}

ipcMain.handle('devtools:toggle', () => toggleDevTools())

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  void localApi?.close()
})
app.on('will-quit', () => { globalShortcut.unregisterAll() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
