const I18N = {
  zh: {
    readOnly: '只读分享',
    loading: '正在加载…',
    invalidTitle: '分享链接无效或已过期',
    invalidDesc: '请向分享者索取新的链接。',
    unavailableTitle: '内容不可用',
    unavailableDesc: '分享的内容可能已被移动或删除。',
    loadFailedTitle: '加载失败',
    loadFailedDesc: '网络错误，请稍后重试。',
    retry: '重试',
    emptyFolder: '这个目录是空的',
    rootName: '共享文件',
    expiresAt: '有效期至 {date}',
    neverExpires: '永久有效',
    folder: '文件夹',
    file: '文件',
    modified: '修改时间',
    size: '大小',
    type: '类型',
    download: '下载',
    back: '返回',
    breadcrumb: '位置',
    loadMore: '加载更多',
    openFolder: '打开文件夹',
    previewUnavailable: '此文件类型不支持在线预览，请下载后查看。',
    textTruncated: '文件较大，仅显示前 256 KB。',
    imageError: '预览失败',
  },
  zh_TW: {
    readOnly: '唯讀分享',
    loading: '正在載入…',
    invalidTitle: '分享連結無效或已過期',
    invalidDesc: '請向分享者索取新的連結。',
    unavailableTitle: '內容無法使用',
    unavailableDesc: '分享的內容可能已被移動或刪除。',
    loadFailedTitle: '載入失敗',
    loadFailedDesc: '網路錯誤，請稍後再試。',
    retry: '重試',
    emptyFolder: '這個目錄是空的',
    rootName: '共用檔案',
    expiresAt: '有效期限至 {date}',
    neverExpires: '永久有效',
    folder: '資料夾',
    file: '檔案',
    modified: '修改時間',
    size: '大小',
    type: '類型',
    download: '下載',
    back: '返回',
    breadcrumb: '位置',
    loadMore: '載入更多',
    openFolder: '開啟資料夾',
    previewUnavailable: '此檔案類型不支援線上預覽，請下載後檢視。',
    textTruncated: '檔案較大，僅顯示前 256 KB。',
    imageError: '預覽失敗',
  },
  en: {
    readOnly: 'Read-only share',
    loading: 'Loading…',
    invalidTitle: 'This share link is invalid or has expired',
    invalidDesc: 'Ask the person who shared it for a new link.',
    unavailableTitle: 'Content unavailable',
    unavailableDesc: 'The shared content may have been moved or deleted.',
    loadFailedTitle: 'Failed to load',
    loadFailedDesc: 'Network error. Please try again.',
    retry: 'Retry',
    emptyFolder: 'This folder is empty',
    rootName: 'Shared files',
    expiresAt: 'Valid until {date}',
    neverExpires: 'No expiration',
    folder: 'Folder',
    file: 'File',
    modified: 'Modified',
    size: 'Size',
    type: 'Type',
    download: 'Download',
    back: 'Back',
    breadcrumb: 'Breadcrumb',
    loadMore: 'Load more',
    openFolder: 'Open folder',
    previewUnavailable: 'This file type cannot be previewed. Download it to view.',
    textTruncated: 'Large file — showing the first 256 KB only.',
    imageError: 'Preview failed',
  },
  ja: {
    readOnly: '読み取り専用',
    loading: '読み込み中…',
    invalidTitle: '共有リンクが無効か期限切れです',
    invalidDesc: '共有した人に新しいリンクを依頼してください。',
    unavailableTitle: 'コンテンツを利用できません',
    unavailableDesc: '共有されたコンテンツは移動または削除された可能性があります。',
    loadFailedTitle: '読み込みに失敗しました',
    loadFailedDesc: '通信エラーが発生しました。しばらくしてから再試行してください。',
    retry: '再試行',
    emptyFolder: 'このフォルダは空です',
    rootName: '共有ファイル',
    expiresAt: '有効期限: {date}',
    neverExpires: '無期限',
    folder: 'フォルダ',
    file: 'ファイル',
    modified: '更新日時',
    size: 'サイズ',
    type: '種類',
    download: 'ダウンロード',
    back: '戻る',
    breadcrumb: '場所',
    loadMore: 'さらに読み込む',
    openFolder: 'フォルダを開く',
    previewUnavailable: 'この種類のファイルはプレビューできません。ダウンロードして確認してください。',
    textTruncated: 'ファイルが大きいため、先頭 256 KB のみ表示しています。',
    imageError: 'プレビューに失敗しました',
  },
}

