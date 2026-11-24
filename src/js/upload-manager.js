import dayjs from 'dayjs'
import { filesize } from 'filesize'
import {
  COMPRESSIBLE_IMAGE_RE,
  IMAGE_RE,
  MAX_UPLOAD_SIZE,
  MULTIPART_CONCURRENCY,
  MULTIPART_MAX_PARTS,
  MULTIPART_MAX_RETRIES,
  MULTIPART_MIN_PART_SIZE,
  MULTIPART_UPLOAD_THRESHOLD,
} from './constants.js'
import { t } from './i18n.js'
import { ConfigManager } from './config-manager.js'
import { FileExplorer } from './file-explorer.js'
import { StorageClient } from './storage-client.js'
import { UIManager } from './ui-manager.js'
import { $, applyFilenameTemplate, computeFileHash, extractFileName, getErrorMessage, getMimeType } from './utils.js'

/** @typedef {{ accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string; filenameTpl?: string; filenameTplScope?: string; customDomain?: string; compressMode?: string; compressLevel?: string; tinifyKey?: string }} AppConfig */

const UPLOAD_CANCELED = 'UPLOAD_CANCELED'
const MULTIPART_CLEANUP_FAILED = 'MULTIPART_CLEANUP_FAILED'

/**
 * Templates may produce an absolute-looking path or an empty value. Object
 * keys are relative to the bucket root and never end with a slash, so fall
 * back to the original file name in those cases. Backslashes and `.`/`..`
 * segments are normalised away too: the server rejects them and a Windows
 * separator must not silently become a directory.
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function normalizeUploadName(name, fallback) {
  const cleaned = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
  return cleaned && !cleaned.endsWith('/') ? cleaned : fallback
}

/**
 * Compress image file based on configuration
 * @param {File} file - Original file
 * @param {AppConfig} config - AppConfig object
 * @param {function(string):void} onStatus - Callback to update status text
 * @returns {Promise<File>}
 */
async function compressFile(file, config, onStatus) {
  const allowCompress = COMPRESSIBLE_IMAGE_RE.test(file.name)

  if (!allowCompress || !config.compressMode || config.compressMode === 'none') {
    return file
  }

  try {
    const originalSize = file.size

    if (config.compressMode === 'local') {
      onStatus && onStatus(t('compressProgress'))

      const level = config.compressLevel || 'balanced'

      const jpegQuality = level === 'extreme' ? 75 : 90
      const avifQuality = level === 'extreme' ? 50 : 60

      const ext = file.name.toLowerCase().match(/\.(jpe?g|png|webp|avif)$/i)?.[1]
      let compressedBuffer
      let outputType = file.type

      if (ext === 'png') {
        const { optimise: optimisePng } = await import('@jsquash/oxipng')
        const oxipngLevel = level === 'extreme' ? 4 : 2
        compressedBuffer = await optimisePng(await file.arrayBuffer(), {
          level: oxipngLevel,
          interlace: false,
          optimiseAlpha: true,
        })
        outputType = 'image/png'
      } else {
        const img = new Image()
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        const objectUrl = URL.createObjectURL(file)

        try {
          await new Promise((resolve, reject) => {
            img.onload = resolve
            img.onerror = reject
            img.src = objectUrl
          })
        } finally {
          URL.revokeObjectURL(objectUrl)
        }

        canvas.width = img.width
        canvas.height = img.height
        if (!ctx) return file
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

        if (ext === 'jpg' || ext === 'jpeg') {
          const { encode: encodeJpeg } = await import('@jsquash/jpeg')
          compressedBuffer = await encodeJpeg(imageData, { quality: jpegQuality })
          outputType = 'image/jpeg'
        } else if (ext === 'webp') {
          const { encode: encodeWebp } = await import('@jsquash/webp')
          compressedBuffer = await encodeWebp(imageData, { quality: jpegQuality })
          outputType = 'image/webp'
        } else if (ext === 'avif') {
          const { encode: encodeAvif } = await import('@jsquash/avif')
          const avifSpeed = level === 'extreme' ? 4 : 6
          compressedBuffer = await encodeAvif(imageData, {
            quality: avifQuality,
            speed: avifSpeed,
          })
          outputType = 'image/avif'
        } else {
          return file
        }
      }

      const compressedBlob = new Blob([compressedBuffer], { type: outputType })

      const savings = Math.round((1 - compressedBlob.size / originalSize) * 100)

      if (savings > 0) {
        onStatus &&
          onStatus(
            t('compressLocalResult', {
              from: filesize(originalSize),
              to: filesize(compressedBlob.size),
              percent: savings,
            }),
          )
        return new File([compressedBlob], file.name, { type: outputType })
      } else {
        onStatus && onStatus(t('compressLocalOriginal', { size: filesize(originalSize) }))
        return file
      }
    }

    if (config.compressMode === 'tinify') {
      if (!config.tinifyKey) return file

      onStatus && onStatus(t('compressCloudProgress'))

      // The Tinify API sends no CORS headers, so the browser cannot call it
      // directly. Relay through the bundled local server (same origin) instead
      // of a third-party proxy: the key and the image stay on your own server.
      const response = await fetch('/api/tinify/compress', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Tinify-Key': config.tinifyKey,
        },
        body: file,
      })

      if (response.status === 401) {
        window.location.replace('/login')
        return new Promise(() => {})
      }

      // In a pure static deployment this path is served by the static host and
      // may answer with an SPA fallback: never treat HTML as compressed image.
      const responseType = response.headers.get('content-type') || ''
      if (!response.ok || !responseType.startsWith('image/')) {
        onStatus && onStatus(t('compressCloudUnavailable'))
        return file
      }

      const compressedBlob = await response.blob()
      if (!compressedBlob.size) {
        onStatus && onStatus(t('compressCloudUnavailable'))
        return file
      }

      const savings = Math.round((1 - compressedBlob.size / originalSize) * 100)
      if (savings > 0) {
        onStatus &&
          onStatus(
            t('compressCloudResult', {
              from: filesize(originalSize),
              to: filesize(compressedBlob.size),
              percent: savings,
            }),
          )
      } else {
        onStatus && onStatus(t('compressCloudOptimized', { size: filesize(compressedBlob.size) }))
      }

      return new File([compressedBlob], file.name, { type: file.type })
    }
  } catch {
    onStatus && onStatus(t('compressFailedOriginal'))
  }

  return file
}

