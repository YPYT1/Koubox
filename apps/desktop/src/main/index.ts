import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { join, resolve } from 'node:path'
import { startLocalApi } from '@koubox/core'

let mainWindow: BrowserWindow | undefined
let localApi: Awaited<ReturnType<typeof startLocalApi>> | undefined

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

async function createWindow(): Promise<void> {
  localApi = await startLocalApi({
    configFile: join(app.getPath('userData'), 'runtime.json'),
    defaults: {
      modelsDirectory: findModelsDirectory(),
      outputDirectory: join(app.getPath('documents'), '口播匣输出')
    },
    vendorDirectory: findVendorDirectory(),
    projectDirectory: findProjectDirectory(),
    pythonProjectDirectory: findPythonProjectDirectory(),
    bundledPythonExecutable: findBundledPythonExecutable(),
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
    }
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

  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { void localApi?.close() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
