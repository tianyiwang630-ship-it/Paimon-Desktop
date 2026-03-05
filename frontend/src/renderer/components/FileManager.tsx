import { useEffect, useRef, useState } from 'react'
import {
  checkInputConflicts,
  deleteInputItem,
  getDownloadOutputZipUrl,
  getDownloadTempZipUrl,
  getDownloadZipUrl,
  getDownloadUrl,
  listInputFiles,
  listOutputFiles,
  listTempFiles,
  uploadFile,
  uploadFolderLocal,
} from '../api/files'
import type { ConflictStrategy, FileInfo, UploadConflictItem } from '../api/files'

interface FileManagerProps {
  isOpen: boolean
  onClose: () => void
  sessionId: string | null
  projectId?: string | null
}

type Tab = 'input' | 'output' | 'temp'

function toSlashPath(p: string) {
  return p.replace(/\\/g, '/')
}

function splitRelativePath(relativePath: string): string[] {
  return toSlashPath(relativePath).split('/').filter(Boolean)
}

function splitNameForSuffix(name: string) {
  const match = name.match(/^(.*?)(\.[^.]*)?$/)
  if (!match) {
    return { base: name, ext: '' }
  }
  return {
    base: match[1] || name,
    ext: match[2] || '',
  }
}

function nextAvailableName(name: string, usedNames: Set<string>) {
  const { base, ext } = splitNameForSuffix(name)
  let counter = 1
  while (true) {
    const candidate = `${base}_(${counter})${ext}`
    if (!usedNames.has(candidate)) {
      return candidate
    }
    counter += 1
  }
}

function buildConflictProbePaths(relativePaths: string[]) {
  const probes = new Set<string>()
  for (const relativePath of relativePaths) {
    const normalized = toSlashPath(relativePath).trim()
    if (!normalized) continue
    probes.add(normalized)
    const parts = splitRelativePath(normalized)
    if (parts.length > 1) {
      probes.add(parts[0])
    }
  }
  return Array.from(probes)
}

function buildRenameMap(relativePaths: string[], existingRootNames: Set<string>) {
  const usedNames = new Set(existingRootNames)
  const rootMap = new Map<string, string>()
  const renamedPaths = new Map<string, string>()

  for (const originalPath of relativePaths) {
    const parts = splitRelativePath(originalPath)
    if (parts.length === 0) continue

    const rootName = parts[0]
    let mappedRoot = rootMap.get(rootName)
    if (!mappedRoot) {
      mappedRoot = usedNames.has(rootName) ? nextAvailableName(rootName, usedNames) : rootName
      rootMap.set(rootName, mappedRoot)
      usedNames.add(mappedRoot)
    }

    renamedPaths.set(originalPath, [mappedRoot, ...parts.slice(1)].join('/'))
  }

  return renamedPaths
}

function sanitizeDirName(name: string, fallback = 'imported_folder') {
  const cleaned = (name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return fallback
  }
  return cleaned
}

function buildImportRootName(folderPath: string) {
  const trimmed = (folderPath || '').trim().replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] || ''
  if (last && !/^[A-Za-z]:$/.test(last)) {
    return sanitizeDirName(last)
  }

  const driveMatch = trimmed.match(/^([A-Za-z]):$/)
  if (driveMatch) {
    return sanitizeDirName(`${driveMatch[1]}_drive`)
  }

  const anchor = trimmed.replace(/[\\/]+/g, '_').replace(/:/g, '').trim()
  if (anchor) {
    return sanitizeDirName(anchor)
  }

  return 'imported_folder'
}