/**
 * 并发限制执行异步任务，返回 PromiseSettledResult 数组
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<PromiseSettledResult<T>[]>}
 */
async function runWithConcurrency(tasks, limit) {
  const results = /** @type {PromiseSettledResult<T>[]} */ (new Array(tasks.length))
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() }
      } catch (e) {
        results[i] = { status: 'rejected', reason: e }
      }
    }
  }
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

/**
 * Validate an object key typed by the user (paste-to-upload path prompt).
 * Backslashes and `.`/`..` segments are rejected by the server anyway; catch
 * them here so the user gets a field error instead of `HTTP 400`.
 * @param {string} value
 * @returns {string | null}
 */
function validateUploadPath(value) {
  const trimmed = value.trim()
  if (!trimmed) return t('fileNameRequired')
  const illegal = trimmed.match(/[\\\x00-\x1F]/g)
  if (illegal) return t('pathInvalidChars', { chars: [...new Set(illegal)].join('  ') })
  if (trimmed.endsWith('/') || trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    return t('pathInvalidChars', { chars: '/ . ..' })
  }
  return null
}

class UploadManager {
  /** @type {StorageClient} */
  #storage
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer
  /** @type {ConfigManager} */
  #config
  #dragCounter = 0
  /** @type {Map<string, { paused: boolean; canceled: boolean; percent: number; loaded: number; total: number; speed: number; waiters: Array<() => void>; activeXhrs: Set<XMLHttpRequest> }>} */
  #uploadControls = new Map()
  #batchSeq = 0
  /** Batches currently running, used to keep concurrent upload UIs separate. @type {Map<number, { total: number; completed: number }>} */
  #activeBatches = new Map()

  /** @param {StorageClient} storage @param {UIManager} ui @param {FileExplorer} explorer @param {ConfigManager} config */
  constructor(storage, ui, explorer, config) {
    this.#storage = storage
    this.#ui = ui
    this.#explorer = explorer
    this.#config = config
  }

