import dayjs from 'dayjs'
import { IMAGE_RE, VIDEO_RE, AUDIO_RE, DOCUMENT_RE, ARCHIVE_RE, CODE_RE, TEXT_RE } from './constants.js'
import { getCurrentLang } from './i18n.js'

/** @type {<T extends HTMLElement = HTMLElement>(sel: string, ctx?: ParentNode) => T} */
const $ = (sel, ctx = document) => /** @type {*} */ (ctx.querySelector(sel))

/** @param {string|number|Date} dateStr @returns {string} */
function formatDate(dateStr) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const currentLang = getCurrentLang()
  const locale =
    currentLang === 'zh' ? 'zh-CN' : currentLang === 'zh_TW' ? 'zh-TW' : currentLang === 'ja' ? 'ja-JP' : 'en-US'
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** @param {string} key @returns {string} */
function extractFileName(key) {
  const parts = key.replace(/\/$/, '').split('/')
  return parts[parts.length - 1]
}

/** @param {string} key @returns {'image'|'video'|'audio'|'text'|'document'|'archive'|'code'|'file'} */
function getFileType(key) {
  if (IMAGE_RE.test(key)) return 'image'
  if (VIDEO_RE.test(key)) return 'video'
  if (AUDIO_RE.test(key)) return 'audio'
  if (DOCUMENT_RE.test(key)) return 'document'
  if (ARCHIVE_RE.test(key)) return 'archive'
  if (CODE_RE.test(key)) return 'code'
  if (TEXT_RE.test(key)) return 'text'
  return 'file'
}

/** @typedef {'http401Error' | 'http403Error' | 'http404Error' | 'corsError' | 'networkError'} ErrorMessageKey */

/**
 * Get user-friendly error message based on error type
 * @param {Error} err - Error object
 * @returns {ErrorMessageKey} - i18n key for the error message
 */
function getErrorMessage(err) {
  const msg = err.message
  if (msg === 'HTTP_401') return 'http401Error'
  if (msg === 'HTTP_403') return 'http403Error'
  if (msg === 'HTTP_404') return 'http404Error'
  if (err instanceof TypeError && msg.includes('Failed to fetch')) {
    return 'corsError'
  }
  return 'networkError'
}

/** @param {'image'|'video'|'audio'|'text'|'document'|'archive'|'code'|'file'} type @returns {string} */
function getFileIconSvg(type) {
  const svgBase =
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  switch (type) {
    case 'video':
      return `<svg ${svgBase}><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`
    case 'audio':
      return `<svg ${svgBase}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
    case 'document':
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
    case 'archive':
      return `<svg ${svgBase}><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>`
    case 'code':
      return `<svg ${svgBase}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`
    case 'text':
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`
    case 'image':
    default:
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
  }
}

/** @param {string} name @returns {string} */
function getExtension(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1) : ''
}

/** @param {string} name @returns {string} */
function getBaseName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** @param {string} key @returns {string} */
function getMimeType(key) {
  const ext = getExtension(key).toLowerCase()
  /** @type {Record<string, string>} */
  //   export const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|avif)$/i
  // export const COMPRESSIBLE_IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i
  // export const TEXT_RE =
  //   /\.(txt|md|json|xml|csv|html|css|js|ts|jsx|tsx|yaml|yml|toml|ini|cfg|conf|log|sh|bash|py|rb|go|rs|java|c|cpp|h|hpp|sql|env|gitignore|dockerfile)$/i
  // export const AUDIO_RE = /\.(mp3|wav|ogg|flac|aac|m4a|wma)$/i
  // export const VIDEO_RE = /\.(mp4|webm|ogg|mov|avi|mkv|m4v)$/i
  // export const DOCUMENT_RE = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$/i
  // export const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz)$/i
  // export const CODE_RE = /\.(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|hpp|sh|bash)$/i

  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    wma: 'audio/x-ms-wma',
    json: 'application/json',
    xml: 'application/xml',
    pdf: 'application/pdf',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    jsx: 'text/jsx',
    tsx: 'text/tsx',
    mjs: 'text/javascript',
    mts: 'text/typescript',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    toml: 'application/toml',
    ini: 'text/plain',
    log: 'text/plain',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    env: 'text/plain',
    gitignore: 'text/plain',
    dockerfile: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    bz2: 'application/x-bzip2',
    xz: 'application/x-xz',
    tgz: 'application/gzip',
    lrc: 'application/lrc',
    cert: 'application/x-x509-ca-cert',
    pem: 'application/x-x509-ca-cert',
    key: 'application/pgp-keys',
  }

  return map[ext] || 'application/octet-stream'
}

