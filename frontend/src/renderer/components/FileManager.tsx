import { useEffect, useRef, useState } from 'react'
import {
  getDownloadOutputZipUrl,
  getDownloadTempZipUrl,
  getDownloadZipUrl,
  getDownloadUrl,
  listInputFiles,
  listOutputFiles,
  listTempFiles,
  uploadFile,
} from '../api/files'
import type { FileInfo } from '../api/files'

interface FileManagerProps {
  isOpen: boolean
  onClose: () => void
  sessionId: string | null
  projectId?: string | null
}

export default function FileManager({
  isOpen,
  onClose,
  sessionId,
  projectId,
}: FileManagerProps) {
  type Tab = 'input' | 'output' | 'temp'
  const [activeTab, setActiveTab] = useState<Tab>('input')
  const [filesByTab, setFilesByTab] = useState<Record<Tab, FileInfo[]>>({
    input: [],
    output: [],
    temp: [],
  })
  const [pathByTab, setPathByTab] = useState<Record<Tab, string | undefined>>({
    input: undefined,
    output: undefined,
    temp: undefined,
  })
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const currentPath = pathByTab[activeTab]

  useEffect(() => {
    // Enable folder picker on Chromium/Electron.
    const el = folderInputRef.current
    if (el) {
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      void loadFiles(activeTab, currentPath)
    }
  }, [isOpen, activeTab, currentPath, sessionId, projectId])

  useEffect(() => {
    if (!isOpen) return
    setPathByTab({
      input: undefined,
      output: undefined,
      temp: undefined,
    })
  }, [isOpen, sessionId, projectId])

  const loadFiles = async (tab: Tab, path?: string) => {
    if (!sessionId) return
    try {
      const params = { sessionId, projectId, path }
      let items: FileInfo[] = []
      if (tab === 'input') {
        items = await listInputFiles(params)
      } else if (tab === 'output') {
        items = await listOutputFiles(params)
      } else {
        items = await listTempFiles(params)
      }
      setFilesByTab((prev) => ({ ...prev, [tab]: items }))
    } catch (error) {
      console.error('Failed to load files:', error)
    }
  }

  const toSlashPath = (p: string) => p.replace(/\\/g, '/')

  const getParentPath = (p?: string): string | undefined => {
    if (!p) return undefined
    const parts = toSlashPath(p).split('/').filter(Boolean)
    if (parts.length <= 1) return undefined
    return parts.slice(0, -1).join('/')
  }

  const navigateTo = async (path?: string) => {
    setPathByTab((prev) => ({ ...prev, [activeTab]: path }))
    await loadFiles(activeTab, path)
  }

  const handleUploadBatch = async (fileList: FileList | null, preserveRelativePath: boolean) => {
    if (!fileList || !sessionId) return

    const files = Array.from(fileList)
    if (files.length === 0) return

    setUploading(true)
    let successCount = 0
    let failCount = 0
    let firstError = ''

    try {
      for (const file of files) {
        const rel = preserveRelativePath
          ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
          : file.name
        try {
          await uploadFile(file, { sessionId, projectId, relativePath: rel })
          successCount += 1
        } catch (error: any) {
          failCount += 1
          if (!firstError) {
            firstError = error?.response?.data?.detail || error?.message || 'Unknown error'
          }
        }
      }
      await loadFiles('input', pathByTab.input)
      if (failCount === 0) {
        alert(`Upload complete: ${successCount} item(s)`)
      } else {
        alert(
          `Upload complete: ${successCount} succeeded, ${failCount} failed.\nFirst error: ${firstError}`,
        )
      }
    } finally {
      setUploading(false)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleUploadBatch(e.target.files, false)
    e.target.value = ''
  }

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleUploadBatch(e.target.files, true)
    e.target.value = ''
  }

  const handleDownload = (file: FileInfo) => {
    if (!sessionId) return
    if (file.is_dir) {
      void navigateTo(file.path)
      return
    }
    const url = getDownloadUrl(file.path, { sessionId, projectId })
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadZip = (file: FileInfo) => {
    if (!sessionId || !file.is_dir) return
    const url = getDownloadZipUrl(file.path, { sessionId, projectId })
    const link = document.createElement('a')
    link.href = url
    link.download = `${file.name}.zip`
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadOutputZip = () => {
    if (!sessionId) return
    const url = getDownloadOutputZipUrl({ sessionId, projectId })
    const link = document.createElement('a')
    link.href = url
    link.download = 'output.zip'
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadTempZip = () => {
    if (!sessionId) return
    const url = getDownloadTempZipUrl({ sessionId, projectId })
    const link = document.createElement('a')
    link.href = url
    link.download = 'temp.zip'
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  if (!isOpen) return null

  const currentFiles = filesByTab[activeTab]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-xl font-semibold">File Manager</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            x
          </button>
        </div>

        <div className="flex border-b">
          <button
            onClick={() => setActiveTab('input')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'input'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600'
            }`}
          >
            Input ({filesByTab.input.length})
          </button>
          <button
            onClick={() => setActiveTab('output')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'output'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600'
            }`}
          >
            Output ({filesByTab.output.length})
          </button>
          <button
            onClick={() => setActiveTab('temp')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'temp'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600'
            }`}
          >
            Temp ({filesByTab.temp.length})
          </button>
        </div>

        {!sessionId && (
          <div className="border-b p-4 text-sm text-amber-700">
            No active session yet. Send a message first, then manage files.
          </div>
        )}

        {activeTab === 'input' && (
          <div className="border-b p-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              disabled={uploading || !sessionId}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              onChange={handleFolderSelect}
              className="hidden"
              disabled={uploading || !sessionId}
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
                disabled={uploading || !sessionId}
              >
                {uploading ? 'Uploading...' : 'Upload Files'}
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="rounded-lg border border-blue-600 px-4 py-2 text-blue-700 hover:bg-blue-50"
                disabled={uploading || !sessionId}
              >
                Upload Folder
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-b bg-gray-50 px-4 py-2 text-sm">
          <button
            onClick={() => void navigateTo(getParentPath(currentPath))}
            className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-100 disabled:opacity-40"
            disabled={!currentPath}
          >
            Up
          </button>
          <button
            onClick={() => void navigateTo(undefined)}
            className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-100"
          >
            Root
          </button>
          <div className="truncate text-gray-600">
            Path: {currentPath ? toSlashPath(currentPath) : 'Root'}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleDownloadOutputZip}
              className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-40"
              disabled={!sessionId}
            >
              Download Output ZIP
            </button>
            <button
              onClick={handleDownloadTempZip}
              className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-40"
              disabled={!sessionId}
            >
              Download Temp ZIP
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {currentFiles.length === 0 ? (
            <div className="py-8 text-center text-gray-500">
              {activeTab === 'input'
                ? 'No input items'
                : activeTab === 'output'
                ? 'No output items'
                : 'No temp items'}
            </div>
          ) : (
            <div className="space-y-2">
              {currentFiles.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center justify-between rounded-lg border p-3 hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {file.is_dir ? '[DIR] ' : '[FILE] '}
                      {file.name}
                    </div>
                    <div className="text-sm text-gray-500">
                      {file.is_dir ? 'Folder' : formatFileSize(file.size)}
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <button
                      onClick={() => handleDownload(file)}
                      className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100"
                      disabled={!sessionId}
                    >
                      {file.is_dir ? 'Open' : 'Download'}
                    </button>
                    {file.is_dir && (
                      <button
                        onClick={() => handleDownloadZip(file)}
                        className="rounded border border-blue-300 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50"
                        disabled={!sessionId}
                      >
                        Download ZIP
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
