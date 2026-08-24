import { contextBridge, ipcRenderer } from 'electron'
import type { YtdlpCookieStatus } from '@koubox/shared'

contextBridge.exposeInMainWorld('loginHub', {
  getStatus: (): Promise<YtdlpCookieStatus> => ipcRenderer.invoke('login:cookie-status')
})