export default function FileManager({
  isOpen,
  onClose,
  sessionId,
  projectId,
}: FileManagerProps) {
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
  const [showCancelUploadDialog, setShowCancelUploadDialog] = useState(false)
  const [showConflictDialog, setShowConflictDialog] = useState(false)
  const [pendingConflictItems, setPendingConflictItems] = useState<UploadConflictItem[]>([])
  const [pendingDeleteItem, setPendingDeleteItem] = useState<FileInfo | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [uploadNotice, setUploadNotice] = useState<{ level: 'success' | 'warning'; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const cancelRequestedRef = useRef(false)
  const conflictResolverRef = useRef<((strategy: ConflictStrategy | null) => void) | null>(null)

  const currentPath = pathByTab[activeTab]

  useEffect(() => {
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
    setUploadNotice(null)
    setPathByTab({
      input: undefined,
      output: undefined,
      temp: undefined,
    })
  }, [isOpen, sessionId, projectId])

  useEffect(() => {
    if (isOpen) return
    setShowCancelUploadDialog(false)
    setShowConflictDialog(false)
    setPendingConflictItems([])
    conflictResolverRef.current = null
  }, [isOpen])

  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort()
      conflictResolverRef.current = null
    }
  }, [])

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

  const getParentPath = (p?: string): string | undefined => {
    if (!p) return undefined
    const parts = splitRelativePath(p)
    if (parts.length <= 1) return undefined
    return parts.slice(0, -1).join('/')
  }

  const navigateTo = async (path?: string) => {
    setPathByTab((prev) => ({ ...prev, [activeTab]: path }))
    await loadFiles(activeTab, path)
  }

  const isCanceledError = (error: any) => {
    const code = String(error?.code || '').toUpperCase()
    const name = String(error?.name || '').toUpperCase()
    return code === 'ERR_CANCELED' || name === 'CANCELEDERROR' || name === 'ABORTERROR'
  }

  const startUploadController = () => {
    const controller = new AbortController()
    uploadAbortRef.current = controller
    cancelRequestedRef.current = false
    return controller
  }

  const finishUploadController = () => {
    uploadAbortRef.current = null
    cancelRequestedRef.current = false
  }

  const handleCloseClick = () => {
    if (!uploading) {
      onClose()
      return
    }
    setShowCancelUploadDialog(true)
  }

  const handleCancelUploadDismiss = () => {
    setShowCancelUploadDialog(false)
  }

  const handleCancelUploadConfirm = () => {
    cancelRequestedRef.current = true
    uploadAbortRef.current?.abort()
    setUploadNotice({
      level: 'warning',
      text: 'Upload canceled by user.',
    })
    setShowCancelUploadDialog(false)
  }

  const requestDeleteInputItem = (file: FileInfo) => {
    if (activeTab !== 'input' || !sessionId) return
    setPendingDeleteItem(file)
  }

  const handleCancelDeleteInputItem = () => {
    if (deleteSubmitting) return
    setPendingDeleteItem(null)
  }

  const handleConfirmDeleteInputItem = async () => {
    if (!pendingDeleteItem || !sessionId || deleteSubmitting) return
    setDeleteSubmitting(true)
    try {
      await deleteInputItem({
        sessionId,
        projectId,
        path: pendingDeleteItem.path,
      })
      setUploadNotice({
        level: 'success',
        text: `Removed: ${pendingDeleteItem.name}`,
      })
      await loadFiles('input', pathByTab.input)
      setPendingDeleteItem(null)
    } catch (error: any) {
      setUploadNotice({
        level: 'warning',
        text: `Delete failed: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`,
      })
    } finally {
      setDeleteSubmitting(false)
    }
  }

  const promptConflictStrategy = (items: UploadConflictItem[]) =>
    new Promise<ConflictStrategy | null>((resolve) => {
      conflictResolverRef.current = resolve
      setPendingConflictItems(items)
      setShowConflictDialog(true)
    })

  const closeConflictDialog = (strategy: ConflictStrategy | null) => {
    const resolve = conflictResolverRef.current
    conflictResolverRef.current = null
    setShowConflictDialog(false)
    setPendingConflictItems([])
    if (resolve) {
      resolve(strategy)
    }
  }

  const getExistingRootNames = async () => {
    if (!sessionId) return new Set<string>()
    const rootItems = await listInputFiles({ sessionId, projectId })
    return new Set(rootItems.map((item) => item.name))
  }

  const maybeResolveConflictStrategy = async (relativePaths: string[]) => {
    if (!sessionId || relativePaths.length === 0) {
      return { strategy: null as ConflictStrategy | null, conflicts: [] as UploadConflictItem[] }
    }

    const conflictCheck = await checkInputConflicts({
      sessionId,
      projectId,
      relativePaths: buildConflictProbePaths(relativePaths),
    })

    if (!conflictCheck.has_conflicts) {
      return { strategy: null as ConflictStrategy | null, conflicts: [] as UploadConflictItem[] }
    }

    const strategy = await promptConflictStrategy(conflictCheck.conflicts)
    return {
      strategy,
      conflicts: conflictCheck.conflicts,
    }
  }

  const replaceConflictingTopLevelDirectories = async (
    conflicts: UploadConflictItem[],
    relativePaths: string[]
  ) => {
    if (!sessionId) return
    const topLevelNames = new Set(relativePaths.map((relativePath) => splitRelativePath(relativePath)[0]).filter(Boolean))
    for (const conflict of conflicts) {
      if (!conflict.is_dir || !topLevelNames.has(conflict.name)) {
        continue
      }
      await deleteInputItem({
        sessionId,
        projectId,
        path: conflict.path,
      })
    }
  }

  const runFileBatchUpload = async (
    files: File[],
    relativePaths: string[],
    strategy: ConflictStrategy | null,
    conflicts: UploadConflictItem[]
  ) => {
    if (!sessionId) return

    const controller = startUploadController()
    let successCount = 0
    let failCount = 0
    let firstError = ''
    let canceled = false
    let renameMap = new Map<string, string>()

    try {
      if (strategy === 'replace') {
        await replaceConflictingTopLevelDirectories(conflicts, relativePaths)
      } else if (strategy === 'rename') {
        renameMap = buildRenameMap(relativePaths, await getExistingRootNames())
      }

      for (let index = 0; index < files.length; index += 1) {
        if (controller.signal.aborted || cancelRequestedRef.current) {
          canceled = true
          break
        }

        const file = files[index]
        const originalRelativePath = relativePaths[index]
        const finalRelativePath = renameMap.get(originalRelativePath) || originalRelativePath

        try {
          await uploadFile(file, {
            sessionId,
            projectId,
            relativePath: finalRelativePath,
            signal: controller.signal,
            conflictStrategy: strategy || undefined,
          })
          successCount += 1
        } catch (error: any) {
          if (isCanceledError(error) || controller.signal.aborted || cancelRequestedRef.current) {
            canceled = true
            break
          }
          failCount += 1
          if (!firstError) {
            firstError = error?.response?.data?.detail || error?.message || 'Unknown error'
          }
        }
      }

      if (canceled) {
        setUploadNotice({
          level: 'warning',
          text: 'Upload canceled by user.',
        })
        return
      }

      await loadFiles('input', pathByTab.input)
      if (failCount === 0) {
        setUploadNotice({
          level: 'success',
          text: `Upload complete: ${successCount} item(s).`,
        })
      } else {
        setUploadNotice({
          level: 'warning',
          text: `Upload complete: ${successCount} succeeded, ${failCount} failed. First error: ${firstError}`,
        })
      }
    } finally {
      setUploading(false)
      finishUploadController()
    }
  }

  const handleUploadBatch = async (fileList: FileList | null, preserveRelativePath: boolean) => {
    if (!fileList || !sessionId) return

    const files = Array.from(fileList)
    if (files.length === 0) return

    const relativePaths = files.map((file) =>
      preserveRelativePath
        ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
        : file.name
    )

    setUploadNotice(null)
    try {
      const { strategy, conflicts } = await maybeResolveConflictStrategy(relativePaths)
      if (conflicts.length > 0 && !strategy) {
        setUploadNotice({
          level: 'warning',
          text: 'Upload canceled.',
        })
        return
      }

      setUploading(true)
      await runFileBatchUpload(files, relativePaths, strategy, conflicts)
    } catch (error: any) {
      setUploading(false)
      finishUploadController()
      setUploadNotice({
        level: 'warning',
        text: `Conflict check failed: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`,
      })
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleUploadBatch(e.target.files, false)
    e.target.value = ''
  }

  const importLocalFolder = async (folderPath: string) => {
    if (!sessionId) return

    setUploadNotice(null)
    try {
      const importRootName = buildImportRootName(folderPath)
      const { strategy, conflicts } = await maybeResolveConflictStrategy([importRootName])
      if (conflicts.length > 0 && !strategy) {
        setUploadNotice({
          level: 'warning',
          text: 'Upload canceled.',
        })
        return
      }

      setUploading(true)
      const controller = startUploadController()
      try {
        const result = await uploadFolderLocal({
          sessionId,
          projectId,
          folderPath,
          signal: controller.signal,
          conflictStrategy: strategy || undefined,
        })
        await loadFiles('input', pathByTab.input)
        if (result.failed_count === 0) {
          setUploadNotice({
            level: 'success',
            text: `Upload complete: ${result.imported_count} item(s) from folder "${result.root_name}".`,
          })
        } else {
          setUploadNotice({
            level: 'warning',
            text: `Upload complete: ${result.imported_count} succeeded, ${result.failed_count} failed. First error: ${result.first_error || 'Unknown error'}`,
          })
        }
      } catch (error: any) {
        if (isCanceledError(error) || controller.signal.aborted || cancelRequestedRef.current) {
          setUploadNotice({
            level: 'warning',
            text: 'Upload canceled by user.',
          })
        } else {
          setUploadNotice({
            level: 'warning',
            text: `Folder import failed: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`,
          })
        }
      } finally {
        setUploading(false)
        finishUploadController()
      }
    } catch (error: any) {
      setUploadNotice({
        level: 'warning',
        text: `Conflict check failed: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`,
      })
    }
  }

  const handleUploadFolderClick = async () => {
    const canUseNativeFolderPicker =
      typeof window !== 'undefined' &&
      Boolean(window.electronAPI) &&
      typeof window.electronAPI.pickFolder === 'function'

    if (canUseNativeFolderPicker && sessionId) {
      const folderPath = await window.electronAPI.pickFolder()
      if (!folderPath) return
      await importLocalFolder(folderPath)
      return
    }

    folderInputRef.current?.click()
  }

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(e.target.files || [])
    const firstRelativePath = ((pickedFiles[0] as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath || '').trim()
    const folderPickerDegraded =
      pickedFiles.length === 1 &&
      (!firstRelativePath || !firstRelativePath.includes('/'))

    const canUseNativeFolderPicker =
      typeof window !== 'undefined' &&
      Boolean(window.electronAPI) &&
      typeof window.electronAPI.pickFolder === 'function'

    if (folderPickerDegraded && canUseNativeFolderPicker && sessionId) {
      const folderPath = await window.electronAPI.pickFolder()
      if (!folderPath) {
        e.target.value = ''
        return
      }
      await importLocalFolder(folderPath)
      e.target.value = ''
      return
    }

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
    const downloadFile = window.electronAPI?.downloadFile
    if (typeof downloadFile === 'function') {
      void downloadFile(url, file.name)
      return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadZip = (file: FileInfo) => {
    if (!sessionId || !file.is_dir) return
    const url = getDownloadZipUrl(file.path, { sessionId, projectId })
    const downloadFile = window.electronAPI?.downloadFile
    if (typeof downloadFile === 'function') {
      void downloadFile(url, `${file.name}.zip`)
      return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = `${file.name}.zip`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadOutputZip = () => {
    if (!sessionId) return
    const url = getDownloadOutputZipUrl({ sessionId, projectId })
    const downloadFile = window.electronAPI?.downloadFile
    if (typeof downloadFile === 'function') {
      void downloadFile(url, 'output.zip')
      return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = 'output.zip'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownloadTempZip = () => {
    if (!sessionId) return
    const url = getDownloadTempZipUrl({ sessionId, projectId })
    const downloadFile = window.electronAPI?.downloadFile
    if (typeof downloadFile === 'function') {
      void downloadFile(url, 'temp.zip')
      return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = 'temp.zip'
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
  const visibleConflictItems = pendingConflictItems.slice(0, 5)
  const hasMoreConflicts = pendingConflictItems.length > visibleConflictItems.length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--app-overlay)]">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--app-border)] p-4">
          <h2 className="text-xl font-semibold">File Manager</h2>
          <button onClick={handleCloseClick} className="text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
            x
          </button>
        </div>

        <div className="flex border-b border-[var(--app-border)] bg-[var(--app-surface-muted)]">
          <button
            onClick={() => setActiveTab('input')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'input'
                ? 'border-b-2 border-[var(--app-accent)] text-[var(--app-accent)]'
                : 'text-[var(--app-text-muted)]'
            }`}
          >
            Input ({filesByTab.input.length})
          </button>
          <button
            onClick={() => setActiveTab('output')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'output'
                ? 'border-b-2 border-[var(--app-accent)] text-[var(--app-accent)]'
                : 'text-[var(--app-text-muted)]'
            }`}
          >
            Output ({filesByTab.output.length})
          </button>
          <button
            onClick={() => setActiveTab('temp')}
            className={`flex-1 px-4 py-2 ${
              activeTab === 'temp'
                ? 'border-b-2 border-[var(--app-accent)] text-[var(--app-accent)]'
                : 'text-[var(--app-text-muted)]'
            }`}
          >
            Temp ({filesByTab.temp.length})
          </button>
        </div>

        {!sessionId && (
          <div className="border-b border-[var(--app-border)] p-4 text-sm text-amber-700">
            No active session yet. Send a message first, then manage files.
          </div>
        )}

        {activeTab === 'input' && (
          <div className="border-b border-[var(--app-border)] p-4">
            {uploadNotice && (
              <div
                className={
                  uploadNotice.level === 'success'
                    ? 'mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800'
                    : 'mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                }
              >
                {uploadNotice.text}
              </div>
            )}
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
                className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-white hover:bg-[var(--app-accent-hover)]"
                disabled={uploading || !sessionId}
              >
                {uploading ? 'Uploading...' : 'Upload Files'}
              </button>
              <button
                onClick={() => void handleUploadFolderClick()}
                className="rounded-xl border border-[var(--app-accent)] px-4 py-2 text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
                disabled={uploading || !sessionId}
              >
                Upload Folder
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface-muted)] px-4 py-2 text-sm">
          <button
            onClick={() => void navigateTo(getParentPath(currentPath))}
            className="rounded border border-[var(--app-border)] px-2 py-1 hover:bg-[var(--app-surface-elevated)] disabled:opacity-40"
            disabled={!currentPath}
          >
            Up
          </button>
          <button
            onClick={() => void navigateTo(undefined)}
            className="rounded border border-[var(--app-border)] px-2 py-1 hover:bg-[var(--app-surface-elevated)]"
          >
            Root
          </button>
          <div className="truncate text-[var(--app-text-muted)]">
            Path: {currentPath ? toSlashPath(currentPath) : 'Root'}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleDownloadOutputZip}
              className="rounded border border-[var(--app-accent)] px-2 py-1 text-xs text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] disabled:opacity-40"
              disabled={!sessionId}
            >
              Download Output ZIP
            </button>
            <button
              onClick={handleDownloadTempZip}
              className="rounded border border-[var(--app-accent)] px-2 py-1 text-xs text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] disabled:opacity-40"
              disabled={!sessionId}
            >
              Download Temp ZIP
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {currentFiles.length === 0 ? (
            <div className="py-8 text-center text-[var(--app-text-muted)]">
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
                  className="relative flex items-center justify-between rounded-xl border border-[var(--app-border)] p-3 hover:bg-[var(--app-surface-muted)]"
                >
                  {activeTab === 'input' && (
                    <button
                      onClick={() => requestDeleteInputItem(file)}
                      className="absolute right-2 top-2 rounded px-1.5 text-xs text-[var(--app-text-muted)] hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!sessionId || uploading}
                      title={`Delete ${file.is_dir ? 'folder' : 'file'}`}
                    >
                      x
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {file.is_dir ? '[DIR] ' : '[FILE] '}
                      {file.name}
                    </div>
                    <div className="text-sm text-[var(--app-text-muted)]">
                      {file.is_dir ? 'Folder' : formatFileSize(file.size)}
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <button
                      onClick={() => handleDownload(file)}
                      className="rounded border border-[var(--app-border)] px-3 py-1 text-sm hover:bg-[var(--app-surface-muted)]"
                      disabled={!sessionId}
                    >
                      {file.is_dir ? 'Open' : 'Download'}
                    </button>
                    {file.is_dir && (
                      <button
                        onClick={() => handleDownloadZip(file)}
                        className="rounded border border-[var(--app-accent)] px-3 py-1 text-sm text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
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

      {showCancelUploadDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Cancel upload?</h3>
            <p className="mt-3 text-sm text-gray-700">
              Are you sure you want to cancel the current upload?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={handleCancelUploadDismiss}
                className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)]"
              >
                Keep Uploading
              </button>
              <button
                onClick={handleCancelUploadConfirm}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
              >
                Cancel Upload
              </button>
            </div>
          </div>
        </div>
      )}

      {showConflictDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Name conflict detected</h3>
            <p className="mt-3 text-sm text-gray-700">
              Some uploaded files or folders have the same name as existing items in Input. Choose how to continue.
            </p>
            <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-3 text-sm text-[var(--app-text)]">
              <div className="font-medium text-[var(--app-text)]">Conflicts</div>
              <div className="mt-2 space-y-1">
                {visibleConflictItems.map((item) => (
                  <div key={item.path} className="truncate">
                    {item.name}
                  </div>
                ))}
                {hasMoreConflicts && <div className="text-[var(--app-text-muted)]">and more...</div>}
              </div>
            </div>
            <div className="mt-3 space-y-2 text-sm text-[var(--app-text)]">
              <div>
                <span className="font-medium text-[var(--app-text)]">Replace existing:</span>{' '}
                Move the existing file or folder to Recycle Bin, then upload the new one with the original name.
              </div>
              <div>
                <span className="font-medium text-[var(--app-text)]">Rename uploaded:</span>{' '}
                Keep existing items and rename uploaded items to name_(1), name_(2), and so on.
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => closeConflictDialog(null)}
                className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)]"
              >
                Cancel
              </button>
              <button
                onClick={() => closeConflictDialog('rename')}
                className="rounded-xl border border-[var(--app-accent)] px-3 py-1.5 text-sm text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
              >
                Rename uploaded
              </button>
              <button
                onClick={() => closeConflictDialog('replace')}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
              >
                Replace existing
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteItem && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Delete from Input?</h3>
            <p className="mt-3 text-sm text-gray-700">
              Delete "{pendingDeleteItem.name}" from Input? You can restore it from Recycle Bin.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={handleCancelDeleteInputItem}
                disabled={deleteSubmitting}
                className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleConfirmDeleteInputItem()}
                disabled={deleteSubmitting}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleteSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
