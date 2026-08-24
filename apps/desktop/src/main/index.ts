import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startLocalApi } from '@koubox/core'
import { initLogger, createLogger } from '@koubox/shared/logger'
import { buildLoginCookieStatus, exportLoginCookies, applyLoginSessionProxy, readLoginCookies, cookiesToNetscape } from './cookies'

let mainWindow: BrowserWindow | undefined
let loginWindow: BrowserWindow | undefined
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined
let exportedCookiesFile = ''

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

function resolveLoginHtmlPath(): string {
  const candidates = [
    join(__dirname, 'login-window.html'),
    join(__dirname, '../../src/main/login-window.html'),
    join(app.getAppPath(), 'src/main/login-window.html')
  ]
  const found = candidates.find((item) => existsSync(item))
  if (!found) throw new Error('找不到登录窗口页面文件。')
  return found
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

async function syncExportedCookies(): Promise<void> {
  const config = localApi?.getConfig()
  if (!config || config.ytdlpCookieSource !== 'builtin' || !exportedCookiesFile) return
  const cookies = await readLoginCookies()
  if (cookies.length === 0) return
  writeFileSync(exportedCookiesFile, cookiesToNetscape(cookies), 'utf8')
}

async function openLoginWindow(): Promise<void> {
  if (loginWindow && !loginWindow.isDestroyed()) {
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
    title: '登录视频平台',
    icon: findWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:koubox-ytdlp-login',
      preload: join(__dirname, '../preload/login-preload.cjs'),
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
  await loginWindow.loadFile(resolveLoginHtmlPath())
  loginWindow.on('closed', () => {
    loginWindow = undefined
  })
}

ipcMain.handle('login:cookie-status', () => buildLoginCookieStatus(exportedCookiesFile))

async function createWindow(): Promise<void> {
  const projectDirectory = findProjectDirectory()
  initLogger(projectDirectory)
  const mainLog = createLogger('main')
  mainLog.info('应用启动', { projectDirectory })

  const userData = app.getPath('userData')
  exportedCookiesFile = join(userData, 'ytdlp-cookies.txt')

  localApi = await startLocalApi({
    configFile: join(userData, 'runtime.json'),
    defaults: {
      modelsDirectory: findModelsDirectory(),
      outputDirectory: join(app.getPath('documents'), '口播匣输出'),
      asrModelDirectory: join(findModelsDirectory(), 'whisperlargev3turbo'),
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
    exportedCookiesFile,
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
    exportLoginCookies: () => exportLoginCookies(exportedCookiesFile),
    getLoginCookieStatus: () => buildLoginCookieStatus(exportedCookiesFile)
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

  await syncExportedCookies()

  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('devtools:toggle', () => toggleDevTools())

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  void syncExportedCookies()
  void localApi?.close()
})
app.on('will-quit', () => { globalShortcut.unregisterAll() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