const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i
const VIDEO_PATTERN = /\.(mp4|webm|mov|m4v|ogv)$/i
const AUDIO_PATTERN = /\.(mp3|wav|ogg|flac|aac|m4a|opus)$/i
const TEXT_PATTERN =
  /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|csv|tsv|log|yml|yaml|ini|conf|toml|sh|bash|py|rb|go|rs|java|c|h|cpp|hpp|sql|env)$/i
const TEXT_PREVIEW_BYTES = 256 * 1024

const ICONS = {
  folder:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>',
  file: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>',
  fileLarge:
    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>',
  download:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>',
}

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/** @returns {'zh' | 'zh_TW' | 'en' | 'ja'} */
function pickLanguage() {
  const candidates =
    navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']
  for (const candidate of candidates) {
    const value = String(candidate).toLowerCase()
    if (value.startsWith('ja')) return 'ja'
    if (value.includes('zh-tw') || value.includes('zh-hant') || value.includes('zh-hk')) return 'zh_TW'
    if (value.startsWith('zh')) return 'zh'
    if (value.startsWith('en')) return 'en'
  }
  return 'en'
}

const lang = pickLanguage()
/** @type {Record<string, string>} */
const copy = I18N[lang]
document.documentElement.lang = lang === 'zh_TW' ? 'zh-Hant' : lang

class ShareRequestError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'ShareRequestError'
    this.status = status
  }
}

/**
 * @typedef {{ type: 'file' | 'dir', name: string, key: string, size: number | null, lastModified: string, expiresAt: number | null, contentType?: string }} ShareMetadata
 * @typedef {{ name: string, path: string, isFolder: boolean, size: number, lastModified: string | null, contentType?: string }} ShareEntry
 * @typedef {{ path: string, entries: ShareEntry[], isTruncated: boolean, nextToken: string }} ShareListResponse
 */

const state = {
  /** @type {ShareMetadata | null} */
  meta: null,
  /** @type {ShareEntry | null} */
  file: null,
  dirPath: '',
  /** @type {ShareEntry[]} */
  entries: [],
  nextToken: '',
}

let loadSequence = 0
let previewSequence = 0

const token = (() => {
  if (!location.pathname.startsWith('/share/')) return ''
  const raw = location.pathname.slice('/share/'.length).replace(/\/+$/, '')
  if (!raw || raw.includes('/')) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
})()
const apiBase = `/api/share/${encodeURIComponent(token)}`

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function apiRequest(path) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    /* non-JSON error responses */
  }
  if (!response.ok) {
    const message = data && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
    throw new ShareRequestError(response.status, message)
  }
  return data
}

function applyStaticCopy() {
  $('share-badge').textContent = copy.readOnly
  $('loading-label').textContent = copy.loading
  $('back-label').textContent = copy.back
  $('footer-note').textContent = copy.readOnly
  $('share-download-label').textContent = copy.download
  const loadMore = /** @type {HTMLButtonElement} */ ($('load-more'))
  loadMore.textContent = copy.loadMore
  $('breadcrumb').setAttribute('aria-label', copy.breadcrumb)
}

/**
 * @param {string | number | null} value
 */
function formatDate(value) {
  if (value == null || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const locale = lang === 'zh_TW' ? 'zh-TW' : lang
  try {
    return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return date.toLocaleString()
  }
}

/** @param {number | null} bytes */
function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}

function expiryText() {
  if (!state.meta) return ''
  if (!state.meta.expiresAt) return copy.neverExpires
  return copy.expiresAt.replace('{date}', formatDate(state.meta.expiresAt))
}

/** @param {string} text */
function setHeading(text) {
  $('share-name').textContent = text
}

/** @param {boolean} show */
function setLoading(show) {
  $('loading').hidden = !show
}