  initDragDrop() {
    const app = $('#app')
    const dropzone = $('#dropzone')

    const showDropzone = () => {
      this.#dragCounter++
      dropzone.hidden = false
    }

    const hideDropzone = () => {
      this.#dragCounter--
      if (this.#dragCounter <= 0) {
        this.#dragCounter = 0
        dropzone.hidden = true
      }
    }

    const handleDrop = (/** @type {DragEvent} */ e) => {
      e.preventDefault()
      e.stopPropagation()
      this.#dragCounter = 0
      dropzone.hidden = true
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length > 0) {
        this.uploadFiles(files)
      } else {
        this.#ui.toast(t('dropInvalidHint'), 'info')
      }
    }

    app.addEventListener('dragenter', (e) => {
      e.preventDefault()
      showDropzone()
    })

    app.addEventListener('dragleave', (e) => {
      e.preventDefault()
      hideDropzone()
    })

    app.addEventListener('dragover', (/** @type {DragEvent} */ e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })

    app.addEventListener('drop', handleDrop)

    dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault()
      showDropzone()
    })

    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault()
      hideDropzone()
    })

    dropzone.addEventListener('dragover', (/** @type {DragEvent} */ e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })

    dropzone.addEventListener('drop', handleDrop)

    document.addEventListener('paste', async (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return

      const items = [...(e.clipboardData?.items || [])]
      const htmlText = e.clipboardData?.getData('text/html') || ''
      const plainText = e.clipboardData?.getData('text/plain') || ''
      // 去除 HTML 标签后的纯文字内容，用于判断是否有实质文字（避免把图片的 HTML 包装误判为文字）
      const htmlTextContent = htmlText.replace(/<[^>]+>/g, '').trim()
      const hasText = Boolean(plainText.trim() || htmlTextContent)
      const hasImageItem = items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))
      const hasHtmlImage = Boolean(htmlText.trim()) && /<img[\s>]/i.test(htmlText)

      /** @type {File[]} */
      const files = items
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(/** @returns {f is File} */ (f) => f !== null)

      if ((hasImageItem || hasHtmlImage) && hasText) {
        this.#ui.toast(t('pasteMixedNotSupported'), 'info')
        return
      }

      if (files.length > 0) {
        e.preventDefault()
        const allImages = files.every((f) => f.type.startsWith('image/'))
        if (allImages) {
          this.#ui.toast(t('pasteToUpload', { count: files.length }), 'success')
          this.uploadFiles(files)
          return
        }

        if (files.length === 1) {
          const file = files[0]
          const ok = await this.#ui.confirm(t('pasteFileConfirmTitle'), t('pasteFileConfirmMsg', { name: file.name }))
          if (!ok) return
          const suggestedPath = this.#explorer.currentPrefix + file.name
          const targetPath = await this.#ui.prompt(t('pasteFilePathTitle'), t('pasteFilePathLabel'), suggestedPath, {
            validate: validateUploadPath,
          })
          if (targetPath === null) return
          await this.uploadFiles([file], targetPath)
          return
        }

        const ok = await this.#ui.confirm(
          t('pasteFilesConfirmTitle'),
          t('pasteFilesConfirmMsg', { count: files.length }),
        )
        if (!ok) return
        this.uploadFiles(files)
        return
      }

      if (hasText) {
        e.preventDefault()
        let content = plainText
        if (!content.trim() && htmlTextContent) {
          const doc = new DOMParser().parseFromString(htmlTextContent, 'text/html')
          content = doc.body?.textContent || ''
        }
        content = content.trim()
        if (!content) return

        const ok = await this.#ui.confirm(t('pasteTextConfirmTitle'), t('pasteTextConfirmMsg'))
        if (!ok) return

        const cfg = this.#config.get()
        let filename = `pasted-${dayjs().format('YYYYMMDD-HHmmss')}.txt`
        if ((cfg.filenameTplScope || 'images') === 'images') {
          const tempFile = new File([content], 'pasted.txt', { type: 'text/plain' })
          const hash = await computeFileHash(tempFile)
          filename = `${hash.slice(0, 6)}.txt`
        }

        const suggestedPath = this.#explorer.currentPrefix + filename
        const targetPath = await this.#ui.prompt(t('pasteTextPathTitle'), t('pasteTextPathLabel'), suggestedPath, {
          validate: validateUploadPath,
        })
        if (targetPath === null) return

        const file = new File([content], filename, { type: 'text/plain' })
        await this.uploadFiles([file], targetPath)
      }
    })
  }

  /**
   * Start an upload batch. Errors are reported to the user here so callers
   * (drop, paste, file input) never leave an unhandled promise rejection.
   * @param {File[]} files
   * @param {string} [overrideKey]
   */
  async uploadFiles(files, overrideKey) {
    const batchId = ++this.#batchSeq
    const batch = { total: 0, completed: 0 }
    this.#activeBatches.set(batchId, batch)
    try {
      await this.#uploadFiles(files, overrideKey, batchId, batch)
    } catch (err) {
      console.error('Upload failed:', err)
      const errorKey = err instanceof Error ? getErrorMessage(err) : 'networkError'
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err instanceof Error ? err.message : String(err) }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
      if (this.#activeBatches.size <= 1) $('#upload-panel').hidden = true
    } finally {
      this.#activeBatches.delete(batchId)
      this.#updateUploadTitle()
    }
  }

  /**
   * @param {File[]} files
   * @param {string | undefined} overrideKey
   * @param {number} batchId
   * @param {{ total: number; completed: number }} batch
   */
  async #uploadFiles(files, overrideKey, batchId, batch) {
    const panel = $('#upload-panel')
    const body = $('#upload-panel-body')

    // Only reset the panel when no other batch is in flight; concurrent
    // batches must keep each other's progress items visible.
    if (this.#activeBatches.size === 1) body.innerHTML = ''
    panel.hidden = false
    this.#updateUploadTitle()

    const cfg = this.#config.get()
    const filenameTpl = cfg.filenameTpl || ''
    const filenameTplScope = cfg.filenameTplScope || 'images'
    const currentPrefix = this.#explorer.currentPrefix
    /** @type {'template'|'prefix-template'|'prefix-basename'} */
    let pathStrategy = 'prefix-template'
    let pathStrategyChosen = false
    const useOverrideKey = Boolean(overrideKey && files.length === 1)

    /** @type {{ file: File, key: string }[]} */
    const planned = []

    // Phase 1: resolve every destination key. Only the interactive template
    // path dialog happens here; renames do not touch the network.
    for (const file of files) {
      if (file.size > MAX_UPLOAD_SIZE) {
        this.#ui.toast(
          t('fileTooLarge', { name: file.name, size: filesize(MAX_UPLOAD_SIZE, { standard: 'iec' }) }),
          'error',
        )
        continue
      }

      const shouldApplyTpl = filenameTplScope === 'all' ? true : IMAGE_RE.test(file.name)
      const templateName = shouldApplyTpl ? await applyFilenameTemplate(filenameTpl, file) : file.name
      const processedName = normalizeUploadName(templateName, file.name)

      if (
        !pathStrategyChosen &&
        currentPrefix &&
        shouldApplyTpl &&
        (processedName.includes('/') || filenameTpl.includes('/'))
      ) {
        const choice = await this.#ui.chooseFilenameTemplatePath(currentPrefix, processedName, filenameTpl)
        if (!choice) {
          if (this.#activeBatches.size <= 1) panel.hidden = true
          return
        }
        pathStrategy = choice
        pathStrategyChosen = true
      }

      let key
      if (useOverrideKey) {
        key = /** @type {string} */ (overrideKey)
      } else if (pathStrategy === 'template') {
        key = processedName
      } else if (pathStrategy === 'prefix-basename') {
        key = currentPrefix + extractFileName(processedName)
      } else {
        key = currentPrefix + processedName
      }

      planned.push({ file, key })
    }

    // Phase 2: probe every destination concurrently. Checking one file at a
    // time made a 500-file drop appear frozen for minutes before the first
    // progress row showed up.
    const existence = await runWithConcurrency(
      planned.map((entry) => () => this.#storage.fileExists(entry.key)),
      4,
    )
    const existingKeys = new Set(
      planned
        .filter((_, index) => existence[index]?.status === 'fulfilled' && existence[index].value === true)
        .map((entry) => entry.key),
    )

    // Phase 3: confirm conflicts and build the progress list.
    const uploads = []
    /** @type {null | 'overwrite-all' | 'skip-all'} */
    let conflictDecision = null
    let skippedCount = 0

    for (let i = 0; i < planned.length; i++) {
      const { file, key } = planned[i]

      if (conflictDecision !== 'overwrite-all' && existingKeys.has(key)) {
        if (conflictDecision === 'skip-all') {
          skippedCount++
          continue
        }
        const choice = await this.#ui.confirmOverwrite(extractFileName(key), planned.length > 1)
        if (choice === 'skip') {
          skippedCount++
          continue
        }
        if (choice === 'skip-all') {
          conflictDecision = 'skip-all'
          skippedCount++
          continue
        }
        if (choice === 'overwrite-all') conflictDecision = 'overwrite-all'
        // 'overwrite': fall through to upload
      }

      const contentType = file.type || getMimeType(file.name)

      const id = `upload-${batchId}-${i}`
      const displayName = key.length > 40 ? '...' + key.slice(-37) : key

      const item = document.createElement('div')
      item.className = 'upload-item'
      item.id = id
      item.innerHTML = `
        <div class="upload-item-header">
          <div class="upload-item-name"></div>
          <div class="upload-item-meta">
            <div class="upload-item-status" id="${id}-status"></div>
            <button type="button" class="upload-action-btn" id="${id}-pause" hidden></button>
            <button type="button" class="upload-action-btn danger" id="${id}-cancel"></button>
          </div>
        </div>
        <div class="upload-progress">
          <div class="upload-progress-bar" id="${id}-bar"></div>
        </div>
      `
      const nameEl = /** @type {HTMLElement} */ (item.querySelector('.upload-item-name'))
      nameEl.textContent = displayName
      nameEl.setAttribute('title', displayName)
      body.appendChild(item)
      this.#setupUploadControl(id)
      $(`#${id}-pause`).addEventListener('click', () => this.#toggleMultipartPause(id))
      const cancelButton = $(`#${id}-cancel`)
      cancelButton.textContent = t('cancelUpload')
      cancelButton.addEventListener('click', () => this.#cancelUpload(id))

      const updateStatus = /** @param {string} msg */ (msg) => {
        const statusEl = $(`#${id}-status`)
        if (statusEl) statusEl.textContent = msg
      }
      updateStatus(t('uploadWaiting'))

      uploads.push({ id, key, file, contentType, updateStatus })
    }

    // All files were skipped
    if (uploads.length === 0) {
      if (this.#activeBatches.size <= 1) panel.hidden = true
      if (skippedCount > 0) {
        this.#ui.toast(t('uploadSkipped', { count: skippedCount }), 'info')
      }
      return
    }

    batch.total = uploads.length
    panel.hidden = false
    this.#updateUploadTitle()

    const results = await runWithConcurrency(
      uploads.map((u) => async () => {
        let compressionStatus = ''
        try {
          this.#throwIfCanceled(u.id)
          const compressed = await compressFile(u.file, cfg, (msg) => {
            compressionStatus = msg
            if (!this.#uploadControls.get(u.id)?.canceled) u.updateStatus(msg)
          })
          this.#throwIfCanceled(u.id)
          u.updateStatus(t('uploading'))
          const result = await this.#uploadSingleFile(u.id, u.key, compressed, u.contentType)
          u.updateStatus(compressionStatus || filesize(compressed.size))
          return result
        } catch (error) {
          if (error instanceof Error && error.message === UPLOAD_CANCELED) {
            u.updateStatus(t('uploadCanceled'))
          } else if (error instanceof Error && error.message === MULTIPART_CLEANUP_FAILED) {
            u.updateStatus(t('multipartCleanupFailed'))
          } else {
            u.updateStatus('')
          }
          throw error
        } finally {
          this.#cleanupUploadControl(u.id)
          batch.completed++
          this.#updateUploadTitle()
        }
      }),
      cfg.uploadConcurrency ?? 3,
    )

    const success = results.filter((r) => r.status === 'fulfilled').length
    const canceled = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof Error && r.reason.message === UPLOAD_CANCELED,
    ).length
    const fail = results.length - success - canceled

    if (fail > 0) {
      this.#ui.toast(t('uploadPartialFail', { success, fail }), 'error')
    } else if (success > 0) {
      this.#ui.toast(t('uploadSuccess', { count: success }), 'success')
    }
    if (canceled > 0) this.#ui.toast(t('uploadCanceledCount', { count: canceled }), 'info')
    if (skippedCount > 0) {
      this.#ui.toast(t('uploadSkipped', { count: skippedCount }), 'info')
    }

    await this.#explorer.refresh()
  }

  /** @param {string} id @param {string} key @param {File} file @param {string} contentType */
  async #uploadSingleFile(id, key, file, contentType) {
    if (file.size >= MULTIPART_UPLOAD_THRESHOLD) {
      return this.#uploadMultipartFile(id, key, file, contentType)
    }

    const request = this.#storage.putObject(key, contentType, file)
    const bar = $(`#${id}-bar`)

    const reportProgress = this.#createProgressReporter(id, file.size)
    try {
      await this.#uploadRequestBody(request, file, reportProgress, id)
      if (bar) {
        bar.classList.add('done')
        bar.style.width = '100%'
      }
    } catch (error) {
      if (bar) bar.classList.add(error instanceof Error && error.message === UPLOAD_CANCELED ? 'canceled' : 'error')
      throw error
    }
  }

  /** @param {string} id @param {string} key @param {File} file @param {string} contentType */
  async #uploadMultipartFile(id, key, file, contentType) {
    const bar = $(`#${id}-bar`)
    const oneMiB = 1024 ** 2
    const requiredPartSize = Math.ceil(file.size / MULTIPART_MAX_PARTS / oneMiB) * oneMiB
    const partSize = Math.max(MULTIPART_MIN_PART_SIZE, requiredPartSize)
    const partCount = Math.ceil(file.size / partSize)
    // Honour the configured upload concurrency for parts as well, but keep it
    // within the range the settings UI allows.
    const partConcurrency = Math.max(
      1,
      Math.min(6, Number(this.#config.get().uploadConcurrency) || MULTIPART_CONCURRENCY),
    )
    const activePartProgress = new Map()
    let uploadedBytes = 0
    let uploadId = ''
    this.#setupMultipartPause(id)
    const reportProgress = this.#createProgressReporter(id, file.size)
    reportProgress(0)

    const renderProgress = () => {
      const activeBytes = [...activePartProgress.values()].reduce((sum, loaded) => sum + loaded, 0)
      reportProgress(Math.min(file.size, uploadedBytes + activeBytes))
    }

    try {
      uploadId = await this.#storage.createMultipartUpload(key, contentType)
      const results = await runWithConcurrency(
        Array.from({ length: partCount }, (_, index) => async () => {
          await this.#waitWhilePaused(id)
          const partNumber = index + 1
          const start = index * partSize
          const part = file.slice(start, Math.min(start + partSize, file.size))
          const etag = await this.#uploadPartWithRetry(id, key, uploadId, partNumber, part, (loaded) => {
            activePartProgress.set(partNumber, loaded)
            renderProgress()
          })
          activePartProgress.delete(partNumber)
          uploadedBytes += part.size
          renderProgress()
          return { partNumber, etag }
        }),
        partConcurrency,
      )
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason

      this.#throwIfCanceled(id)
      const parts = results
        .filter(
          /** @returns {result is PromiseFulfilledResult<{ partNumber: number; etag: string }>} */ (result) =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value)
        .sort((a, b) => a.partNumber - b.partNumber)
      const cancelButton = /** @type {HTMLButtonElement | null} */ ($(`#${id}-cancel`))
      if (cancelButton) cancelButton.disabled = true
      await this.#storage.completeMultipartUpload(key, uploadId, parts)
      if (bar) {
        bar.classList.add('done')
        bar.style.width = '100%'
      }
    } catch (error) {
      if (bar) bar.classList.add(error instanceof Error && error.message === UPLOAD_CANCELED ? 'canceled' : 'error')
      if (uploadId) {
        try {
          await this.#abortMultipartWithRetry(key, uploadId)
        } catch {
          throw new Error(MULTIPART_CLEANUP_FAILED, { cause: error })
        }
      }
      throw error
    }
  }

  /**
   * @param {string} id
   * @param {string} key
   * @param {string} uploadId
   * @param {number} partNumber
   * @param {Blob} part
   * @param {(loaded: number) => void} onProgress
   */
  async #uploadPartWithRetry(id, key, uploadId, partNumber, part, onProgress) {
    let lastError
    let attempt = 0
    while (attempt < MULTIPART_MAX_RETRIES) {
      await this.#waitWhilePaused(id)
      this.#throwIfCanceled(id)
      try {
        onProgress(0)
        const request = this.#storage.uploadPart(key, uploadId, partNumber, part)
        const xhr = await this.#uploadRequestBody(request, part, onProgress, id)
        const etag = xhr.getResponseHeader('etag')
        if (!etag) throw new Error('The server did not return an ETag for the uploaded part')
        return etag
      } catch (error) {
        if (error instanceof Error && error.message === 'UPLOAD_PAUSED') {
          onProgress(0)
          continue
        }
        if (error instanceof Error && error.message === UPLOAD_CANCELED) throw error
        this.#throwIfCanceled(id)
        lastError = error
        attempt++
        if (attempt < MULTIPART_MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
          this.#throwIfCanceled(id)
        }
      }
    }
    throw lastError
  }

  /**
   * @param {{ url: string; headers: Record<string, string> }} request
   * @param {Blob} body
   * @param {(loaded: number) => void} onProgress
   * @param {string} [id]
   * @returns {Promise<XMLHttpRequest>}
   */
  #uploadRequestBody(request, body, onProgress, id = '') {
    return new Promise((resolve, reject) => {
      const control = id ? this.#uploadControls.get(id) : null
      if (control?.canceled) {
        reject(new Error(UPLOAD_CANCELED))
        return
      }
      if (control?.paused) {
        reject(new Error('UPLOAD_PAUSED'))
        return
      }
      const xhr = new XMLHttpRequest()
      control?.activeXhrs.add(xhr)
      const finish = () => {
        control?.activeXhrs.delete(xhr)
        if (control?.paused && control.activeXhrs.size === 0) {
          control.speed = 0
          const pauseButton = /** @type {HTMLButtonElement} */ ($(`#${id}-pause`))
          if (pauseButton) pauseButton.disabled = false
          this.#renderUploadProgress(id, control.loaded, control.total, control.speed)
        }
      }
      xhr.open('PUT', request.url)
      for (const [name, value] of Object.entries(request.headers)) {
        if (!['host', 'content-length'].includes(name.toLowerCase())) xhr.setRequestHeader(name, value)
      }
      xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded))
      xhr.addEventListener('load', () => {
        finish()
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr)
        else reject(new Error(`HTTP ${xhr.status}`))
      })
      xhr.addEventListener('error', () => {
        finish()
        reject(new TypeError('Failed to fetch'))
      })
      xhr.addEventListener('abort', () => {
        finish()
        reject(new Error(control?.canceled ? UPLOAD_CANCELED : control?.paused ? 'UPLOAD_PAUSED' : 'Upload aborted'))
      })
      xhr.send(body)
    })
  }

  /** @param {string} id @param {number} total */
  #createProgressReporter(id, total) {
    let lastLoaded = 0
    let lastTime = performance.now()
    let speed = 0
    return (/** @type {number} */ loaded) => {
      const now = performance.now()
      const elapsed = (now - lastTime) / 1000
      if (loaded < lastLoaded) {
        speed = 0
        lastLoaded = loaded
        lastTime = now
      } else if (elapsed >= 0.25 || (loaded >= total && speed === 0)) {
        const currentSpeed = elapsed > 0 ? (loaded - lastLoaded) / elapsed : 0
        speed = speed > 0 ? speed * 0.7 + currentSpeed * 0.3 : currentSpeed
        lastLoaded = loaded
        lastTime = now
      }
      this.#renderUploadProgress(id, loaded, total, speed)
    }
  }

  /** @param {string} id @param {number} loaded @param {number} total @param {number} speed */
  #renderUploadProgress(id, loaded, total, speed) {
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100
    const control = this.#uploadControls.get(id)
    if (control) {
      control.percent = percent
      control.loaded = loaded
      control.total = total
      control.speed = speed
    }
    const uploadState = control?.paused ? (control.activeXhrs.size > 0 ? 'pausing' : 'paused') : 'uploading'
    const stateClasses = ['uploading', 'pausing', 'paused']
    const bar = $(`#${id}-bar`)
    if (bar) {
      bar.style.width = `${percent}%`
      bar.classList.remove(...stateClasses)
      bar.classList.add(uploadState)
    }
    const button = $(`#${id}-pause`)
    if (button) {
      button.classList.remove(...stateClasses)
      button.classList.add(uploadState)
    }
    const status = $(`#${id}-status`)
    if (status) {
      status.classList.remove(...stateClasses)
      status.classList.add(uploadState)
      const statusKey =
        uploadState === 'pausing' ? 'uploadPausing' : uploadState === 'paused' ? 'uploadPaused' : 'uploadingProgress'
      status.textContent = t(statusKey, {
        percent,
        loaded: filesize(loaded),
        total: filesize(total),
        speed: filesize(speed),
      })
    }
  }

  /** @param {string} id */
  #setupUploadControl(id) {
    this.#uploadControls.set(id, {
      paused: false,
      canceled: false,
      percent: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      waiters: [],
      activeXhrs: new Set(),
    })
  }

  /** @param {string} id */
  #setupMultipartPause(id) {
    const button = /** @type {HTMLButtonElement} */ ($(`#${id}-pause`))
    button.hidden = false
    button.disabled = false
    button.textContent = t('pauseUpload')
  }

  /** @param {string} id */
  #toggleMultipartPause(id) {
    const control = this.#uploadControls.get(id)
    if (!control || control.canceled) return
    control.paused = !control.paused
    const button = /** @type {HTMLButtonElement} */ ($(`#${id}-pause`))
    if (control.paused) {
      button.textContent = t('resumeUpload')
      button.disabled = control.activeXhrs.size > 0
    } else {
      button.textContent = t('pauseUpload')
      const waiters = control.waiters.splice(0)
      waiters.forEach((resolve) => resolve())
    }
    this.#renderUploadProgress(id, control.loaded, control.total, control.speed)
  }

  /** @param {string} id */
  #cancelUpload(id) {
    const control = this.#uploadControls.get(id)
    if (!control || control.canceled) return
    control.canceled = true
    control.paused = false
    control.waiters.splice(0).forEach((resolve) => resolve())
    control.activeXhrs.forEach((xhr) => xhr.abort())
    const cancelButton = /** @type {HTMLButtonElement | null} */ ($(`#${id}-cancel`))
    if (cancelButton) cancelButton.disabled = true
    const pauseButton = /** @type {HTMLButtonElement | null} */ ($(`#${id}-pause`))
    if (pauseButton) pauseButton.hidden = true
    const status = $(`#${id}-status`)
    if (status) status.textContent = t('uploadCanceling')
  }

  cancelAllUploads() {
    for (const id of this.#uploadControls.keys()) this.#cancelUpload(id)
  }

  /** Keep the panel title accurate when several batches overlap. */
  #updateUploadTitle() {
    const title = $('#upload-panel-title')
    if (!title) return
    let total = 0
    let completed = 0
    for (const batch of this.#activeBatches.values()) {
      total += batch.total
      completed += batch.completed
    }
    if (total > 0) title.textContent = `${t('uploadProgress')} ${completed}/${total}`
    else if (this.#activeBatches.size > 0) title.textContent = t('uploadPreparing')
  }

  /** @param {string} id */
  #throwIfCanceled(id) {
    if (this.#uploadControls.get(id)?.canceled) throw new Error(UPLOAD_CANCELED)
  }

  /** @param {string} id */
  async #waitWhilePaused(id) {
    const control = this.#uploadControls.get(id)
    this.#throwIfCanceled(id)
    if (control?.paused) await new Promise((resolve) => control.waiters.push(() => resolve(undefined)))
    this.#throwIfCanceled(id)
  }

  /** @param {string} key @param {string} uploadId */
  async #abortMultipartWithRetry(key, uploadId) {
    let lastError
    for (let attempt = 0; attempt < MULTIPART_MAX_RETRIES; attempt++) {
      try {
        await this.#storage.abortMultipartUpload(key, uploadId)
        return
      } catch (error) {
        lastError = error
        if (attempt < MULTIPART_MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
        }
      }
    }
    throw lastError
  }

  /** @param {string} id */
  #cleanupUploadControl(id) {
    const control = this.#uploadControls.get(id)
    control?.waiters.splice(0).forEach((resolve) => resolve())
    this.#uploadControls.delete(id)
    for (const suffix of ['pause', 'cancel']) {
      const button = /** @type {HTMLButtonElement | null} */ ($(`#${id}-${suffix}`))
      if (button) {
        button.disabled = false
        button.hidden = true
      }
    }
  }
}

export { UploadManager }
