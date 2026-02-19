import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  requestExit: () => ipcRenderer.invoke('app:request-exit'),
})

export interface ElectronAPI {
  platform: string
  requestExit: () => Promise<boolean>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