/**
 * @param {string} title
 * @param {string} description
 * @param {boolean} retry
 */
function showError(title, description, retry) {
  for (const id of ['loading', 'file-view', 'dir-view', 'breadcrumb']) $(id).hidden = true
  $('share-download').hidden = true
  setHeading(title)
  $('share-meta').textContent = ''
  document.title = `${title} · Web-FileSystem`

  const notice = $('notice')
  notice.replaceChildren()
  const heading = document.createElement('strong')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.textContent = description
  notice.append(heading, paragraph)
  if (retry) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn'
    button.textContent = copy.retry
    button.addEventListener('click', () => location.reload())
    notice.append(button)
  }
  notice.hidden = false
}

function hideNotice() {
  $('notice').hidden = true
}

/** @param {string} path @param {boolean} download */
function objectUrl(path, download) {
  const endpoint = `${apiBase}/${download ? 'download' : 'content'}`
  return path ? `${endpoint}?path=${encodeURIComponent(path)}` : endpoint
}

/** @param {string} extraLabel */
function renderBreadcrumb(extraLabel = '') {
  const nav = $('breadcrumb')
  nav.replaceChildren()

  const segments = state.dirPath ? state.dirPath.split('/') : []
  const rootLabel = (state.meta && state.meta.name) || copy.rootName
  const rootIsCurrent = segments.length === 0 && !extraLabel

  if (rootIsCurrent) {
    const current = document.createElement('span')
    current.className = 'crumb current'
    current.textContent = rootLabel
    nav.append(current)
  } else {
    const root = document.createElement('button')
    root.type = 'button'
    root.className = 'crumb'
    root.textContent = rootLabel
    root.addEventListener('click', () => void loadDirectory(''))
    nav.append(root)
  }

  let accumulated = ''
  segments.forEach((segment, index) => {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    const separator = document.createElement('span')
    separator.className = 'crumb-sep'
    separator.setAttribute('aria-hidden', 'true')
    separator.textContent = '/'
    nav.append(separator)

    if (index === segments.length - 1 && !extraLabel) {
      const current = document.createElement('span')
      current.className = 'crumb current'
      current.textContent = segment
      nav.append(current)
    } else {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'crumb'
      button.textContent = segment
      button.addEventListener('click', () => void loadDirectory(accumulated))
      nav.append(button)
    }
  })

  if (extraLabel) {
    const separator = document.createElement('span')
    separator.className = 'crumb-sep'
    separator.setAttribute('aria-hidden', 'true')
    separator.textContent = '/'
    nav.append(separator)

    const current = document.createElement('span')
    current.className = 'crumb current'
    current.textContent = extraLabel
    nav.append(current)
  }

  nav.hidden = false
}

/** @param {ShareEntry} entry */
function createEntryRow(entry) {
  const row = document.createElement('div')
  row.className = 'entry'

  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'entry-main'
  main.setAttribute('aria-label', entry.isFolder ? `${copy.openFolder}: ${entry.name}` : entry.name)

  const icon = document.createElement('span')
  icon.className = entry.isFolder ? 'entry-icon folder' : 'entry-icon'
  icon.innerHTML = entry.isFolder ? ICONS.folder : ICONS.file

  const text = document.createElement('span')
  text.className = 'entry-text'

  const name = document.createElement('span')
  name.className = 'entry-name'
  name.textContent = entry.name

  const sub = document.createElement('span')
  sub.className = 'entry-sub'
  sub.textContent = entry.isFolder
    ? copy.folder
    : [formatSize(entry.size), formatDate(entry.lastModified)].filter(Boolean).join(' · ')

  text.append(name, sub)
  main.append(icon, text)
  main.addEventListener('click', () => {
    if (entry.isFolder) void loadDirectory(entry.path)
    else openFile(entry, false)
  })
  row.append(main)

  if (!entry.isFolder) {
    const download = document.createElement('a')
    download.className = 'entry-download'
    download.href = objectUrl(entry.path, true)
    download.download = entry.name
    download.title = copy.download
    download.setAttribute('aria-label', `${copy.download}: ${entry.name}`)
    download.innerHTML = ICONS.download
    row.append(download)
  }

  return row
}

