import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  requestExit: () => ipcRenderer.invoke('app:request-exit'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  downloadFile: (url: string, filename?: string) =>
    ipcRenderer.invoke('files:download', { url, filename }),
})

export interface ElectronAPI {
  platform: string
  requestExit: () => Promise<boolean>
  pickFolder: () => Promise<string | null>
  downloadFile: (
    url: string,
    filename?: string,
  ) => Promise<{ ok?: boolean; canceled?: boolean; error?: string }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
