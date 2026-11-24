import { PAGE_SIZE } from './constants.js'
import { encodeS3Key } from './utils.js'
import { ConfigManager } from './config-manager.js'

/** @typedef {{ key: string; isFolder: boolean; size?: number; lastModified?: string }} FileItem */

/**
 * Client for the object API exposed by the bundled local server (`/s3/...`).
 * All requests are same-origin and authenticated with the session cookie, so
 * there is no request signing, no credentials and no cross-origin setup.
 */
class StorageClient {
  /** @type {ConfigManager | null} */
  #config = null

  /** @param {ConfigManager} configManager */
  init(configManager) {
    this.#config = configManager
  }

  /** @param {string} key @returns {string} */
  #objectUrl(key) {
    return `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
  }

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async #fetch(url, init) {
    const res = await fetch(url, { cache: 'no-store', ...init })
    // The bundled server requires a login session. Send the user back to the
    // sign-in page when it has expired mid-session, and keep pending
    // operations from surfacing an error while the page unloads.
    if (res.status === 401) {
      window.location.replace('/login')
      return new Promise(() => {})
    }
    return res
  }

  /** @param {string} [prefix] @param {string} [continuationToken] */
  async listObjects(prefix = '', continuationToken = '') {
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('delimiter', '/')
    url.searchParams.set('max-keys', String(PAGE_SIZE))
    if (prefix) url.searchParams.set('prefix', prefix)
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

    const res = await this.#fetch(url.toString())
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }

    const text = await res.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')

    /** @type {FileItem[]} */
    const folders = [...doc.querySelectorAll('CommonPrefixes > Prefix')].map((el) => ({
      key: el.textContent ?? '',
      isFolder: true,
    }))

    /** @type {FileItem[]} */
    const files = [...doc.querySelectorAll('Contents')]
      .map((el) => ({
        key: el.querySelector('Key')?.textContent ?? '',
        size: parseInt(el.querySelector('Size')?.textContent ?? '0', 10),
        lastModified: el.querySelector('LastModified')?.textContent ?? '',
        isFolder: false,
      }))
      .filter((f) => f.key !== prefix)

    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true'
    const nextToken = doc.querySelector('NextContinuationToken')?.textContent || ''

    return { folders, files, isTruncated, nextToken }
  }

  /**
   * List every object under a prefix without a delimiter (no CommonPrefixes).
   * The bundled server answers this with one recursive walk, which makes a
   * folder move/copy cost a single request per page instead of one per
   * subfolder.
   * @param {string} [prefix]
   * @param {string} [continuationToken]
   * @returns {Promise<{ files: FileItem[], isTruncated: boolean, nextToken: string }>}
   */
  async listAllObjects(prefix = '', continuationToken = '') {
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('max-keys', String(PAGE_SIZE))
    if (prefix) url.searchParams.set('prefix', prefix)
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

    const res = await this.#fetch(url.toString())
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const files = [...doc.querySelectorAll('Contents')].map((el) => ({
      key: el.querySelector('Key')?.textContent ?? '',
      size: parseInt(el.querySelector('Size')?.textContent ?? '0', 10),
      lastModified: el.querySelector('LastModified')?.textContent ?? '',
      isFolder: false,
    }))
    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true'
    const nextToken = doc.querySelector('NextContinuationToken')?.textContent || ''
    return { files, isTruncated, nextToken }
  }

  /**
   * Check whether an object exists with a single HEAD request.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    const res = await this.#fetch(this.#objectUrl(key), { method: 'HEAD' })
    if (res.status === 404) return false
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      throw new Error(`HTTP ${res.status}`)
    }
    return true
  }

  /** @param {string} key @param {string} contentType @param {Blob} body */
  putObject(key, contentType, body) {
    return { url: this.#objectUrl(key), headers: { 'Content-Type': contentType }, body }
  }

  /** @param {string} key @param {string} contentType */
  async createMultipartUpload(key, contentType) {
    const url = new URL(this.#objectUrl(key))
    url.searchParams.set('uploads', '')
    const res = await this.#fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const uploadId = doc.querySelector('UploadId')?.textContent
    if (!uploadId) throw new Error('The server did not return a multipart upload ID')
    return uploadId
  }

  /** @param {string} key @param {string} uploadId @param {number} partNumber @param {Blob} body */
  uploadPart(key, uploadId, partNumber, body) {
    const url = new URL(this.#objectUrl(key))
    url.searchParams.set('partNumber', String(partNumber))
    url.searchParams.set('uploadId', uploadId)
    return { url: url.toString(), headers: {}, body }
  }

  /** @param {string} key @param {string} uploadId @param {{ partNumber: number; etag: string }[]} parts */
  async completeMultipartUpload(key, uploadId, parts) {
    const url = new URL(this.#objectUrl(key))
    url.searchParams.set('uploadId', uploadId)
    const body = `<CompleteMultipartUpload>${parts
      .map(({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`
    const res = await this.#fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    })
    const text = await res.text()
    if (!res.ok || new DOMParser().parseFromString(text, 'application/xml').querySelector('Error')) {
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} uploadId */
  async abortMultipartUpload(key, uploadId) {
    const url = new URL(this.#objectUrl(key))
    url.searchParams.set('uploadId', uploadId)
    const res = await this.#fetch(url.toString(), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  }

  /**
   * @param {string} [keyMarker]
   * @param {string} [uploadIdMarker]
   */
  async listMultipartUploads(keyMarker = '', uploadIdMarker = '') {
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('uploads', '')
    url.searchParams.set('max-uploads', '1000')
    if (keyMarker) url.searchParams.set('key-marker', keyMarker)
    if (uploadIdMarker) url.searchParams.set('upload-id-marker', uploadIdMarker)

    const res = await this.#fetch(url.toString())
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const uploads = [...doc.querySelectorAll('Upload')]
      .map((item) => ({
        key: item.querySelector('Key')?.textContent ?? '',
        uploadId: item.querySelector('UploadId')?.textContent ?? '',
      }))
      .filter((item) => item.key && item.uploadId)

    return {
      uploads,
      isTruncated: doc.querySelector('IsTruncated')?.textContent === 'true',
      nextKeyMarker: doc.querySelector('NextKeyMarker')?.textContent ?? '',
      nextUploadIdMarker: doc.querySelector('NextUploadIdMarker')?.textContent ?? '',
    }
  }

  async abortAllMultipartUploads() {
    /** @type {{ key: string; uploadId: string }[]} */
    const uploads = []
    let keyMarker = ''
    let uploadIdMarker = ''

    while (true) {
      const page = await this.listMultipartUploads(keyMarker, uploadIdMarker)
      uploads.push(...page.uploads)
      if (!page.isTruncated) break
      if (page.nextKeyMarker === keyMarker && page.nextUploadIdMarker === uploadIdMarker) {
        throw new Error('The server returned invalid multipart upload pagination markers')
      }
      keyMarker = page.nextKeyMarker
      uploadIdMarker = page.nextUploadIdMarker
    }

    let nextIndex = 0
    let succeeded = 0
    let failed = 0
    const worker = async () => {
      while (nextIndex < uploads.length) {
        const upload = uploads[nextIndex++]
        let cleaned = false
        for (let attempt = 0; attempt < 3 && !cleaned; attempt++) {
          try {
            await this.abortMultipartUpload(upload.key, upload.uploadId)
            cleaned = true
          } catch {
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
          }
        }
        if (cleaned) succeeded++
        else failed++
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, uploads.length) }, worker))
    return { total: uploads.length, succeeded, failed }
  }

  /** @param {string} key */
  async getObject(key) {
    const res = await this.#fetch(this.#objectUrl(key))
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
    return res
  }

  /**
   * Read at most `maxBytes` of a text object. Keeps a huge log file from being
   * pulled into memory just to render a preview.
   * @param {string} key
   * @param {number} maxBytes
   * @returns {Promise<{ text: string, truncated: boolean }>}
   */
  async getObjectText(key, maxBytes) {
    const res = await this.#fetch(this.#objectUrl(key), {
      headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()
    const range = res.headers.get('content-range') || ''
    const total = Number(/\/(\d+)$/.exec(range)?.[1] ?? 0)
    // `total` is 0 when the endpoint ignored the Range header; also cap by the
    // decoded length so a non-Range server cannot blow up memory either.
    const truncated = total > maxBytes || text.length > maxBytes
    return { text: text.length > maxBytes ? text.slice(0, maxBytes) : text, truncated }
  }

  /** @param {string} key */
  getPublicUrl(key) {
    return this.#objectUrl(key)
  }

  /** @param {string} key */
  async headObject(key) {
    const res = await this.#fetch(this.#objectUrl(key), { method: 'HEAD' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {
      contentType: res.headers.get('content-type'),
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      lastModified: res.headers.get('last-modified'),
      etag: res.headers.get('etag'),
    }
  }

  /** @param {string} key */
  async deleteObject(key) {
    const res = await this.#fetch(this.#objectUrl(key), { method: 'DELETE' })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} src @param {string} dest */
  async copyObject(src, dest) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const res = await this.#fetch(this.#objectUrl(dest), {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(src)}`,
      },
    })
    // The server can return 200 OK with an <Error> document.
    const text = await res.text()
    if (!res.ok || new DOMParser().parseFromString(text, 'application/xml').querySelector('Error')) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} contentType */
  async updateContentType(key, contentType) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const res = await this.#fetch(this.#objectUrl(key), {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(key)}`,
        'x-amz-metadata-directive': 'REPLACE',
        'Content-Type': contentType,
      },
    })
    const text = await res.text()
    if (!res.ok || new DOMParser().parseFromString(text, 'application/xml').querySelector('Error')) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} prefix */
  async createFolder(prefix) {
    const res = await this.#fetch(this.#objectUrl(prefix.endsWith('/') ? prefix : `${prefix}/`), {
      method: 'PUT',
      headers: { 'Content-Length': '0' },
      body: '',
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} filename */
  getDownloadUrl(key, filename) {
    const url = new URL(this.#objectUrl(key))
    const clean = filename.replace(/[\r\n]/g, ' ').trim() || 'download'
    const fallback = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    const encoded = encodeURIComponent(clean).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    )
    return url.toString()
  }
}

export { StorageClient }