/** @param {string} key @returns {string} */
function encodeS3Key(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * Pure-JS SHA-256 for non-secure origins (e.g. a LAN IP over HTTP), where
 * `crypto.subtle` is unavailable.
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {Uint8Array}
 */
function sha256Fallback(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const rotr = (/** @type {number} */ x, /** @type {number} */ n) => ((x >>> n) | (x << (32 - n))) >>> 0
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ])
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const bitLen = bytes.length * 8
  const paddedLen = (((bytes.length + 8) >> 6) + 1) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(paddedLen - 4, bitLen >>> 0)

  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i])
  return out
}

/**
 * Hashing a huge file by loading it into memory would freeze or crash the
 * tab, and the filename template only needs a short stable fingerprint.
 * Files above this limit are hashed by their head plus their exact size.
 */
const HASH_MAX_BYTES = 64 * 1024 * 1024

/** @param {File} file @returns {Promise<string>} */
async function computeFileHash(file) {
  const truncated = file.size > HASH_MAX_BYTES
  const buffer = await (truncated ? file.slice(0, HASH_MAX_BYTES) : file).arrayBuffer()
  let data = new Uint8Array(buffer)
  if (truncated) {
    const combined = new Uint8Array(data.byteLength + 8)
    combined.set(data)
    const view = new DataView(combined.buffer)
    view.setUint32(data.byteLength, Math.floor(file.size / 0x100000000))
    view.setUint32(data.byteLength + 4, file.size >>> 0)
    data = combined
  }
  const hashBuffer = globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256', data) : sha256Fallback(data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** crypto.randomUUID is unavailable on insecure origins (e.g. LAN IP over HTTP). @returns {string} */
function randomUUID() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** @param {string} template @param {File} file @returns {Promise<string>} */
async function applyFilenameTemplate(template, file) {
  if (!template?.trim()) return file.name

  const originalName = file.name
  const ext = getExtension(originalName)
  const base = getBaseName(originalName)
  const needsHash = /\[hash(?::\d+)?\]/.test(template)
  const fileHash = needsHash ? await computeFileHash(file) : ''
  const now = Date.now()
  const timestamp = String(Math.floor(now / 1000))
  const uuid = randomUUID()

  // Use function replacers so `$&`, `$'` and similar sequences inside a
  // file name are inserted verbatim instead of being treated as replacement
  // patterns.
  let result = template
  result = result.replace(/\[name\]/g, () => base)
  result = result.replace(/\[ext\]/g, () => ext)
  result = result.replace(/\[timestamp\]/g, () => timestamp)
  result = result.replace(/\[uuid\]/g, () => uuid)
  result = result.replace(/\[hash:(\d+)\]/g, (_, n) => fileHash.slice(0, parseInt(/** @type {string} */ (n), 10)))
  result = result.replace(/\[hash\]/g, () => fileHash.slice(0, 6))
  result = result.replace(/\[date:([^\]]+)\]/g, (_, format) => dayjs().format(/** @type {string} */ (format)))

  return result
}

export {
  $,
  formatDate,
  extractFileName,
  getFileType,
  getErrorMessage,
  getFileIconSvg,
  getExtension,
  getBaseName,
  getMimeType,
  encodeS3Key,
  computeFileHash,
  applyFilenameTemplate,
}