function renderEntries() {
  const list = $('entry-list')
  list.replaceChildren()
  if (!state.entries.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = copy.emptyFolder
    list.append(empty)
  } else {
    for (const entry of state.entries) list.append(createEntryRow(entry))
  }
  const loadMore = /** @type {HTMLButtonElement} */ ($('load-more'))
  loadMore.hidden = !state.nextToken
  loadMore.disabled = false
}

function renderDirectory() {
  if (!state.meta) return
  hideNotice()
  $('file-view').hidden = true
  $('dir-view').hidden = false
  $('share-download').hidden = true
  setHeading(state.meta.name || copy.rootName)
  $('share-meta').textContent = expiryText()
  document.title = `${state.meta.name || copy.rootName} · Web-FileSystem`
  renderBreadcrumb()
  renderEntries()
}

/**
 * @param {string} path
 * @param {boolean} [append]
 */
async function loadDirectory(path, append = false) {
  if (!state.meta || state.meta.type !== 'dir') return
  const sequence = ++loadSequence
  state.file = null

  if (!append) {
    $('file-view').hidden = true
    $('dir-view').hidden = true
    $('breadcrumb').hidden = true
    hideNotice()
  }
  $('share-download').hidden = true
  setLoading(true)

  const query = new URLSearchParams({ path, limit: '100' })
  if (append && state.nextToken) query.set('cursor', state.nextToken)

  try {
    const data = /** @type {ShareListResponse} */ (await apiRequest(`/list?${query.toString()}`))
    if (sequence !== loadSequence) return
    state.dirPath = data.path
    state.entries = append ? [...state.entries, ...data.entries] : data.entries
    state.nextToken = data.nextToken || ''
    renderDirectory()
  } catch (error) {
    if (sequence !== loadSequence) return
    const status = error instanceof ShareRequestError ? error.status : 0
    if (status === 400 || status === 404) {
      showError(copy.unavailableTitle, copy.unavailableDesc, false)
    } else {
      showError(copy.loadFailedTitle, copy.loadFailedDesc, true)
    }
  } finally {
    if (sequence === loadSequence) setLoading(false)
  }
}

/** @param {HTMLElement} container */
function renderPreviewFallback(container) {
  container.replaceChildren()
  const wrap = document.createElement('div')
  wrap.className = 'preview-empty'
  const icon = document.createElement('div')
  icon.innerHTML = ICONS.fileLarge
  const message = document.createElement('p')
  message.textContent = copy.previewUnavailable
  wrap.append(icon, message)
  container.append(wrap)
}

/** @param {HTMLElement} container */
function previewFailed(container) {
  container.replaceChildren()
  const wrap = document.createElement('div')
  wrap.className = 'preview-empty'
  const icon = document.createElement('div')
  icon.innerHTML = ICONS.fileLarge
  const message = document.createElement('p')
  message.textContent = copy.imageError
  wrap.append(icon, message)
  container.append(wrap)
}

/**
 * @param {HTMLElement} container
 * @param {string} source
 * @param {ShareEntry} entry
 * @param {number} sequence
 */
async function renderTextPreview(container, source, entry, sequence) {
  const placeholder = document.createElement('div')
  placeholder.className = 'preview-empty'
  placeholder.textContent = copy.loading
  container.replaceChildren(placeholder)

  try {
    const response = await fetch(source, {
      cache: 'no-store',
      headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
    })
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (sequence !== previewSequence) return

    const pre = document.createElement('pre')
    pre.textContent = text
    container.replaceChildren(pre)
    if ((entry.size || 0) > TEXT_PREVIEW_BYTES) {
      const note = document.createElement('p')
      note.className = 'preview-note'
      note.textContent = copy.textTruncated
      container.append(note)
    }
  } catch {
    if (sequence !== previewSequence) return
    renderPreviewFallback(container)
  }
}

