import { IMAGE_RE, VIDEO_RE, AUDIO_RE } from './constants.js'
import { t } from './i18n.js'
import { FileExplorer } from './file-explorer.js'
import { StorageClient } from './storage-client.js'
import { UIManager } from './ui-manager.js'
import { getErrorMessage, extractFileName } from './utils.js'

/**
 * The async clipboard API only reliably accepts `image/png` across browsers,
 * so re-encode other image formats through a canvas first.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function imageToPng(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not available')
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encoding failed'))), 'image/png')
    })
  } finally {
    bitmap.close?.()
  }
}

/**
 * Run `fn` over `items` with a bounded number of concurrent operations.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function runLimited(items, limit, fn) {
  const results = /** @type {R[]} */ (new Array(items.length))
  let index = 0
  const worker = async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await fn(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

class FileOperations {
  /** @type {StorageClient} */
  #storage
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer

  /**
   * 将用户输入的路径规范化为文件夹前缀。
   * 去除前导斜杠，根目录返回 `''`，否则确保以 `/` 结尾。
   * @param {string} v
   * @returns {string}
   */
  static #toFolderPrefix(v) {
    const norm = v.replace(/^\/+/, '')
    return norm === '' ? '' : norm.endsWith('/') ? norm : norm + '/'
  }

  /** @param {StorageClient} storage @param {UIManager} ui @param {FileExplorer} explorer */
  constructor(storage, ui, explorer) {
    this.#storage = storage
    this.#ui = ui
    this.#explorer = explorer
  }

  /**
   * Check whether writing to `dest` would overwrite existing content.
   * Folders are considered occupied when they hold any file or subfolder.
   * @param {string} dest
   * @param {boolean} isFolder
   * @returns {Promise<boolean>}
   */
  async #isDestinationFree(dest, isFolder) {
    if (!isFolder) return !(await this.#storage.fileExists(dest))
    // One listing is enough: a folder key itself is never an object on the
    // bundled server, and the old extra `fileExists` probe was a full
    // recursive scan on every rename/copy/move.
    const listing = await this.#storage.listObjects(dest, '')
    return listing.files.length === 0 && listing.folders.length === 0
  }

  /**
   * Delete a folder. The bundled server removes a whole directory in one
   * request; fall back to per-object deletion if that ever fails.
   * @param {string} key
   */
  async #deleteFolder(key) {
    try {
      await this.#storage.deleteObject(key)
      return
    } catch {
      /* fall back to per-object deletion below */
    }
    await this.#recursiveOperation(key, (srcKey) => this.#storage.deleteObject(srcKey), false)
    try {
      await this.#storage.deleteObject(key)
    } catch {}
  }

  /**
   * Ask before replacing existing content. Returns true when the operation
   * may proceed (destination free or user confirmed).
   * @param {string} dest
   * @param {boolean} isFolder
   */
  async #confirmReplace(dest, isFolder) {
    if (await this.#isDestinationFree(dest, isFolder)) return true
    return this.#ui.confirm(t('overwriteTitle'), t('overwriteMsg', { name: dest }))
  }

  /**
   * Batch variant: ask once for all conflicting destinations.
   * @param {import('./file-explorer.js').SelectionItem[]} items
   * @param {string} folder
   */
  async #confirmBatchReplace(items, folder) {
    const conflicts = (
      await runLimited(items, 4, async (item) => {
        const dest = folder + extractFileName(item.key) + (item.isFolder ? '/' : '')
        if (dest === item.key) return false
        return !(await this.#isDestinationFree(dest, item.isFolder))
      })
    ).filter(Boolean)
    if (conflicts.length === 0) return true
    return this.#ui.confirm(t('overwriteTitle'), t('batchOverwriteMsg', { count: conflicts.length }))
  }

  /** @param {string} key @param {boolean} isFolder */
  async rename(key, isFolder) {
    const oldName = extractFileName(key)
    const newName = await this.#ui.prompt(t('renameTitle'), t('renameLabel'), oldName, {
      validate: (v) => {
        if (!v.trim()) return t('fileNameRequired')
        const illegal = v.match(/[/\\:*?"<>|\x00-\x1F]/g)
        if (illegal) return t('renameInvalidChars', { chars: [...new Set(illegal)].join('  ') })
        return null
      },
    })
    if (!newName || newName === oldName) return

    try {
      const prefix = key.substring(0, key.lastIndexOf(oldName))
      const dest = prefix + newName + (isFolder ? '/' : '')
      if (!(await this.#confirmReplace(dest, isFolder))) return

      this.#ui.toast(t('renaming', { name: oldName, destName: newName }), 'info')

      if (isFolder) {
        // createFolder also preserves an empty source folder, which would
        // otherwise have no keys to copy.
        await this.#storage.createFolder(dest)
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            await this.#storage.copyObject(srcKey, dest + relative)
          },
          true,
        )
      } else {
        await this.#storage.copyObject(key, dest)
        await this.#storage.deleteObject(key)
      }
      this.#ui.toast(t('renameSuccess', { name: newName }), 'success')
      if (isFolder) this.#explorer.invalidateCache(key)
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async copy(key, isFolder) {
    const name = extractFileName(key)
    const currentPrefix = this.#explorer.currentPrefix

    const dest = await this.#ui.prompt(t('copyTitle'), t('copyLabel'), currentPrefix + name + (isFolder ? '/' : ''), {
      hint: isFolder ? t('copyFolderHint') : undefined,
      validate: (v) => {
        if (!v.trim()) return t('fileNameRequired')
        const illegal = v.match(/[\\:*?"<>|\x00-\x1F]/g)
        if (illegal) return t('pathInvalidChars', { chars: [...new Set(illegal)].join('  ') })
        if (v === key) return t('copySamePath')
        if (isFolder) {
          const folderDest = v.endsWith('/') ? v : v + '/'
          if (folderDest.startsWith(key)) return t('folderIntoItself')
        }
        return null
      },
    })
    if (!dest) return

    try {
      if (!(await this.#confirmReplace(isFolder ? dest.replace(/\/+$/, '') + '/' : dest, isFolder))) return

      this.#ui.toast(t('copying', { name, destName: dest }), 'info')

      if (isFolder) {
        const destFolder = dest.endsWith('/') ? dest : dest + '/'
        await this.#storage.createFolder(destFolder)
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            await this.#storage.copyObject(srcKey, destFolder + relative)
          },
          false,
        )
      } else {
        await this.#storage.copyObject(key, dest)
      }
      this.#ui.toast(t('copySuccess', { name: dest }), 'success')
      const destPrefix = dest.substring(0, dest.lastIndexOf('/') + 1)
      if (isFolder) this.#explorer.invalidateCache()
      else this.#explorer.invalidateCache(destPrefix)
      if (destPrefix.startsWith(this.#explorer.currentPrefix)) await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async move(key, isFolder) {
    const name = extractFileName(key)
    const currentPrefix = this.#explorer.currentPrefix

    /** @param {string} v */
    const resolveDest = (v) => FileOperations.#toFolderPrefix(v) + name + (isFolder ? '/' : '')

    const destFolder = await this.#ui.prompt(t('moveTitle'), t('moveLabel'), currentPrefix, {
      preview: (v) => '→ ' + resolveDest(v),
      validate: (v) => {
        const dest = resolveDest(v)
        if (dest === key) return t('moveSamePath')
        if (isFolder && dest.startsWith(key)) return t('folderIntoItself')
        return null
      },
    })

    if (destFolder === null) return

    const dest = resolveDest(destFolder)

    if (dest === key) return

    try {
      if (!(await this.#confirmReplace(dest, isFolder))) return

      this.#ui.toast(t('moving', { name, destName: dest }), 'info')

      if (isFolder) {
        await this.#storage.createFolder(dest)
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            await this.#storage.copyObject(srcKey, dest + relative)
          },
          true,
        )
      } else {
        await this.#storage.copyObject(key, dest)
        await this.#storage.deleteObject(key)
      }
      this.#ui.toast(t('moveSuccess', { name: dest }), 'success')
      if (isFolder) this.#explorer.invalidateCache()
      else this.#explorer.invalidateCache(dest.substring(0, dest.lastIndexOf('/') + 1))
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async delete(key, isFolder) {
    const name = extractFileName(key)
    const msg = isFolder ? t('deleteFolderConfirmMsg', { name }) : t('deleteConfirmMsg', { name })

    const ok = await this.#ui.confirm(t('deleteConfirmTitle'), msg)
    if (!ok) return

    try {
      this.#ui.toast(t('deleting', { name }), 'info')

      if (isFolder) {
        await this.#deleteFolder(key)
      } else {
        await this.#storage.deleteObject(key)
      }
      this.#ui.toast(t('deleteSuccess', { name }), 'success')
      if (isFolder) this.#explorer.invalidateCache(key)
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   *
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async deleteMany(items) {
    const count = items.length
    const ok = await this.#ui.confirm(t('batchDeleteTitle'), t('batchDeleteConfirmMsg', { count }))
    if (!ok) return false

    this.#ui.toast(t('batchDeleting', { count }), 'info')
    const results = await runLimited(items, 4, async (item) => {
      try {
        if (item.isFolder) await this.#deleteFolder(item.key)
        else await this.#storage.deleteObject(item.key)
        return true
      } catch {
        return false
      }
    })
    const success = results.filter(Boolean).length
    const fail = results.length - success

    this.#ui.toast(
      fail === 0 ? t('batchDeleteSuccess', { count: success }) : t('batchDeletePartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache(this.#explorer.currentPrefix)
    await this.#explorer.refresh()
    return true
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async moveMany(items) {
    const count = items.length
    const currentPrefix = this.#explorer.currentPrefix

    const destFolder = await this.#ui.prompt(t('batchMoveTitle'), t('batchMoveLabel'), currentPrefix, {
      validate: (v) => {
        const folder = FileOperations.#toFolderPrefix(v)
        const allSame = items.every((item) => {
          const name = extractFileName(item.key)
          return folder + name + (item.isFolder ? '/' : '') === item.key
        })
        if (allSame) return t('batchMoveSamePath')
        const intoItself = items.some((item) => {
          if (!item.isFolder) return false
          const dest = folder + extractFileName(item.key) + '/'
          return dest.startsWith(item.key)
        })
        return intoItself ? t('folderIntoItself') : null
      },
    })
    if (destFolder === null) return false

    const folder = FileOperations.#toFolderPrefix(destFolder)
    if (!(await this.#confirmBatchReplace(items, folder))) return false

    this.#ui.toast(t('batchMoving', { count }), 'info')
    const results = await runLimited(items, 2, async (item) => {
      const name = extractFileName(item.key)
      const dest = folder + name + (item.isFolder ? '/' : '')
      if (dest === item.key) return true

      try {
        if (item.isFolder) {
          await this.#storage.createFolder(dest)
          await this.#recursiveOperation(
            item.key,
            async (/** @type {string} */ srcKey) => {
              await this.#storage.copyObject(srcKey, dest + srcKey.substring(item.key.length))
            },
            true,
          )
        } else {
          await this.#storage.copyObject(item.key, dest)
          await this.#storage.deleteObject(item.key)
        }
        return true
      } catch {
        return false
      }
    })
    const success = results.filter(Boolean).length
    const fail = results.length - success

    this.#ui.toast(
      fail === 0
        ? t('batchMoveSuccess', { count: success, dest: folder || '/' })
        : t('batchMovePartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache()
    await this.#explorer.refresh()
    return true
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async copyMany(items) {
    const count = items.length
    const currentPrefix = this.#explorer.currentPrefix

    const destFolder = await this.#ui.prompt(t('batchCopyTitle'), t('batchCopyLabel'), currentPrefix, {
      validate: (v) => {
        const folder = FileOperations.#toFolderPrefix(v)
        const allSame = items.every((item) => {
          const name = extractFileName(item.key)
          return folder + name + (item.isFolder ? '/' : '') === item.key
        })
        if (allSame) return t('batchCopySamePath')
        const intoItself = items.some((item) => {
          if (!item.isFolder) return false
          const dest = folder + extractFileName(item.key) + '/'
          return dest.startsWith(item.key)
        })
        return intoItself ? t('folderIntoItself') : null
      },
    })
    if (destFolder === null) return false

    const folder = FileOperations.#toFolderPrefix(destFolder)
    if (!(await this.#confirmBatchReplace(items, folder))) return false

    this.#ui.toast(t('batchCopying', { count }), 'info')
    const results = await runLimited(items, 2, async (item) => {
      const name = extractFileName(item.key)
      const dest = folder + name + (item.isFolder ? '/' : '')
      if (dest === item.key) return true

      try {
        if (item.isFolder) {
          await this.#storage.createFolder(dest)
          await this.#recursiveOperation(
            item.key,
            async (/** @type {string} */ srcKey) => {
              await this.#storage.copyObject(srcKey, dest + srcKey.substring(item.key.length))
            },
            false,
          )
        } else {
          await this.#storage.copyObject(item.key, dest)
        }
        return true
      } catch {
        return false
      }
    })
    const success = results.filter(Boolean).length
    const fail = results.length - success

    this.#ui.toast(
      fail === 0
        ? t('batchCopySuccess', { count: success, dest: folder || '/' })
        : t('batchCopyPartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache()
    await this.#explorer.refresh()
    return true
  }

  /** @param {string} key */
  async editContentType(key) {
    const name = extractFileName(key)
    let currentType = ''
    try {
      const head = await this.#storage.headObject(key)
      currentType = head.contentType ?? ''
    } catch {}

    const newType = await this.#ui.prompt(t('editContentTypeTitle'), t('editContentTypeLabel'), currentType, {
      validate: (v) => {
        if (v.trim() && !v.includes('/')) return t('editContentTypeInvalid')
        return null
      },
    })
    if (newType === null || newType.trim() === currentType.trim()) return

    try {
      this.#ui.toast(t('editingContentType', { name }), 'info')
      await this.#storage.updateContentType(key, newType.trim())
      this.#ui.toast(t('editContentTypeSuccess', { name, type: newType.trim() }), 'success')
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key */
  async download(key) {
    try {
      const url = await this.#storage.getDownloadUrl(key, extractFileName(key))
      const a = document.createElement('a')
      a.href = url
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {'path'|'url'|'markdown'|'html'} format */
  async copyAs(key, format) {
    const name = extractFileName(key)
    const isImage = IMAGE_RE.test(key)
    const isVideo = VIDEO_RE.test(key)
    const isAudio = AUDIO_RE.test(key)

    if (format === 'path') {
      try {
        await navigator.clipboard.writeText(key)
        this.#ui.toast(t('linkCopied'), 'success')
      } catch {
        await this.#ui.prompt(t('copyLink'), '', key)
      }
      return
    }

    const url = this.#storage.getPublicUrl(key)

    let text
    switch (format) {
      case 'markdown':
        text = isImage ? `![${name}](${url})` : `[${name}](${url})`
        break
      case 'html':
        if (isImage) text = `<img src="${url}" alt="${name}">`
        else if (isVideo) text = `<video src="${url}" controls></video>`
        else if (isAudio) text = `<audio src="${url}" controls></audio>`
        else text = `<a href="${url}">${name}</a>`
        break
      default:
        text = url
        break
    }

    try {
      await navigator.clipboard.writeText(text)
      this.#ui.toast(t('linkCopied'), 'success')
    } catch {
      await this.#ui.prompt(t('copyLink'), '', text)
    }
  }

  /** @param {string} key */
  async copyImage(key) {
    if (!IMAGE_RE.test(key)) {
      this.#ui.toast(t('copyImageNotSupportedType'), 'error')
      return
    }
    if (!navigator.clipboard || !window.ClipboardItem) {
      this.#ui.toast(t('copyImageNotSupported'), 'error')
      return
    }
    try {
      const url = this.#storage.getPublicUrl(key)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (!blob.type.startsWith('image/')) throw new Error('Not an image')
      const pngBlob = blob.type === 'image/png' ? blob : await imageToPng(blob)
      const item = new ClipboardItem({ 'image/png': pngBlob })
      await navigator.clipboard.write([item])
      this.#ui.toast(t('copyImageSuccess'), 'success')
    } catch {
      this.#ui.toast(t('copyImageFailed'), 'error')
    }
  }

  /** @param {string} key */
  async shareQr(key) {
    await this.#ui.showFileQrDialog(this.#storage.getPublicUrl(key), extractFileName(key))
  }

  /**
   * Create a read-only share link via the bundled local server.
   * @param {string} key
   */
  async shareLink(key) {
    const name = extractFileName(key) || t('root')
    await this.#ui.showShareLinkDialog({
      name,
      create: async (expiresIn) => {
        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, expiresIn }),
        })
        if (response.status === 401) {
          // The session expired while the app was open; send the user back to
          // the sign-in page instead of showing a generic share error.
          window.location.replace('/login')
          return new Promise(() => {})
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = /** @type {{ path: string, expiresAt: number | null }} */ (await response.json())
        return { url: new URL(data.path, window.location.origin).toString(), expiresAt: data.expiresAt }
      },
    })
  }

  /** @param {string} prefix @param {(key: string) => Promise<void>} operation @param {boolean} deleteSource */
  async #recursiveOperation(prefix, operation, deleteSource) {
    const allKeys = await this.#collectAllKeys(prefix)

    for (let i = 0; i < allKeys.length; i += 5) {
      const batch = allKeys.slice(i, i + 5)
      await Promise.all(batch.map((k) => operation(k)))
    }

    if (deleteSource) {
      // The bundled server removes a directory recursively in one request.
      try {
        await this.#storage.deleteObject(prefix)
        return
      } catch {
        /* fall back to deleting each object */
      }
      for (let i = 0; i < allKeys.length; i += 5) {
        const batch = allKeys.slice(i, i + 5)
        await Promise.all(batch.map((k) => this.#storage.deleteObject(k)))
      }
      try {
        await this.#storage.deleteObject(prefix)
      } catch {}
    }
  }

  /** @param {string} prefix @returns {Promise<string[]>} */
  async #collectAllKeys(prefix) {
    /** @type {string[]} */
    const keys = []
    let token = ''
    do {
      const result = await this.#storage.listAllObjects(prefix, token)
      keys.push(...result.files.map((file) => file.key))
      token = result.isTruncated ? result.nextToken : ''
    } while (token)
    return keys
  }
}

export { FileOperations }