/** @param {ShareEntry} entry */
function renderPreview(entry) {
  const sequence = ++previewSequence
  const container = $('preview')
  container.replaceChildren()

  const source = objectUrl(entry.path, false)
  const contentType = (entry.contentType || '').toLowerCase()
  const name = entry.name

  if (contentType.startsWith('image/') || IMAGE_PATTERN.test(name)) {
    const image = new Image()
    image.alt = name
    image.decoding = 'async'
    image.addEventListener('error', () => {
      if (sequence === previewSequence) previewFailed(container)
    })
    image.src = source
    container.append(image)
    return
  }

  if (contentType.startsWith('video/') || VIDEO_PATTERN.test(name)) {
    const video = document.createElement('video')
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    video.addEventListener('error', () => {
      if (sequence === previewSequence) previewFailed(container)
    })
    video.src = source
    container.append(video)
    return
  }

  if (contentType.startsWith('audio/') || AUDIO_PATTERN.test(name)) {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'metadata'
    audio.addEventListener('error', () => {
      if (sequence === previewSequence) previewFailed(container)
    })
    audio.src = source
    container.append(audio)
    return
  }

  if (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    TEXT_PATTERN.test(name)
  ) {
    void renderTextPreview(container, source, entry, sequence)
    return
  }

  renderPreviewFallback(container)
}

/** @param {string} name */
function fileTypeLabel(name) {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase()
  return copy.file
}

/** @param {ShareEntry} entry */
function renderFileInfo(entry) {
  const info = $('file-info')
  info.replaceChildren()
  const rows = [
    [copy.type, entry.contentType || fileTypeLabel(entry.name)],
    [copy.size, formatSize(entry.size) || '—'],
    [copy.modified, formatDate(entry.lastModified) || '—'],
  ]
  for (const [label, value] of rows) {
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value
    info.append(term, description)
  }
}

/**
 * @param {ShareEntry} entry
 * @param {boolean} isRoot
 */
function openFile(entry, isRoot) {
  state.file = entry
  ++previewSequence
  setLoading(false)

  $('dir-view').hidden = true
  $('file-view').hidden = false

  const download = /** @type {HTMLAnchorElement} */ ($('share-download'))
  download.hidden = false
  download.href = objectUrl(entry.path, true)
  download.download = entry.name

  $('back-button').hidden = isRoot
  if (isRoot) {
    $('breadcrumb').hidden = true
  } else {
    renderBreadcrumb(entry.name)
  }

  setHeading(entry.name)
  const details = [copy.file, formatSize(entry.size), formatDate(entry.lastModified), expiryText()].filter(Boolean)
  $('share-meta').textContent = details.join(' · ')
  document.title = `${entry.name} · Web-FileSystem`

  renderFileInfo(entry)
  renderPreview(entry)
}

function backToDirectory() {
  if (!state.meta || state.meta.type !== 'dir') return
  ++previewSequence
  state.file = null
  $('preview').replaceChildren()
  $('file-info').replaceChildren()
  renderDirectory()
}

async function boot() {
  applyStaticCopy()

  if (!token) {
    showError(copy.invalidTitle, copy.invalidDesc, false)
    return
  }

  try {
    const metadata = /** @type {ShareMetadata} */ (await apiRequest(''))
    state.meta = metadata
    hideNotice()
    setHeading(metadata.name || copy.rootName)
    $('share-meta').textContent = expiryText()

    if (metadata.type === 'file') {
      openFile(
        {
          name: metadata.name,
          path: '',
          isFolder: false,
          size: metadata.size || 0,
          lastModified: metadata.lastModified,
          contentType: metadata.contentType,
        },
        true,
      )
      return
    }

    await loadDirectory('')
  } catch (error) {
    const status = error instanceof ShareRequestError ? error.status : 0
    if (status === 404) showError(copy.invalidTitle, copy.invalidDesc, false)
    else showError(copy.loadFailedTitle, copy.loadFailedDesc, true)
  }
}

$('back-button').addEventListener('click', backToDirectory)
$('load-more').addEventListener('click', () => {
  if (!state.nextToken) return
  const loadMore = /** @type {HTMLButtonElement} */ ($('load-more'))
  loadMore.disabled = true
  void loadDirectory(state.dirPath, true)
})

void boot()
