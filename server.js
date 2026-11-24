#!/usr/bin/env node
/**
 * Local file server for Web-FileSystem.
 *
 * - Serves the static frontend from ./src
 * - Exposes a small S3-compatible API at /s3/<bucket>
 * - Stores objects under ./data/<bucket> on the local filesystem
 * - Protects the app with a username/password login (session cookie)
 *
 * No dependencies, no external services.
 *
 * Usage:
 *   node server.js [--port 5500] [--host 127.0.0.1] [--data ./data] [--bucket local]
 *                 [--auth-user admin] [--auth-password secret] [--no-auth]
 */

import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(ROOT_DIR, 'src')

const args = process.argv.slice(2)

/** @param {string} name @param {string} fallback */
function readArg(name, fallback) {
  const index = args.indexOf(name)
  if (index !== -1 && index + 1 < args.length) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  return fallback
}

const PORT = Number(process.env.PORT || readArg('--port', '5500'))
const HOST = process.env.HOST || readArg('--host', '127.0.0.1')
const DATA_DIR = path.resolve(process.env.DATA_DIR || readArg('--data', path.join(ROOT_DIR, 'data')))
const LOCAL_BUCKET = process.env.BUCKET || readArg('--bucket', 'local')

const INTERNAL_DIR = path.join(DATA_DIR, '.web-filesystem')
const META_FILE = path.join(INTERNAL_DIR, 'meta.json')
const UPLOAD_DIR = path.join(DATA_DIR, '.uploads')
// Object bodies are staged here (same filesystem as the buckets) so a
// half-finished upload never shows up as an object in a listing.
const TMP_DIR = path.join(INTERNAL_DIR, 'tmp')

const AUTH_FILE = path.join(INTERNAL_DIR, 'auth.json')
const AUTH_DISABLED = process.env.NO_AUTH === '1' || args.includes('--no-auth')
const AUTH_USER = process.env.AUTH_USER || readArg('--auth-user', '')
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || readArg('--auth-password', '')

const SESSION_COOKIE = 'wf_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 10
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_CHALLENGES_PER_IP = 30
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || args.includes('--trust-proxy')

const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MULTIPART_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

const SHARE_SECRET_FILE = path.join(INTERNAL_DIR, 'share-secret')
const SHARE_DEFAULT_TTL = 7 * 24 * 60 * 60
const SHARE_MAX_TTL = 366 * 24 * 60 * 60
const SHARE_TOKEN_MAX_LENGTH = 2048
const MULTIPART_COMPLETE_MAX_BYTES = 2 * 1024 * 1024

// Assets the login and share pages may need; everything else requires a session.
const PUBLIC_ASSETS = new Set(['/favicon.ico', '/web-filesystem.png', '/manifest.json', '/share.css', '/share.js'])

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.wasm': 'application/wasm',
}

/** @param {string} filePath */
function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/** @param {string} value */
function xmlEscape(value) {
  return value.replace(
    /[<>&'"]/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char,
  )
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parse a non-negative integer query parameter strictly. Unlike parseInt,
 * values such as "12abc" or "1e3" fall back instead of being partially parsed.
 * @param {string | null} value
 * @param {number} fallback
 */
function parseNonNegativeInt(value, fallback) {
  if (value === null || value === '' || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {Record<string, string>} headers */
function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers)
  res.end()
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} text */
function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} data */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} xml */
function sendXml(res, status, xml) {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-store',
    ...s3CorsHeaders(),
  })
  res.end(xml)
}

function s3CorsHeaders() {
  // The bundled UI always calls /s3 same-origin, so no Access-Control-Allow-Origin
  // is emitted. A wildcard would let any website read the local bucket when
  // authentication is disabled and the server is reachable from the browser.
  return {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type, Last-Modified, Content-Range',
  }
}

/**
 * Reject bucket names that could escape the data directory.
 * @param {string} bucket
 */
function isValidBucket(bucket) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(bucket)
}

/** @param {string} bucket */
function bucketPath(bucket) {
  return path.join(DATA_DIR, bucket)
}

/** @type {Map<string, string>} */
const realBucketCache = new Map()

/**
 * Resolve the real path of a bucket once. Serving a bucket through a symlink
 * is fine; serving files that *escape* it through a planted symlink is not.
 * @param {string} bucket
 * @returns {Promise<string>}
 */
async function realBucketPath(bucket) {
  let real = realBucketCache.get(bucket)
  if (!real) {
    real = await fs.realpath(bucketPath(bucket))
    realBucketCache.set(bucket, real)
  }
  return real
}

/**
 * Refuse to read a path whose symlinks resolve outside the bucket. Missing
 * paths are left to the caller (they will 404).
 * @param {string} bucket
 * @param {string} target
 */
async function assertInsideBucket(bucket, target) {
  let real
  try {
    real = await fs.realpath(target)
  } catch {
    return
  }
  const base = await realBucketPath(bucket)
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error('Invalid key')
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

/**
 * Map over `items` with a bounded number of concurrent async calls.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
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

/**
 * Resolve an object key inside the data directory, rejecting traversal.
 * @param {string} bucket
 * @param {string} key
 */
function resolveObjectPath(bucket, key) {
  // Windows treats `\\` as a path separator, so a key such as `a\\b` would be
  // stored as a nested file and become unaddressable by its own key. Reject it
  // on every platform to keep object keys portable.
  if (key.includes('\0') || key.includes('\\')) throw new Error('Invalid key')
  const segments = key.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) throw new Error('Invalid key')
  const base = bucketPath(bucket)
  const resolved = path.resolve(base, key)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Invalid key')
  return resolved
}

// ---------------------------------------------------------------------------
// Content-Type metadata
// ---------------------------------------------------------------------------

/** @type {Record<string, { contentType?: string }> | null} */
let metaCache = null
/** @type {Promise<void>} */
let metaPersistQueue = Promise.resolve()

/** @returns {Promise<Record<string, { contentType?: string }>>} */
async function getMeta() {
  if (metaCache) return metaCache
  try {
    const parsed = JSON.parse(await fs.readFile(META_FILE, 'utf8'))
    metaCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    metaCache = {}
  }
  return metaCache
}

/**
 * Persist metadata atomically. Snapshots are serialized in call order so two
 * concurrent uploads cannot overwrite each other's Content-Type entry, and a
 * unique temporary name prevents concurrent writes from sharing a file.
 * @returns {Promise<void>}
 */
function persistMeta() {
  if (!metaCache) return Promise.resolve()
  const snapshot = JSON.stringify(metaCache)
  const task = metaPersistQueue.then(async () => {
    await fs.mkdir(INTERNAL_DIR, { recursive: true })
    const tmp = `${META_FILE}.${process.pid}-${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, snapshot)
      await fs.rename(tmp, META_FILE)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  })
  // Keep the queue usable after a failed write without hiding the error from
  // the caller that triggered it.
  metaPersistQueue = task.catch(() => {})
  return task
}

/** @param {string} bucket @param {string} key */
function metaKey(bucket, key) {
  return `${bucket}\u0000${key}`
}

/** @param {string} bucket @param {string} key */
async function getContentType(bucket, key) {
  const meta = await getMeta()
  return meta[metaKey(bucket, key)]?.contentType || ''
}

/** @param {string} bucket @param {string} key @param {string} contentType */
async function setContentType(bucket, key, contentType) {
  const meta = await getMeta()
  if (contentType) meta[metaKey(bucket, key)] = { contentType }
  else delete meta[metaKey(bucket, key)]
  await persistMeta()
}

/** @param {string} bucket @param {string} key */
async function removeContentType(bucket, key) {
  const meta = await getMeta()
  if (meta[metaKey(bucket, key)]) {
    delete meta[metaKey(bucket, key)]
    await persistMeta()
  }
}

/**
 * Remove metadata for a deleted directory and everything below it.
 * @param {string} bucket
 * @param {string} key
 */
async function removeContentTypePrefix(bucket, key) {
  const meta = await getMeta()
  const prefix = metaKey(bucket, key.endsWith('/') ? key : `${key}/`)
  let changed = false
  for (const existing of Object.keys(meta)) {
    if (existing.startsWith(prefix)) {
      delete meta[existing]
      changed = true
    }
  }
  if (meta[metaKey(bucket, key)]) {
    delete meta[metaKey(bucket, key)]
    changed = true
  }
  if (changed) await persistMeta()
}

// ---------------------------------------------------------------------------
// Multipart upload bookkeeping
// ---------------------------------------------------------------------------

/** @type {Map<string, { bucket: string, key: string, contentType: string, createdAt: number }>} */
const multipartUploads = new Map()

/** @param {string} uploadId */
function isValidUploadId(uploadId) {
  return UPLOAD_ID_PATTERN.test(uploadId)
}

/** @param {string} uploadId */
function uploadPath(uploadId) {
  if (!isValidUploadId(uploadId)) throw new Error('Invalid upload id')
  return path.join(UPLOAD_DIR, uploadId)
}

/**
 * Drop multipart uploads that were never completed or aborted. Without this,
 * abandoned upload directories would accumulate until the next restart.
 * @param {number} [now]
 */
async function pruneStaleUploads(now = Date.now()) {
  for (const [uploadId, upload] of multipartUploads) {
    if (upload.createdAt + MULTIPART_UPLOAD_TTL_MS > now) continue
    multipartUploads.delete(uploadId)
    await fs.rm(uploadPath(uploadId), { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed')
    return
  }

  const decoded = safeDecode(pathname)
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const filePath = path.resolve(STATIC_DIR, relative)
  const relativeToStatic = path.relative(STATIC_DIR, filePath)
  if (relativeToStatic.startsWith('..') || path.isAbsolute(relativeToStatic)) {
    sendText(res, 403, 'Forbidden')
    return
  }

  let stat
  try {
    stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html')
      stat = await fs.stat(indexPath)
      return sendFile(req, res, indexPath, stat)
    }
  } catch {
    sendText(res, 404, 'Not Found')
    return
  }

  return sendFile(req, res, filePath, stat)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {import('node:fs').Stats} stat
 */
function sendFile(req, res, filePath, stat) {
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const headers = {
    'Content-Type': mimeType(filePath),
    'Content-Length': String(stat.size),
    // `no-cache` keeps the asset cacheable but forces revalidation, so a
    // reload only costs a 304 instead of re-downloading every module.
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
  }

  if (isNotModified(req, etag, stat.mtime)) {
    res.writeHead(304, {
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    })
    res.end()
    return
  }

  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeFileStream(createReadStream(filePath), res)
}

/**
 * Evaluate If-None-Match / If-Modified-Since for a cached representation.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} etag
 * @param {Date} mtime
 */
function isNotModified(req, etag, mtime) {
  const ifNoneMatch = req.headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim()) {
    if (ifNoneMatch.trim() === '*') return true
    return ifNoneMatch
      .split(',')
      .map((value) => value.trim())
      .includes(etag)
  }
  const ifModifiedSince = req.headers['if-modified-since']
  if (typeof ifModifiedSince === 'string' && ifModifiedSince) {
    const since = Date.parse(ifModifiedSince)
    if (!Number.isNaN(since)) return Math.floor(mtime.getTime() / 1000) * 1000 <= since
  }
  return false
}

/**
 * Pipe a file stream to the response without letting a late filesystem error
 * crash the server.
 * @param {import('node:fs').ReadStream} stream
 * @param {import('node:http').ServerResponse} res
 */
function pipeFileStream(stream, res) {
  // `pipeline` tears down both ends on error, so a late disk error can never
  // surface as an unhandled stream 'error' event.
  pipeline(stream, res).catch(() => res.destroy())
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** @typedef {'admin' | 'member'} UserRole */
/** @typedef {{ username: string; salt: string; hash: string; role: UserRole; createdAt: number }} UserRecord */
/** @typedef {{ version: 2; users: UserRecord[] }} AuthStore */

const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 256
const USERNAME_MAX_LENGTH = 64
const SLIDER_CHALLENGE_TTL_MS = 5 * 60 * 1000
const SLIDER_MIN_DURATION_MS = 300

/** @type {AuthStore | null} */
let authStore = null
/** @type {Promise<void>} */
let authPersistQueue = Promise.resolve()
/** @type {string} */
let generatedPassword = ''
/** @type {string} */
let generatedPasswordUser = ''

/** @type {Map<string, { expiresAt: number; username: string }>} */
const sessions = new Map()
/** @type {Map<string, { count: number; resetAt: number }>} */
const loginAttempts = new Map()
/** @type {Map<string, { count: number; resetAt: number }>} */
const challengeAttempts = new Map()
/** @type {Map<string, { createdAt: number; verifiedAt: number }>} */
const sliderChallenges = new Map()

setInterval(
  () => {
    const now = Date.now()
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token)
    for (const [ip, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(ip)
    for (const [ip, record] of challengeAttempts) if (record.resetAt <= now) challengeAttempts.delete(ip)
    for (const [id, challenge] of sliderChallenges) {
      if (challenge.createdAt + SLIDER_CHALLENGE_TTL_MS <= now) sliderChallenges.delete(id)
    }
  },
  10 * 60 * 1000,
).unref()

/**
 * Hash a password off the event loop. `scryptSync` blocks every other
 * request (including file downloads) for the duration of the KDF.
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

/** @param {unknown} value */
function isStoredUsername(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1F\x7F]/.test(value)
}

/**
 * Validate and normalize a user record from disk. Unknown roles become member;
 * records written manually without createdAt get a stable timestamp.
 * @param {unknown} value
 * @returns {UserRecord | null}
 */
function normalizeUserRecord(value) {
  if (!value || typeof value !== 'object') return null
  const record =
    /** @type {{ username?: unknown; user?: unknown; salt?: unknown; hash?: unknown; role?: unknown; createdAt?: unknown }} */ (
      value
    )
  const username = record.username ?? record.user
  if (
    !isStoredUsername(username) ||
    typeof record.salt !== 'string' ||
    !/^[0-9a-f]{32}$/.test(record.salt) ||
    typeof record.hash !== 'string' ||
    !/^[0-9a-f]{128}$/.test(record.hash)
  ) {
    return null
  }
  return {
    username,
    salt: record.salt,
    hash: record.hash,
    role: record.role === 'admin' ? 'admin' : 'member',
    createdAt:
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
  }
}

/**
 * Read auth.json, accepting both the legacy single-user record and the v2
 * multi-user store. A migrated legacy record is returned with needsSave=true.
 * @returns {Promise<{ store: AuthStore | null; needsSave: boolean }>}
 */
async function readAuthStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === 2 && Array.isArray(parsed.users)) {
      const users = parsed.users.map(normalizeUserRecord).filter((user) => user !== null)
      return users.length > 0
        ? { store: { version: 2, users }, needsSave: users.length !== parsed.users.length }
        : { store: null, needsSave: false }
    }
    const legacy = normalizeUserRecord(parsed)
    if (legacy) return { store: { version: 2, users: [{ ...legacy, role: 'admin' }] }, needsSave: true }
    return { store: null, needsSave: false }
  } catch {
    return { store: null, needsSave: false }
  }
}

/**
 * @param {string} username
 * @param {string} password
 * @param {UserRole} role
 * @returns {Promise<UserRecord>}
 */
async function createUserRecord(username, password, role) {
  const salt = crypto.randomBytes(16)
  return {
    username,
    salt: salt.toString('hex'),
    hash: (await hashPassword(password, salt)).toString('hex'),
    role,
    createdAt: Date.now(),
  }
}

/** @param {UserRecord} user @param {string} password */
async function setUserPassword(user, password) {
  const salt = crypto.randomBytes(16)
  user.salt = salt.toString('hex')
  user.hash = (await hashPassword(password, salt)).toString('hex')
}

/** @param {UserRecord} user */
function publicUser(user) {
  return { username: user.username, role: user.role, createdAt: user.createdAt }
}

/**
 * Write auth.json atomically: a crash or a concurrent update must never leave
 * a truncated file that loses every account.
 * @returns {Promise<void>}
 */
function persistAuthStore() {
  if (!authStore) return Promise.resolve()
  const users = authStore.users.map((user) => ({
    username: user.username,
    salt: user.salt,
    hash: user.hash,
    role: user.role,
    createdAt: user.createdAt,
  }))
  const snapshot = `${JSON.stringify({ version: 2, users }, null, 2)}\n`
  const task = authPersistQueue.then(async () => {
    await fs.mkdir(INTERNAL_DIR, { recursive: true })
    const tmp = `${AUTH_FILE}.${process.pid}-${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, snapshot, { mode: 0o600 })
      await fs.rename(tmp, AUTH_FILE)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  })
  authPersistQueue = task.catch(() => {})
  return task
}

/** @param {string} username @returns {UserRecord | null} */
function findUser(username) {
  if (!authStore) return null
  return authStore.users.find((user) => user.username === username) || null
}

/** @param {string} username */
function hasUser(username) {
  return findUser(username) !== null
}

/**
 * @param {UserRecord} user
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function verifyUserPassword(user, password) {
  try {
    const expected = Buffer.from(user.hash, 'hex')
    const actual = await hashPassword(password, Buffer.from(user.salt, 'hex'))
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * A password verification target for usernames that do not exist. Running
 * scrypt against it keeps failed-login timing closer to a real account and
 * makes username enumeration by timing harder.
 * @type {UserRecord}
 */
const dummyAuthUser = {
  username: '',
  salt: crypto.randomBytes(16).toString('hex'),
  hash: '',
  role: 'member',
  createdAt: 0,
}

async function initDummyAuthUser() {
  dummyAuthUser.hash = (
    await hashPassword(crypto.randomBytes(32).toString('hex'), Buffer.from(dummyAuthUser.salt, 'hex'))
  ).toString('hex')
}

/** @param {unknown} password */
function isValidNewPassword(password) {
  return (
    typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
  )
}

/** @param {unknown} value */
function normalizeNewUsername(value) {
  if (typeof value !== 'string') return ''
  const username = value.trim()
  if (username.length === 0 || username.length > USERNAME_MAX_LENGTH) return ''
  if (/[\x00-\x1F\x7F/\\:]/.test(username)) return ''
  return username
}

async function initAuth() {
  if (AUTH_DISABLED) return
  const loaded = await readAuthStore()
  authStore = loaded.store
  if (AUTH_PASSWORD) {
    const targetUser = AUTH_USER || authStore?.users.find((user) => user.role === 'admin')?.username || 'admin'
    let user = findUser(targetUser)
    if (!authStore) authStore = { version: 2, users: [] }
    if (user) {
      await setUserPassword(user, AUTH_PASSWORD)
      user.role = 'admin'
    } else {
      user = await createUserRecord(targetUser, AUTH_PASSWORD, 'admin')
      authStore.users.push(user)
    }
    await persistAuthStore()
    return
  }
  if (authStore) {
    if (loaded.needsSave) await persistAuthStore()
    return
  }
  const username = AUTH_USER || 'admin'
  const password = crypto.randomBytes(9).toString('base64url')
  generatedPassword = password
  generatedPasswordUser = username
  authStore = { version: 2, users: [await createUserRecord(username, password, 'admin')] }
  await persistAuthStore()
}

/** @param {string} header */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    const rawValue = part.slice(index + 1).trim()
    try {
      cookies[name] = decodeURIComponent(rawValue)
    } catch {
      cookies[name] = rawValue
    }
  }
  return cookies
}

/** @param {import('node:http').IncomingMessage} req */
function isSecureRequest(req) {
  if (req.socket.encrypted) return true
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  return forwarded === 'https'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 * @param {number} maxAgeSeconds
 */
function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`]
  if (isSecureRequest(req)) parts.push('Secure')
  return parts.join('; ')
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ token: string; expiresAt: number; username: string } | null}
 */
function getSession(req) {
  if (!authStore) return null
  const token = parseCookies(String(req.headers.cookie || ''))[SESSION_COOKIE]
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  if (!hasUser(session.username)) {
    sessions.delete(token)
    return null
  }
  return { token, expiresAt: session.expiresAt, username: session.username }
}

/** @param {import('node:http').IncomingMessage} req */
function isAuthenticated(req) {
  if (!authStore) return true
  return getSession(req) !== null
}

/**
 * Resolve the user behind the current session. Returns null when auth is
 * disabled or no valid session exists.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ username: string; role: UserRole; token: string } | null}
 */
function getCurrentUser(req) {
  const session = getSession(req)
  if (!session) return null
  const user = findUser(session.username)
  if (!user) return null
  return { username: user.username, role: user.role, token: session.token }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ admin?: boolean }} [options]
 * @returns {{ username: string; role: UserRole; token: string } | null}
 */
function requireApiUser(req, res, options = {}) {
  if (!authStore) {
    sendJson(res, 403, { error: 'AUTH_DISABLED' })
    return null
  }
  const user = getCurrentUser(req)
  if (!user) {
    sendJson(res, 401, { error: 'UNAUTHORIZED' })
    return null
  }
  if (options.admin && user.role !== 'admin') {
    sendJson(res, 403, { error: 'FORBIDDEN' })
    return null
  }
  return user
}

/** @param {{ username: string; role: UserRole; token: string }} user */
function invalidateUserSessions(user, exceptToken = '') {
  for (const [token, session] of sessions) {
    if (session.username === user.username && token !== exceptToken) sessions.delete(token)
  }
}

/** @param {import('node:http').ServerResponse} res @param {string} location */
function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

/** @param {string} raw */
function safeNextPath(raw) {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  return raw
}

/**
 * Read a (small) request body into memory, refusing oversized payloads.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
async function readBodyBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('Payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** @param {import('node:http').IncomingMessage} req */
async function readJsonBody(req) {
  const text = (await readBodyBuffer(req, 64 * 1024)).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

/**
 * Resolve the client address used for login rate limiting. Only trust
 * X-Forwarded-For when the operator explicitly enables TRUST_PROXY.
 * @param {import('node:http').IncomingMessage} req
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    if (forwarded) return forwarded
  }
  return req.socket.remoteAddress || 'unknown'
}

const LOGIN_I18N = {
  zh: {
    title: '登录',
    subtitle: '登录后访问你的文件',
    username: '用户名',
    password: '密码',
    submit: '登录',
    signingIn: '正在登录…',
    invalid: '用户名或密码错误',
    tooMany: '尝试次数过多，请稍后再试',
    network: '网络错误，请重试',
    sliderLabel: '向右滑动完成验证',
    sliderVerifying: '正在验证…',
    sliderSuccess: '验证通过',
    sliderError: '验证失败，请重试',
    sliderRequired: '请先完成滑动验证',
  },
  zh_TW: {
    title: '登入',
    subtitle: '登入後存取你的檔案',
    username: '使用者名稱',
    password: '密碼',
    submit: '登入',
    signingIn: '正在登入…',
    invalid: '使用者名稱或密碼錯誤',
    tooMany: '嘗試次數過多，請稍後再試',
    network: '網路錯誤，請重試',
    sliderLabel: '向右滑動完成驗證',
    sliderVerifying: '驗證中…',
    sliderSuccess: '驗證通過',
    sliderError: '驗證失敗，請重試',
    sliderRequired: '請先完成滑動驗證',
  },
  en: {
    title: 'Sign in',
    subtitle: 'Sign in to access your files',
    username: 'Username',
    password: 'Password',
    submit: 'Sign in',
    signingIn: 'Signing in…',
    invalid: 'Incorrect username or password',
    tooMany: 'Too many attempts. Try again later.',
    network: 'Network error. Please try again.',
    sliderLabel: 'Slide right to verify',
    sliderVerifying: 'Verifying…',
    sliderSuccess: 'Verified',
    sliderError: 'Verification failed. Please try again.',
    sliderRequired: 'Complete the slider verification first',
  },
  ja: {
    title: 'ログイン',
    subtitle: 'ファイルにアクセスするにはログインしてください',
    username: 'ユーザー名',
    password: 'パスワード',
    submit: 'ログイン',
    signingIn: 'ログイン中…',
    invalid: 'ユーザー名またはパスワードが正しくありません',
    tooMany: '試行回数が多すぎます。しばらくしてから再試行してください。',
    network: '通信エラーが発生しました。もう一度お試しください。',
    sliderLabel: '右へスライドして認証',
    sliderVerifying: '認証中…',
    sliderSuccess: '認証しました',
    sliderError: '認証に失敗しました。もう一度お試しください。',
    sliderRequired: '先にスライダー認証を完了してください',
  },
}

/** @param {import('node:http').IncomingMessage} req */
function pickLoginLang(req) {
  const header = String(req.headers['accept-language'] || '').toLowerCase()
  if (header.includes('ja')) return 'ja'
  if (header.includes('zh-tw') || header.includes('zh-hant') || header.includes('zh-hk')) return 'zh_TW'
  if (header.includes('zh')) return 'zh'
  return 'en'
}

/** @param {import('node:http').IncomingMessage} req */
function renderLoginPage(req) {
  const lang = pickLoginLang(req)
  const copy = LOGIN_I18N[lang]
  const htmlLang = lang === 'zh_TW' ? 'zh-Hant' : lang
  return `<!doctype html>
<html lang="${htmlLang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>${copy.title} · Web-FileSystem</title>
    <link rel="icon" href="/favicon.ico" />
    <style>
      :root {
        color-scheme: light dark;
        --accent: #f6821f;
        --bg: #f6f6f7;
        --panel: rgba(255, 255, 255, 0.88);
        --text: #1c1c1e;
        --muted: #6b6b70;
        --border: rgba(0, 0, 0, 0.1);
        --danger: #d92d20;
        --shadow: rgba(0, 0, 0, 0.12);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111113;
          --panel: rgba(28, 28, 30, 0.88);
          --text: #f5f5f7;
          --muted: #a1a1a6;
          --border: rgba(255, 255, 255, 0.12);
          --danger: #ff6b63;
          --shadow: rgba(0, 0, 0, 0.45);
        }
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
          'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
        background:
          radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%),
          var(--bg);
        color: var(--text);
      }
      .card {
        width: 100%;
        max-width: 380px;
        padding: 32px 28px;
        border-radius: 20px;
        background: var(--panel);
        border: 1px solid var(--border);
        box-shadow: 0 20px 60px var(--shadow);
        backdrop-filter: blur(18px);
      }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
      .logo {
        width: 44px;
        height: 44px;
        flex: none;
        border-radius: 12px;
        display: grid;
        place-items: center;
        background: var(--accent);
        color: #fff;
      }
      .brand h1 { margin: 0; font-size: 18px; letter-spacing: -0.01em; }
      .brand p { margin: 3px 0 0; font-size: 12px; color: var(--muted); }
      form { display: grid; gap: 14px; }
      label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
      input {
        width: 100%;
        padding: 11px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--panel) 60%, transparent);
        color: var(--text);
        font-size: 15px;
        outline: none;
      }
      input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
      }
      .slider {
        position: relative;
        height: 46px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--panel) 60%, transparent);
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        outline: none;
      }
      .slider:focus-visible {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
      }
      .slider-fill {
        position: absolute;
        inset: 0 auto 0 0;
        width: 0;
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        transition: background 160ms ease;
      }
      .slider-label {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding-left: 40px;
        font-size: 13px;
        color: var(--muted);
        pointer-events: none;
        transition: opacity 160ms ease;
      }
      .slider-handle {
        position: absolute;
        top: 4px;
        left: 4px;
        z-index: 2;
        width: 38px;
        height: 38px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: var(--accent);
        color: #fff;
        cursor: grab;
        touch-action: none;
        transition:
          transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
          background 160ms ease;
      }
      .slider.dragging .slider-handle,
      .slider.dragging .slider-fill {
        transition: none;
      }
      .slider.dragging .slider-handle { cursor: grabbing; }
      .slider.dragging .slider-label { opacity: 0.55; }
      .slider.verified { border-color: #16a34a; }
      .slider.verified .slider-fill { background: color-mix(in srgb, #16a34a 18%, transparent); }
      .slider.verified .slider-handle { background: #16a34a; cursor: default; }
      .slider.verified .slider-label { color: #15803d; }
      .slider-check { display: none; }
      .slider.verified .slider-arrow { display: none; }
      .slider.verified .slider-check { display: block; }
      @media (prefers-color-scheme: dark) {
        .slider.verified .slider-label { color: #4ade80; }
      }
      button {
        margin-top: 4px;
        padding: 12px;
        border: 0;
        border-radius: 10px;
        background: var(--accent);
        color: #fff;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      .error { min-height: 18px; margin: 0; font-size: 13px; color: var(--danger); }
      .footer { margin: 20px 0 0; font-size: 11px; text-align: center; color: var(--muted); }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div>
          <h1>Web-FileSystem</h1>
          <p>${copy.subtitle}</p>
        </div>
      </div>
      <form id="login-form">
        <label>${copy.username}
          <input id="username" name="username" type="text" autocomplete="username" required autofocus />
        </label>
        <label>${copy.password}
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </label>
        <div
          class="slider"
          id="slider"
          role="slider"
          tabindex="0"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
          aria-label="${copy.sliderLabel}"
          aria-disabled="true"
        >
          <div class="slider-fill" id="slider-fill"></div>
          <span class="slider-label" id="slider-label">${copy.sliderLabel}</span>
          <div class="slider-handle" id="slider-handle" aria-hidden="true">
            <svg class="slider-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <svg class="slider-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>
        <p class="error" id="error" role="alert"></p>
        <button type="submit" id="submit" disabled>${copy.submit}</button>
      </form>
      <p class="footer">Web-FileSystem · ${copy.title}</p>
    </main>
    <script>
      var form = document.getElementById('login-form')
      var button = document.getElementById('submit')
      var errorBox = document.getElementById('error')
      var track = document.getElementById('slider')
      var fill = document.getElementById('slider-fill')
      var handle = document.getElementById('slider-handle')
      var sliderLabel = document.getElementById('slider-label')
      var messages = {
        invalid: ${JSON.stringify(copy.invalid)},
        tooMany: ${JSON.stringify(copy.tooMany)},
        network: ${JSON.stringify(copy.network)},
        signingIn: ${JSON.stringify(copy.signingIn)},
        sliderLabel: ${JSON.stringify(copy.sliderLabel)},
        sliderVerifying: ${JSON.stringify(copy.sliderVerifying)},
        sliderSuccess: ${JSON.stringify(copy.sliderSuccess)},
        sliderError: ${JSON.stringify(copy.sliderError)},
        sliderRequired: ${JSON.stringify(copy.sliderRequired)}
      }
      var submitLabel = button.textContent
      var challengeId = ''
      var sliderState = 'loading'
      var progress = 0
      var dragging = false
      var dragStartX = 0
      var dragStartProgress = 0
      var dragStartedAt = 0

      function setProgress(value) {
        progress = Math.max(0, Math.min(1, value))
        var max = Math.max(0, track.clientWidth - handle.offsetWidth - 8)
        handle.style.transform = 'translateX(' + max * progress + 'px)'
        fill.style.width = progress * 100 + '%'
        track.setAttribute('aria-valuenow', String(Math.round(progress * 100)))
      }

      function resetSlider() {
        dragging = false
        sliderState = 'loading'
        track.classList.remove('dragging', 'verified')
        track.setAttribute('aria-disabled', 'true')
        setProgress(0)
        sliderLabel.textContent = messages.sliderLabel
      }

      function loadChallenge() {
        resetSlider()
        challengeId = ''
        fetch('/api/login/challenge', {
          method: 'POST',
          headers: { Accept: 'application/json' }
        })
          .then(function (response) {
            if (!response.ok) throw new Error('challenge')
            return response.json()
          })
          .then(function (data) {
            if (!data || typeof data.id !== 'string' || !data.id) throw new Error('challenge')
            challengeId = data.id
            sliderState = 'ready'
            track.setAttribute('aria-disabled', 'false')
          })
          .catch(function () {
            challengeId = ''
            sliderState = 'loading'
            track.setAttribute('aria-disabled', 'true')
            errorBox.textContent = messages.network
          })
      }

      function completeSlider() {
        if (sliderState !== 'ready' || !challengeId) return
        sliderState = 'verifying'
        track.setAttribute('aria-disabled', 'true')
        setProgress(1)
        sliderLabel.textContent = messages.sliderVerifying
        fetch('/api/login/challenge/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: challengeId, position: 1 })
        })
          .then(function (response) {
            if (!response.ok) throw new Error('verify')
            return response.json()
          })
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error('verify')
            sliderState = 'verified'
            track.classList.add('verified')
            sliderLabel.textContent = messages.sliderSuccess
            button.disabled = false
          })
          .catch(function () {
            errorBox.textContent = messages.sliderError
            loadChallenge()
          })
      }

      function startDrag(event) {
        if (sliderState === 'verified' || sliderState === 'verifying') return
        if (!challengeId) {
          loadChallenge()
          return
        }
        if (sliderState !== 'ready') return
        dragging = true
        dragStartX = event.clientX
        dragStartProgress = progress
        dragStartedAt = Date.now()
        track.classList.add('dragging')
        try {
          track.setPointerCapture(event.pointerId)
        } catch (error) {}
        event.preventDefault()
      }

      function moveDrag(event) {
        if (!dragging) return
        var max = Math.max(1, track.clientWidth - handle.offsetWidth - 8)
        setProgress(dragStartProgress + (event.clientX - dragStartX) / max)
      }

      function endDrag(event) {
        if (!dragging) return
        dragging = false
        track.classList.remove('dragging')
        try {
          track.releasePointerCapture(event.pointerId)
        } catch (error) {}
        if (progress >= 0.92 && Date.now() - dragStartedAt >= 200) completeSlider()
        else setProgress(0)
      }

      handle.addEventListener('pointerdown', startDrag)
      track.addEventListener('pointermove', moveDrag)
      track.addEventListener('pointerup', endDrag)
      track.addEventListener('pointercancel', endDrag)
      track.addEventListener('keydown', function (event) {
        if (sliderState === 'verified') return
        if (!challengeId) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            loadChallenge()
          }
          return
        }
        if (sliderState !== 'ready') return
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault()
          setProgress(progress + 0.1)
          if (progress >= 0.999) completeSlider()
        } else if (event.key === 'End') {
          event.preventDefault()
          setProgress(1)
          completeSlider()
        } else if (event.key === 'Home') {
          event.preventDefault()
          setProgress(0)
        }
      })
      window.addEventListener('resize', function () {
        setProgress(progress)
      })

      form.addEventListener('submit', async function (event) {
        event.preventDefault()
        if (sliderState !== 'verified' || !challengeId) {
          errorBox.textContent = messages.sliderRequired
          return
        }
        errorBox.textContent = ''
        button.disabled = true
        button.textContent = messages.signingIn
        try {
          var response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: document.getElementById('username').value,
              password: document.getElementById('password').value,
              challengeId: challengeId
            })
          })
          if (response.ok) {
            var next = new URLSearchParams(location.search).get('next') || '/'
            try {
              var target = new URL(next, location.origin)
              next = target.origin === location.origin ? target.pathname + target.search + target.hash : '/'
            } catch (error) {
              next = '/'
            }
            location.replace(next)
            return
          }
          if (response.status === 429) errorBox.textContent = messages.tooMany
          else if (response.status === 401) errorBox.textContent = messages.invalid
          else errorBox.textContent = messages.sliderError
        } catch (error) {
          errorBox.textContent = messages.network
        }
        button.disabled = true
        button.textContent = submitLabel
        loadChallenge()
      })

      loadChallenge()
    </script>
  </body>
</html>`
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function sendLoginPage(req, res) {
  const html = renderLoginPage(req)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(html)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleLogin(req, res) {
  const ip = clientIp(req)
  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (attempt && attempt.resetAt > now && attempt.count >= MAX_LOGIN_ATTEMPTS) {
    sendJson(res, 429, { error: 'TOO_MANY_ATTEMPTS' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST' })
    return
  }

  const credentials = /** @type {{ username?: unknown; password?: unknown; challengeId?: unknown }} */ (body || {})
  const username = typeof credentials.username === 'string' ? credentials.username : ''
  const password = typeof credentials.password === 'string' ? credentials.password : ''
  const challengeId = typeof credentials.challengeId === 'string' ? credentials.challengeId : ''
  const challenge = challengeId ? sliderChallenges.get(challengeId) : null
  if (!challenge || challenge.verifiedAt === 0 || challenge.createdAt + SLIDER_CHALLENGE_TTL_MS <= now) {
    if (challenge) sliderChallenges.delete(challengeId)
    sendJson(res, 400, { error: 'SLIDER_REQUIRED' })
    return
  }
  // The challenge is one-time use, even if the password turns out to be wrong.
  sliderChallenges.delete(challengeId)

  const user = username ? findUser(username) : null
  const passwordValid = await verifyUserPassword(user || dummyAuthUser, password)
  if (!authStore || !user || !passwordValid) {
    if (!attempt || attempt.resetAt <= now) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    else attempt.count += 1
    sendJson(res, 401, { error: 'INVALID_CREDENTIALS' })
    return
  }

  loginAttempts.delete(ip)
  const token = crypto.randomBytes(32).toString('base64url')
  sessions.set(token, { expiresAt: now + SESSION_TTL_MS, username: user.username })
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000),
  })
  res.end(JSON.stringify({ ok: true }))
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleCreateSliderChallenge(req, res) {
  if (!authStore) {
    sendJson(res, 400, { error: 'AUTH_DISABLED' })
    return
  }
  const now = Date.now()
  for (const [id, challenge] of sliderChallenges) {
    if (challenge.createdAt + SLIDER_CHALLENGE_TTL_MS <= now) sliderChallenges.delete(id)
  }
  for (const [ip, record] of challengeAttempts) {
    if (record.resetAt <= now) challengeAttempts.delete(ip)
  }
  // One visitor should not be able to create an unbounded number of
  // challenges: the map is shared by every client and has a hard cap.
  const ip = clientIp(req)
  const record = challengeAttempts.get(ip)
  if (record && record.resetAt > now && record.count >= MAX_CHALLENGES_PER_IP) {
    sendJson(res, 429, { error: 'TOO_MANY_CHALLENGES' })
    return
  }
  if (sliderChallenges.size >= 5000) {
    sendJson(res, 429, { error: 'TOO_MANY_CHALLENGES' })
    return
  }
  if (!record || record.resetAt <= now) challengeAttempts.set(ip, { count: 1, resetAt: now + CHALLENGE_WINDOW_MS })
  else record.count += 1
  const id = crypto.randomBytes(24).toString('base64url')
  sliderChallenges.set(id, { createdAt: now, verifiedAt: 0 })
  sendJson(res, 200, { id, expiresIn: Math.floor(SLIDER_CHALLENGE_TTL_MS / 1000) })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleVerifySliderChallenge(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST' })
    return
  }
  const payload = /** @type {{ id?: unknown; position?: unknown }} */ (body || {})
  const id = typeof payload.id === 'string' && payload.id.length <= 128 ? payload.id : ''
  const challenge = id ? sliderChallenges.get(id) : null
  const now = Date.now()
  if (!challenge || challenge.createdAt + SLIDER_CHALLENGE_TTL_MS <= now) {
    if (id) sliderChallenges.delete(id)
    sendJson(res, 400, { error: 'SLIDER_EXPIRED' })
    return
  }
  if (challenge.verifiedAt !== 0) {
    sendJson(res, 409, { error: 'SLIDER_ALREADY_VERIFIED' })
    return
  }
  if (
    typeof payload.position !== 'number' ||
    !Number.isFinite(payload.position) ||
    payload.position < 0.9 ||
    payload.position > 1
  ) {
    sendJson(res, 400, { error: 'SLIDER_INCOMPLETE' })
    return
  }
  if (now - challenge.createdAt < SLIDER_MIN_DURATION_MS) {
    sendJson(res, 400, { error: 'SLIDER_TOO_FAST' })
    return
  }
  challenge.verifiedAt = now
  sendJson(res, 200, { ok: true })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleAuthApi(req, res, url) {
  if (url.pathname === '/api/auth/me') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      return
    }
    const current = getCurrentUser(req)
    sendJson(res, 200, {
      enabled: Boolean(authStore),
      user: current ? { username: current.username, role: current.role } : null,
    })
    return
  }

  if (url.pathname === '/api/auth/change-password') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      return
    }
    const current = requireApiUser(req, res)
    if (!current) return
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST' })
      return
    }
    const payload = /** @type {{ currentPassword?: unknown; newPassword?: unknown }} */ (body || {})
    const currentPassword = typeof payload.currentPassword === 'string' ? payload.currentPassword : ''
    const newPassword = payload.newPassword
    if (!isValidNewPassword(newPassword)) {
      sendJson(res, 400, { error: 'WEAK_PASSWORD', minLength: PASSWORD_MIN_LENGTH })
      return
    }
    const user = findUser(current.username)
    if (!user || !(await verifyUserPassword(user, currentPassword))) {
      sendJson(res, 400, { error: 'CURRENT_PASSWORD_INCORRECT' })
      return
    }
    if (currentPassword === newPassword) {
      sendJson(res, 400, { error: 'PASSWORD_UNCHANGED' })
      return
    }
    const previousSalt = user.salt
    const previousHash = user.hash
    await setUserPassword(user, newPassword)
    try {
      await persistAuthStore()
    } catch (error) {
      user.salt = previousSalt
      user.hash = previousHash
      throw error
    }
    invalidateUserSessions(user, current.token)
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/users') {
    const current = requireApiUser(req, res, { admin: true })
    if (!current) return
    if (req.method === 'GET') {
      const users = [.../** @type {AuthStore} */ (authStore).users]
        .sort((a, b) => {
          if (a.role !== b.role) return a.role === 'admin' ? -1 : 1
          return a.createdAt - b.createdAt || a.username.localeCompare(b.username)
        })
        .map(publicUser)
      sendJson(res, 200, { users, currentUser: current.username })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST' })
      return
    }
    const payload = /** @type {{ username?: unknown; password?: unknown; role?: unknown }} */ (body || {})
    const username = normalizeNewUsername(payload.username)
    if (!username) {
      sendJson(res, 400, { error: 'INVALID_USERNAME' })
      return
    }
    if (!isValidNewPassword(payload.password)) {
      sendJson(res, 400, { error: 'WEAK_PASSWORD', minLength: PASSWORD_MIN_LENGTH })
      return
    }
    const role = payload.role === undefined ? 'member' : payload.role
    if (role !== 'admin' && role !== 'member') {
      sendJson(res, 400, { error: 'INVALID_ROLE' })
      return
    }
    if (hasUser(username)) {
      sendJson(res, 409, { error: 'USER_EXISTS' })
      return
    }
    const user = await createUserRecord(username, /** @type {string} */ (payload.password), role)
    const store = /** @type {AuthStore} */ (authStore)
    store.users.push(user)
    try {
      await persistAuthStore()
    } catch (error) {
      store.users.pop()
      throw error
    }
    sendJson(res, 201, { ok: true, user: publicUser(user) })
    return
  }

  if (url.pathname.startsWith('/api/users/')) {
    const current = requireApiUser(req, res, { admin: true })
    if (!current) return
    const parts = url.pathname.slice('/api/users/'.length).split('/')
    const username = safeDecode(parts[0] || '')
    if (!username) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND' })
      return
    }
    const target = findUser(username)
    if (!target) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND' })
      return
    }

    if (parts.length === 1) {
      if (req.method !== 'DELETE') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (target.username === current.username) {
        sendJson(res, 400, { error: 'CANNOT_DELETE_SELF' })
        return
      }
      const adminCount = /** @type {AuthStore} */ (authStore).users.filter((user) => user.role === 'admin').length
      if (target.role === 'admin' && adminCount <= 1) {
        sendJson(res, 400, { error: 'LAST_ADMIN' })
        return
      }
      const store = /** @type {AuthStore} */ (authStore)
      const index = store.users.indexOf(target)
      store.users.splice(index, 1)
      try {
        await persistAuthStore()
      } catch (error) {
        store.users.splice(index, 0, target)
        throw error
      }
      invalidateUserSessions(target)
      sendJson(res, 200, { ok: true })
      return
    }

    if (parts.length === 2 && parts[1] === 'password') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (target.username === current.username) {
        sendJson(res, 400, { error: 'USE_CHANGE_PASSWORD' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: 'BAD_REQUEST' })
        return
      }
      const payload = /** @type {{ password?: unknown }} */ (body || {})
      if (!isValidNewPassword(payload.password)) {
        sendJson(res, 400, { error: 'WEAK_PASSWORD', minLength: PASSWORD_MIN_LENGTH })
        return
      }
      const previousSalt = target.salt
      const previousHash = target.hash
      await setUserPassword(target, /** @type {string} */ (payload.password))
      try {
        await persistAuthStore()
      } catch (error) {
        target.salt = previousSalt
        target.hash = previousHash
        throw error
      }
      invalidateUserSessions(target)
      sendJson(res, 200, { ok: true })
      return
    }
  }

  sendJson(res, 404, { error: 'NOT_FOUND' })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleLogout(req, res) {
  const token = parseCookies(String(req.headers.cookie || ''))[SESSION_COOKIE]
  if (token) sessions.delete(token)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(req, '', 0),
  })
  res.end(JSON.stringify({ ok: true }))
}

// ---------------------------------------------------------------------------
// Read-only share links
// ---------------------------------------------------------------------------

/**
 * @typedef {{ bucket: string, key: string, type: 'file' | 'dir', expiresAt: number | null }} ShareGrant
 */

/** @type {Buffer | null} */
let shareSecret = null

async function initShareSecret() {
  try {
    const stored = (await fs.readFile(SHARE_SECRET_FILE, 'utf8')).trim()
    const secret = Buffer.from(stored, 'base64url')
    if (secret.length === 32) {
      shareSecret = secret
      return
    }
  } catch {
    /* create a new secret below */
  }

  const secret = crypto.randomBytes(32)
  shareSecret = secret
  try {
    await fs.mkdir(INTERNAL_DIR, { recursive: true })
    const tmp = `${SHARE_SECRET_FILE}.${process.pid}-${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, `${secret.toString('base64url')}\n`, { mode: 0o600 })
      await fs.rename(tmp, SHARE_SECRET_FILE)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  } catch (error) {
    console.warn(
      `  ⚠  Unable to persist the share secret (${error instanceof Error ? error.message : error}); existing share links will stop working after restart.`,
    )
  }
}

/**
 * @param {{ v: 1, b: string, k: string, t: 'file' | 'dir', e?: number }} payload
 */
function signSharePayload(payload) {
  if (!shareSecret) throw new Error('Share secret is not initialized')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', shareSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}

/**
 * Verify the HMAC and payload of a share token. Any tampering or expiry
 * invalidates the whole token.
 * @param {string} token
 * @returns {ShareGrant | null}
 */
function verifyShareToken(token) {
  if (!shareSecret || typeof token !== 'string' || token.length === 0 || token.length > SHARE_TOKEN_MAX_LENGTH) {
    return null
  }
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null

  const expected = crypto.createHmac('sha256', shareSecret).update(body).digest()
  let provided
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null

  /** @type {unknown} */
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
  const payload = /** @type {{ v?: unknown, b?: unknown, k?: unknown, t?: unknown, e?: unknown }} */ (decoded)
  if (payload.v !== 1) return null
  if (typeof payload.b !== 'string' || !isValidBucket(payload.b)) return null
  if (typeof payload.k !== 'string' || payload.k.length > 1024) return null
  if (payload.k.includes('\0') || payload.k.includes('\\')) return null
  if (payload.t !== 'file' && payload.t !== 'dir') return null
  if (payload.t === 'file' && (payload.k === '' || payload.k.endsWith('/'))) return null
  if (payload.t === 'dir' && payload.k !== '' && !payload.k.endsWith('/')) return null
  if (payload.k.split('/').some((segment) => segment === '.' || segment === '..')) return null

  /** @type {number | null} */
  let expiresAt = null
  if (payload.e !== undefined) {
    if (typeof payload.e !== 'number' || !Number.isInteger(payload.e) || payload.e <= 0) return null
    expiresAt = payload.e * 1000
    if (expiresAt <= Date.now()) return null
  }

  return { bucket: payload.b, key: payload.k, type: payload.t, expiresAt }
}

/**
 * Normalize a path relative to a shared directory. Returns null when the
 * path tries to escape the share root.
 * @param {string | null} raw
 * @returns {string | null}
 */
function normalizeSharePath(raw) {
  const value = raw == null ? '' : raw
  if (value.length > 1024 || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return null
  const trimmed = value.replace(/\/+$/, '')
  if (!trimmed) return ''
  const segments = trimmed.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return trimmed
}

/** @param {string} key @param {string} fallback */
function shareDisplayName(key, fallback) {
  const trimmed = key.replace(/\/+$/, '')
  if (!trimmed) return fallback
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || fallback
}

/** @param {string} fileName */
function contentDisposition(fileName) {
  const clean = fileName.replace(/[\r\n]/g, ' ').trim() || 'download'
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function sendSharePage(req, res) {
  let html
  try {
    html = await fs.readFile(path.join(STATIC_DIR, 'share.html'))
  } catch {
    sendText(res, 500, 'Share page unavailable')
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(html.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(html)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {ShareGrant} share
 */
async function sendShareMetadata(res, share) {
  const targetPath = resolveObjectPath(share.bucket, share.key)
  let stat
  try {
    await assertInsideBucket(share.bucket, targetPath)
    stat = await fs.stat(targetPath)
  } catch {
    sendJson(res, 404, { error: 'SHARE_UNAVAILABLE' })
    return
  }
  if (share.type === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    sendJson(res, 404, { error: 'SHARE_UNAVAILABLE' })
    return
  }

  const isFile = share.type === 'file'
  /** @type {{ type: string, name: string, key: string, size: number | null, lastModified: string, expiresAt: number | null, contentType?: string }} */
  const metadata = {
    type: share.type,
    name: shareDisplayName(share.key, share.bucket),
    key: share.key,
    size: isFile ? stat.size : null,
    lastModified: stat.mtime.toISOString(),
    expiresAt: share.expiresAt,
  }
  if (isFile) {
    metadata.contentType = (await getContentType(share.bucket, share.key)) || mimeType(share.key)
  }
  sendJson(res, 200, metadata)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {ShareGrant} share
 * @param {URLSearchParams} params
 */
async function sendShareList(res, share, params) {
  if (share.type !== 'dir') {
    sendJson(res, 400, { error: 'NOT_A_DIRECTORY' })
    return
  }

  const relative = normalizeSharePath(params.get('path'))
  if (relative === null) {
    sendJson(res, 400, { error: 'INVALID_PATH' })
    return
  }

  try {
    const rootPath = resolveObjectPath(share.bucket, share.key)
    await assertInsideBucket(share.bucket, rootPath)
    const rootStat = await fs.stat(rootPath)
    if (!rootStat.isDirectory()) throw new Error('not a directory')
  } catch {
    sendJson(res, 404, { error: 'SHARE_UNAVAILABLE' })
    return
  }

  const prefix = `${share.key}${relative ? `${relative}/` : ''}`
  let listed
  try {
    listed = await listEntries(share.bucket, prefix, '/')
  } catch {
    sendJson(res, 404, { error: 'SHARE_UNAVAILABLE' })
    return
  }

  /** @type {{ name: string, path: string, isFolder: boolean, size: number, lastModified: string | null }[]} */
  const entries = []
  for (const entry of listed) {
    const relativeKey = entry.key.slice(share.key.length)
    const pathValue = entry.isFolder ? relativeKey.replace(/\/+$/, '') : relativeKey
    if (!pathValue) continue
    const segments = pathValue.split('/')
    entries.push({
      name: segments[segments.length - 1],
      path: pathValue,
      isFolder: entry.isFolder,
      size: entry.isFolder ? 0 : entry.size || 0,
      lastModified: entry.lastModified || null,
    })
  }

  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })

  const cursor = parseNonNegativeInt(params.get('cursor'), 0)
  const limit = Math.max(1, Math.min(200, parseNonNegativeInt(params.get('limit'), 100)))
  const page = entries.slice(cursor, cursor + limit)
  const isTruncated = cursor + limit < entries.length

  sendJson(res, 200, {
    path: relative,
    entries: page,
    isTruncated,
    nextToken: isTruncated ? String(cursor + limit) : '',
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ShareGrant} share
 * @param {boolean} download
 * @param {URLSearchParams} params
 */
async function sendShareObject(req, res, share, download, params) {
  let key = share.key
  if (share.type === 'dir') {
    const relative = normalizeSharePath(params.get('path'))
    if (relative === null) {
      sendJson(res, 400, { error: 'INVALID_PATH' })
      return
    }
    if (!relative) {
      sendJson(res, 400, { error: 'PATH_REQUIRED' })
      return
    }
    key = `${share.key}${relative}`
    if (!key.startsWith(share.key)) {
      sendJson(res, 403, { error: 'FORBIDDEN' })
      return
    }
  }

  let stat
  try {
    const targetPath = resolveObjectPath(share.bucket, key)
    await assertInsideBucket(share.bucket, targetPath)
    stat = await fs.stat(targetPath)
  } catch {
    sendText(res, 404, 'Not Found')
    return
  }
  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found')
    return
  }

  await handleGetObject(req, res, share.bucket, key, {
    disposition: download ? contentDisposition(shareDisplayName(key, 'download')) : '',
    cacheControl: 'no-store',
    // A shared HTML/SVG file must not run script in the server's origin if a
    // recipient opens the raw content URL directly.
    extraHeaders: {
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleShareApi(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    return
  }

  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')

  const rest = url.pathname.slice('/api/share/'.length)
  const slash = rest.indexOf('/')
  const token = safeDecode(slash === -1 ? rest : rest.slice(0, slash))
  const action = slash === -1 ? '' : rest.slice(slash + 1)
  const share = verifyShareToken(token)
  if (!share) {
    sendJson(res, 404, { error: 'INVALID_SHARE' })
    return
  }

  try {
    if (action === '') return await sendShareMetadata(res, share)
    if (action === 'list') return await sendShareList(res, share, url.searchParams)
    if (action === 'content') return await sendShareObject(req, res, share, false, url.searchParams)
    if (action === 'download') return await sendShareObject(req, res, share, true, url.searchParams)
    sendJson(res, 404, { error: 'NOT_FOUND' })
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' })
    else res.destroy()
  }
}

/**
 * Create a read-only share token for a local object or directory. Requires a
 * valid session (handled by the router before this function is reached).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleCreateShare(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST' })
    return
  }

  const input =
    body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {}
  const rawKey = input.key
  if (typeof rawKey !== 'string' || rawKey.length > 1024) {
    sendJson(res, 400, { error: 'INVALID_KEY' })
    return
  }

  const rawExpiry = input.expiresIn === undefined ? SHARE_DEFAULT_TTL : input.expiresIn
  if (typeof rawExpiry !== 'number' || !Number.isInteger(rawExpiry) || rawExpiry < 0 || rawExpiry > SHARE_MAX_TTL) {
    sendJson(res, 400, { error: 'INVALID_EXPIRY' })
    return
  }

  let key = rawKey.replace(/^\/+/, '')
  if (key.includes('//')) key = key.split('/').filter(Boolean).join('/')
  if (key.includes('\0') || key.includes('\\')) {
    sendJson(res, 400, { error: 'INVALID_KEY' })
    return
  }

  let targetPath
  try {
    targetPath = resolveObjectPath(LOCAL_BUCKET, key)
  } catch {
    sendJson(res, 400, { error: 'INVALID_KEY' })
    return
  }

  let stat
  try {
    await assertInsideBucket(LOCAL_BUCKET, targetPath)
    stat = await fs.stat(targetPath)
  } catch {
    sendJson(res, 404, { error: 'NOT_FOUND' })
    return
  }

  /** @type {'file' | 'dir'} */
  let type
  if (stat.isDirectory()) {
    type = 'dir'
    if (key && !key.endsWith('/')) key += '/'
  } else if (stat.isFile()) {
    if (key.endsWith('/')) {
      sendJson(res, 400, { error: 'INVALID_KEY' })
      return
    }
    type = 'file'
  } else {
    sendJson(res, 404, { error: 'NOT_FOUND' })
    return
  }

  /** @type {{ v: 1, b: string, k: string, t: 'file' | 'dir', e?: number }} */
  const payload = { v: 1, b: LOCAL_BUCKET, k: key, t: type }
  if (rawExpiry > 0) payload.e = Math.floor(Date.now() / 1000) + rawExpiry

  const token = signSharePayload(payload)
  if (token.length > SHARE_TOKEN_MAX_LENGTH) {
    sendJson(res, 400, { error: 'KEY_TOO_LONG' })
    return
  }
  sendJson(res, 200, {
    token,
    path: `/share/${token}`,
    type,
    key,
    name: shareDisplayName(key, LOCAL_BUCKET),
    expiresAt: payload.e ? payload.e * 1000 : null,
  })
}

// ---------------------------------------------------------------------------
// Tinify proxy
// ---------------------------------------------------------------------------

const TINIFY_MAX_BYTES = 20 * 1024 * 1024
const TINIFY_TIMEOUT_MS = 120 * 1000

/**
 * Compress one image through Tinify on behalf of the browser. The Tinify API
 * sends no CORS headers, so a static page cannot call it directly; relaying the
 * request through the bundled server keeps the API key and the image away from
 * any third party. The key is used for this request only and never stored.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleTinifyCompress(req, res) {
  const current = requireApiUser(req, res)
  if (!current) return

  const key = String(req.headers['x-tinify-key'] || '')
  if (!key || key.length > 256 || /[\r\n]/.test(key)) {
    sendJson(res, 400, { error: 'INVALID_TINIFY_KEY' })
    return
  }

  let body
  try {
    body = await readBodyBuffer(req, TINIFY_MAX_BYTES)
  } catch {
    sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' })
    return
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: 'EMPTY_BODY' })
    return
  }

  try {
    const authorization = `Basic ${Buffer.from(`api:${key}`).toString('base64')}`
    const upstream = await fetch('https://api.tinify.com/shrink', {
      method: 'POST',
      headers: { Authorization: authorization },
      body,
      signal: AbortSignal.timeout(TINIFY_TIMEOUT_MS),
    })
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.warn(`Tinify rejected the request (${upstream.status}): ${detail.slice(0, 200)}`)
      sendJson(res, 502, { error: 'TINIFY_FAILED', status: upstream.status })
      return
    }

    const payload = /** @type {{ output?: { url?: unknown } } | null} */ (await upstream.json().catch(() => null))
    const outputUrl = payload?.output?.url
    // Only follow the URL Tinify itself returned, never a client-supplied one.
    if (typeof outputUrl !== 'string' || !outputUrl.startsWith('https://api.tinify.com/')) {
      sendJson(res, 502, { error: 'TINIFY_INVALID_RESPONSE' })
      return
    }

    const image = await fetch(outputUrl, { signal: AbortSignal.timeout(TINIFY_TIMEOUT_MS) })
    if (!image.ok) {
      sendJson(res, 502, { error: 'TINIFY_DOWNLOAD_FAILED' })
      return
    }
    const bytes = Buffer.from(await image.arrayBuffer())
    res.writeHead(200, {
      'Content-Type': image.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(bytes)
  } catch (error) {
    if (!res.headersSent) sendJson(res, 502, { error: 'TINIFY_FAILED' })
    else res.destroy()
    if (!(error instanceof Error) || error.name !== 'TimeoutError') console.error('Tinify proxy failed:', error)
  }
}

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

/**
 * @typedef {{ key: string, isFolder: boolean, size?: number, lastModified?: string }} StoredEntry
 */

/**
 * List the direct children of a directory.
 * @param {string} dirPath
 * @param {string} keyPrefix
 * @returns {Promise<StoredEntry[]>}
 */
async function listDirect(dirPath, keyPrefix) {
  let dirents
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  /** @type {StoredEntry[]} */
  const folders = []
  /** @type {import('node:fs').Dirent[]} */
  const files = []
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    if (dirent.isDirectory()) folders.push({ key: `${keyPrefix}${dirent.name}/`, isFolder: true })
    else if (dirent.isFile()) files.push(dirent)
  }

  // One stat per file is unavoidable for size/mtime; run them with a bounded
  // amount of concurrency instead of serializing the whole directory.
  const fileEntries = await mapLimit(files, 32, async (dirent) => {
    try {
      const stat = await fs.stat(path.join(dirPath, dirent.name))
      return {
        key: `${keyPrefix}${dirent.name}`,
        isFolder: false,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      }
    } catch {
      return null
    }
  })

  return [...folders, ...fileEntries.filter((entry) => entry !== null)]
}

/**
 * Recursively list all files under a directory.
 * @param {string} dirPath
 * @param {string} keyPrefix
 * @param {number} [depth]
 * @returns {Promise<StoredEntry[]>}
 */
async function listRecursive(dirPath, keyPrefix, depth = 0) {
  // Guard against pathological trees (and symlink loops are already skipped).
  if (depth > 64) return []
  let dirents
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  /** @type {import('node:fs').Dirent[]} */
  const folders = []
  /** @type {import('node:fs').Dirent[]} */
  const files = []
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    if (dirent.isDirectory()) folders.push(dirent)
    else if (dirent.isFile()) files.push(dirent)
  }

  const nested = await mapLimit(folders, 8, (dirent) =>
    listRecursive(path.join(dirPath, dirent.name), `${keyPrefix}${dirent.name}/`, depth + 1),
  )
  const fileEntries = await mapLimit(files, 32, async (dirent) => {
    try {
      const stat = await fs.stat(path.join(dirPath, dirent.name))
      return {
        key: `${keyPrefix}${dirent.name}`,
        isFolder: false,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      }
    } catch {
      return null
    }
  })

  return [...nested.flat(), ...fileEntries.filter((entry) => entry !== null)]
}

/**
 * Compute the entry list for a ListObjectsV2 request.
 * The client only uses prefix + delimiter for one-level navigation and
 * exact-key prefixes for existence checks, but this mirrors S3 semantics
 * closely enough for both.
 *
 * @param {string} bucket
 * @param {string} prefix
 * @param {string} delimiter
 * @returns {Promise<StoredEntry[]>}
 */
async function listEntries(bucket, prefix, delimiter) {
  const oneLevel = delimiter === '/'

  // An exact file prefix (used by fileExists) should match that file.
  if (prefix && !prefix.endsWith('/')) {
    const exactPath = resolveObjectPath(bucket, prefix)
    try {
      const stat = await fs.stat(exactPath)
      if (stat.isFile()) {
        return [
          {
            key: prefix,
            isFolder: false,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
          },
        ]
      }
    } catch {
      /* not a file; fall through to prefix listing */
    }
  }

  let dirPath
  let keyPrefix
  if (prefix === '' || prefix.endsWith('/')) {
    dirPath = resolveObjectPath(bucket, prefix)
    keyPrefix = prefix
  } else {
    const slash = prefix.lastIndexOf('/')
    const parentPrefix = slash === -1 ? '' : prefix.slice(0, slash + 1)
    dirPath = resolveObjectPath(bucket, parentPrefix)
    keyPrefix = parentPrefix
  }

  const entries = oneLevel ? await listDirect(dirPath, keyPrefix) : await listRecursive(dirPath, keyPrefix)

  if (prefix && !prefix.endsWith('/')) {
    // Keep only keys sharing the string prefix, per S3 semantics.
    return entries.filter((entry) => entry.key.startsWith(prefix))
  }
  return entries
}

/**
 * A stable ETag for a stored entry. Using `Date.now()` here (as before) made
 * the value change on every request, which defeats conditional requests.
 * @param {StoredEntry} entry
 */
function stableETag(entry) {
  const mtime = entry.lastModified ? Date.parse(entry.lastModified) : 0
  return `"${(entry.size ?? 0).toString(16)}-${Number.isFinite(mtime) ? Math.floor(mtime).toString(16) : '0'}"`
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {{ prefix?: string, delimiter?: string, maxKeys?: number, token?: string }} options
 */
async function renderListResponse(res, bucket, { prefix = '', delimiter = '', maxKeys = 1000, token = '' }) {
  const entries = await listEntries(bucket, prefix, delimiter)
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const offset = parseNonNegativeInt(token, 0)
  const page = maxKeys > 0 ? entries.slice(offset, offset + maxKeys) : []
  const isTruncated = maxKeys > 0 && offset + maxKeys < entries.length
  const nextToken = isTruncated ? String(offset + maxKeys) : ''

  const folders = page.filter((entry) => entry.isFolder)
  const files = page.filter((entry) => !entry.isFolder)

  const contents = files
    .map(
      (entry) => `<Contents>
        <Key>${xmlEscape(entry.key)}</Key>
        <LastModified>${xmlEscape(entry.lastModified || new Date().toISOString())}</LastModified>
        <ETag>${xmlEscape(stableETag(entry))}</ETag>
        <Size>${entry.size ?? 0}</Size>
        <StorageClass>STANDARD</StorageClass>
      </Contents>`,
    )
    .join('')

  const commonPrefixes = folders
    .map((entry) => `<CommonPrefixes><Prefix>${xmlEscape(entry.key)}</Prefix></CommonPrefixes>`)
    .join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>${xmlEscape(bucket)}</Name>
  <Prefix>${xmlEscape(prefix)}</Prefix>
  <KeyCount>${page.length}</KeyCount>
  <MaxKeys>${maxKeys}</MaxKeys>
  <Delimiter>${xmlEscape(delimiter)}</Delimiter>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${xmlEscape(nextToken)}</NextContinuationToken>` : ''}
  ${contents}
  ${commonPrefixes}
</ListBucketResult>`

  return sendXml(res, 200, xml)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {string} key
 * @param {{ disposition?: string, cacheControl?: string, extraHeaders?: Record<string, string> }} [options]
 */
async function handleGetObject(req, res, bucket, key, options = {}) {
  const objectPath = resolveObjectPath(bucket, key)
  let stat
  try {
    await assertInsideBucket(bucket, objectPath)
    stat = await fs.stat(objectPath)
  } catch {
    sendText(res, 404, 'Not Found')
    return
  }
  if (stat.isDirectory()) {
    sendText(res, 404, 'Not Found')
    return
  }

  const storedType = await getContentType(bucket, key)
  const contentType = storedType || mimeType(objectPath)
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const headers = {
    'Content-Type': contentType,
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl || 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
  // Uploaded HTML/SVG/XML is served from the app origin. Sandboxing those
  // responses prevents an uploaded file from running script with the user's
  // session when opened directly.
  if (/^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)(?:;|$)/i.test(contentType)) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
  }
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders)

  if (!req.headers.range && isNotModified(req, etag, stat.mtime)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
    res.end()
    return
  }

  const requestedDisposition = req.url
    ? new URL(req.url, 'http://localhost').searchParams.get('response-content-disposition')
    : null
  if (options.disposition !== undefined) {
    if (options.disposition) headers['Content-Disposition'] = options.disposition
  } else if (requestedDisposition && requestedDisposition.length <= 4096 && !/[\r\n\0]/.test(requestedDisposition)) {
    headers['Content-Disposition'] = requestedDisposition
  }

  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      let start
      let end
      if (match[1]) {
        start = parseInt(match[1], 10)
        end = match[2] ? parseInt(match[2], 10) : stat.size - 1
      } else {
        const suffix = parseInt(match[2], 10)
        start = Math.max(0, stat.size - suffix)
        end = stat.size - 1
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      end = Math.min(end, stat.size - 1)
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      pipeFileStream(createReadStream(objectPath, { start, end }), res)
      return
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeFileStream(createReadStream(objectPath), res)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {string} key
 */
async function handlePutObject(req, res, bucket, key) {
  if (!key) {
    sendText(res, 400, 'Object key is required')
    return
  }

  const copySource = req.headers['x-amz-copy-source']
  if (typeof copySource === 'string') {
    await handleCopyObject(req, res, bucket, key, copySource)
    return
  }

  const contentType = String(req.headers['content-type'] || '')
  const objectPath = resolveObjectPath(bucket, key)

  if (key.endsWith('/')) {
    const contentLength = Number(req.headers['content-length'] || 0)
    // A chunked body has no Content-Length at all, so it must be rejected too
    // instead of being silently drained and dropped.
    if ((Number.isFinite(contentLength) && contentLength > 0) || req.headers['transfer-encoding']) {
      // Folder-marker PUTs must be empty. Refusing a non-empty body avoids
      // silently discarding an uploaded file whose key ends with "/".
      await consumeBody(req)
      sendText(res, 400, 'A file key must not end with "/"')
      return
    }
    await consumeBody(req)
    await fs.mkdir(objectPath, { recursive: true })
    await assertInsideBucket(bucket, path.dirname(objectPath))
    sendEmpty(res, 200, { ETag: '"folder"', ...s3CorsHeaders() })
    return
  }

  const parentDir = path.dirname(objectPath)
  await fs.mkdir(parentDir, { recursive: true })
  // A symlinked directory inside the bucket must not redirect writes outside.
  await assertInsideBucket(bucket, parentDir)
  // Stage the body outside the bucket: a half-written object must never be
  // visible to a concurrent listing, and a crashed upload must not leave a
  // bogus file behind.
  const tmpPath = path.join(TMP_DIR, `${crypto.randomUUID()}.upload`)
  try {
    await pipeRequest(req, tmpPath)
    await fs.rename(tmpPath, objectPath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }

  await setContentType(bucket, key, contentType)
  sendEmpty(res, 200, {
    ETag: `"${crypto.randomUUID()}"`,
    ...s3CorsHeaders(),
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {string} destKey
 * @param {string} copySource
 */
async function handleCopyObject(req, res, bucket, destKey, copySource) {
  const decoded = safeDecode(copySource.replace(/^\/+/, ''))
  const slash = decoded.indexOf('/')
  if (slash === -1) {
    sendText(res, 400, 'Invalid x-amz-copy-source')
    return
  }
  const sourceBucket = decoded.slice(0, slash)
  const sourceKey = decoded.slice(slash + 1)

  if (!isValidBucket(sourceBucket)) {
    sendText(res, 400, 'Invalid source bucket')
    return
  }

  // Drain the (empty) request body.
  await consumeBody(req)

  const sourcePath = resolveObjectPath(sourceBucket, sourceKey)
  const destPath = resolveObjectPath(bucket, destKey)
  const replaceMetadata = String(req.headers['x-amz-metadata-directive'] || '').toUpperCase() === 'REPLACE'

  if (sourcePath !== destPath) {
    let stat
    try {
      await assertInsideBucket(sourceBucket, sourcePath)
      stat = await fs.stat(sourcePath)
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid key') {
        sendText(res, 400, 'Invalid x-amz-copy-source')
        return
      }
      sendText(res, 404, 'Not Found')
      return
    }

    if (stat.isDirectory()) {
      // Folder keys are virtual in S3 but real directories here. Create the
      // destination directory; contained files are copied individually by
      // the client. This also preserves empty folders.
      await fs.mkdir(destPath, { recursive: true })
    } else {
      await fs.mkdir(path.dirname(destPath), { recursive: true })
      await assertInsideBucket(bucket, path.dirname(destPath))
      await fs.copyFile(sourcePath, destPath)

      const sourceType = await getContentType(sourceBucket, sourceKey)
      let nextType = sourceType
      if (replaceMetadata) nextType = String(req.headers['content-type'] || '')
      await setContentType(bucket, destKey, nextType)
    }
  } else if (replaceMetadata) {
    await setContentType(bucket, destKey, String(req.headers['content-type'] || ''))
  }

  sendXml(
    res,
    200,
    `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <ETag>"${crypto.randomUUID()}"</ETag>
  <LastModified>${new Date().toISOString()}</LastModified>
</CopyObjectResult>`,
  )
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {string} key
 */
async function handleDeleteObject(req, res, bucket, key) {
  if (!key) {
    sendText(res, 400, 'Object key is required')
    return
  }
  const objectPath = resolveObjectPath(bucket, key)
  try {
    const stat = await fs.stat(objectPath)
    if (stat.isDirectory()) {
      await fs.rm(objectPath, { recursive: true, force: true })
      await removeContentTypePrefix(bucket, key)
    } else {
      await fs.unlink(objectPath)
      await removeContentType(bucket, key)
    }
  } catch (error) {
    // S3 DELETE is idempotent, but only for missing objects. Permission or
    // EBUSY failures must not be reported as a successful delete.
    if (errorCode(error) !== 'ENOENT') throw error
  }
  sendEmpty(res, 204, s3CorsHeaders())
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {string} key
 * @param {URLSearchParams} params
 */
async function handleMultipart(req, res, bucket, key, params) {
  const uploadIdParam = params.get('uploadId')
  if (uploadIdParam !== null && !isValidUploadId(uploadIdParam)) {
    sendText(res, 404, 'NoSuchUpload')
    return
  }

  if (req.method === 'POST' && params.has('uploads')) {
    // Validate the target key before storing any upload state. Rejecting
    // folder/empty keys and traversal segments up front keeps multipart
    // bookkeeping consistent with regular PUT requests.
    try {
      if (!key || key.endsWith('/')) throw new Error('Invalid key')
      resolveObjectPath(bucket, key)
    } catch {
      await consumeBody(req)
      sendText(res, 400, 'Invalid object key')
      return
    }
    await pruneStaleUploads()
    const uploadId = crypto.randomUUID()
    multipartUploads.set(uploadId, {
      bucket,
      key,
      contentType: String(req.headers['content-type'] || ''),
      createdAt: Date.now(),
    })
    await fs.mkdir(uploadPath(uploadId), { recursive: true })
    await consumeBody(req)
    sendXml(
      res,
      200,
      `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`,
    )
    return
  }

  if (req.method === 'PUT' && uploadIdParam && params.has('partNumber')) {
    const upload = multipartUploads.get(uploadIdParam)
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      sendText(res, 404, 'NoSuchUpload')
      return
    }
    const partNumber = parseInt(params.get('partNumber'), 10)
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      sendText(res, 400, 'Invalid part number')
      return
    }
    const partFilePath = path.join(uploadPath(uploadIdParam), `part-${partNumber}`)
    const partTmpPath = `${partFilePath}.${crypto.randomUUID()}.tmp`
    try {
      await pipeRequest(req, partTmpPath)
      await fs.rename(partTmpPath, partFilePath)
    } catch (error) {
      await fs.rm(partTmpPath, { force: true }).catch(() => {})
      throw error
    }
    sendEmpty(res, 200, {
      ETag: `"${crypto.randomUUID()}"`,
      ...s3CorsHeaders(),
    })
    return
  }

  if (req.method === 'POST' && uploadIdParam) {
    const upload = multipartUploads.get(uploadIdParam)
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      sendText(res, 404, 'NoSuchUpload')
      return
    }

    let bodyText
    try {
      bodyText = (await readBodyBuffer(req, MULTIPART_COMPLETE_MAX_BYTES)).toString('utf8')
    } catch {
      sendText(res, 400, 'InvalidCompleteMultipartUpload')
      return
    }

    // Honour the part list the client sends (S3 semantics) instead of
    // blindly concatenating every leftover part file in the directory.
    const requested = [...bodyText.matchAll(/<Part>[\s\S]*?<PartNumber>\s*(\d+)\s*<\/PartNumber>[\s\S]*?<\/Part>/g)]
      .map((match) => parseInt(match[1], 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 10000)

    const partDir = uploadPath(uploadIdParam)
    let partNames
    try {
      partNames = await fs.readdir(partDir)
    } catch {
      partNames = []
    }
    const available = new Set(
      partNames
        .map((name) => /^part-(\d+)$/.exec(name)?.[1])
        .filter((value) => Boolean(value))
        .map((value) => parseInt(/** @type {string} */ (value), 10)),
    )

    const partNumbers = [...new Set(requested)].sort((a, b) => a - b)
    if (partNumbers.length === 0) {
      sendText(res, 400, 'No parts uploaded')
      return
    }
    if (partNumbers.some((partNumber) => !available.has(partNumber))) {
      sendText(res, 400, 'Missing part')
      return
    }

    const destPath = resolveObjectPath(bucket, key)
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await assertInsideBucket(bucket, path.dirname(destPath))
    const tmpPath = path.join(TMP_DIR, `${crypto.randomUUID()}.multipart`)

    async function* readParts() {
      for (const partNumber of partNumbers) {
        const stream = createReadStream(path.join(partDir, `part-${partNumber}`))
        for await (const chunk of stream) yield chunk
      }
    }

    try {
      await pipeline(Readable.from(readParts()), createWriteStream(tmpPath))
      await fs.rename(tmpPath, destPath)
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }

    await setContentType(bucket, key, upload.contentType)
    multipartUploads.delete(uploadIdParam)
    await fs.rm(partDir, { recursive: true, force: true }).catch(() => {})

    sendXml(
      res,
      200,
      `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult>
  <Location>/${xmlEscape(bucket)}/${xmlEscape(key)}</Location>
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <ETag>"${crypto.randomUUID()}"</ETag>
</CompleteMultipartUploadResult>`,
    )
    return
  }

  if (req.method === 'DELETE' && uploadIdParam) {
    const upload = multipartUploads.get(uploadIdParam)
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      // Only uploads this process knows about may be deleted. Validating the
      // ID format and map membership keeps this path from touching anything
      // outside UPLOAD_DIR.
      sendText(res, 404, 'NoSuchUpload')
      return
    }
    multipartUploads.delete(uploadIdParam)
    await fs.rm(uploadPath(uploadIdParam), { recursive: true, force: true }).catch(() => {})
    sendEmpty(res, 204, s3CorsHeaders())
    return
  }

  sendText(res, 400, 'Unsupported multipart request')
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} bucket
 * @param {URLSearchParams} params
 */
function handleListMultipartUploads(res, bucket, params) {
  const uploads = [...multipartUploads.entries()].filter(([, upload]) => upload.bucket === bucket)
  const keyMarker = params.get('key-marker') || ''
  const uploadIdMarker = params.get('upload-id-marker') || ''
  const maxUploads = Math.max(1, Math.min(1000, parseNonNegativeInt(params.get('max-uploads'), 1000)))

  let startIndex = 0
  if (keyMarker || uploadIdMarker) {
    const markerIndex = uploads.findIndex(
      ([uploadId, upload]) => upload.key === keyMarker && uploadId === uploadIdMarker,
    )
    if (markerIndex >= 0) startIndex = markerIndex + 1
  }

  const page = uploads.slice(startIndex, startIndex + maxUploads)
  const isTruncated = startIndex + maxUploads < uploads.length
  const lastUpload = page[page.length - 1]

  const items = page
    .map(
      ([uploadId, upload]) => `<Upload>
        <Key>${xmlEscape(upload.key)}</Key>
        <UploadId>${uploadId}</UploadId>
        <Initiated>${new Date(upload.createdAt).toISOString()}</Initiated>
      </Upload>`,
    )
    .join('')

  sendXml(
    res,
    200,
    `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult>
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <KeyMarker>${xmlEscape(keyMarker)}</KeyMarker>
  <UploadIdMarker>${xmlEscape(uploadIdMarker)}</UploadIdMarker>
  <NextKeyMarker>${isTruncated && lastUpload ? xmlEscape(lastUpload[1].key) : ''}</NextKeyMarker>
  <NextUploadIdMarker>${isTruncated && lastUpload ? lastUpload[0] : ''}</NextUploadIdMarker>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${items}
</ListMultipartUploadsResult>`,
  )
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} destPath
 */
async function pipeRequest(req, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  // `pipeline` handles backpressure and, crucially, forwards errors from both
  // the request and the write stream (ENOSPC, EACCES, client abort).
  await pipeline(req, createWriteStream(destPath))
}

/** @param {import('node:http').IncomingMessage} req */
async function consumeBody(req) {
  for await (const _chunk of req) {
    /* drain */
  }
}

// ---------------------------------------------------------------------------
// S3 router
// ---------------------------------------------------------------------------

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleS3(req, res, url) {
  const rest = url.pathname.slice('/s3/'.length)
  const slash = rest.indexOf('/')
  const bucket = safeDecode(slash === -1 ? rest : rest.slice(0, slash))
  const key = slash === -1 ? '' : safeDecode(rest.slice(slash + 1))

  if (!isValidBucket(bucket)) {
    sendText(res, 400, 'Invalid bucket name')
    return
  }

  const params = url.searchParams

  try {
    if (req.method === 'GET' && params.has('uploads') && !key) {
      return handleListMultipartUploads(res, bucket, params)
    }

    if (req.method === 'POST' && (params.has('uploads') || params.has('uploadId'))) {
      return await handleMultipart(req, res, bucket, key, params)
    }

    if (req.method === 'PUT' && (params.has('partNumber') || params.has('uploadId'))) {
      return await handleMultipart(req, res, bucket, key, params)
    }

    if (req.method === 'DELETE' && params.has('uploadId')) {
      return await handleMultipart(req, res, bucket, key, params)
    }

    const isListRequest = !key && (params.get('list-type') === '2' || req.method === 'GET' || req.method === 'HEAD')
    if (isListRequest) {
      if (req.method !== 'GET') {
        sendText(res, 405, 'Method Not Allowed')
        return
      }
      const prefix = params.get('prefix') || ''
      const delimiter = params.get('delimiter') || ''
      const maxKeys = Math.min(1000, parseNonNegativeInt(params.get('max-keys'), 1000))
      const token = params.get('continuation-token') || ''
      return await renderListResponse(res, bucket, { prefix, delimiter, maxKeys, token })
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return await handleGetObject(req, res, bucket, key)
    }

    if (req.method === 'PUT') {
      return await handlePutObject(req, res, bucket, key)
    }

    if (req.method === 'DELETE') {
      return await handleDeleteObject(req, res, bucket, key)
    }

    sendText(res, 405, 'Method Not Allowed')
  } catch (error) {
    // A client that disconnects mid-upload is not a server error.
    const code = errorCode(error)
    const clientAbort =
      code === 'ECONNRESET' ||
      code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      (error instanceof Error && error.message === 'aborted')
    if (clientAbort) {
      res.destroy()
      return
    }
    const invalidKey = error instanceof Error && error.message === 'Invalid key'
    if (!invalidKey) console.error('S3 request failed:', error)
    if (!res.headersSent) sendText(res, invalidKey ? 400 : 500, invalidKey ? 'Invalid key' : 'Internal Server Error')
    else res.destroy()
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

await fs.mkdir(path.join(DATA_DIR, LOCAL_BUCKET), { recursive: true })
await fs.rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => {})
await fs.mkdir(UPLOAD_DIR, { recursive: true })
// Staged bodies never survive a restart: they are either renamed into place or
// discarded along with the interrupted request.
await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {})
await fs.mkdir(TMP_DIR, { recursive: true })
await initDummyAuthUser()
await initAuth()
await initShareSecret()

// Last-resort guards: one bad request must not take the whole file server
// down (e.g. a stream error that somehow escapes a request handler).
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'OPTIONS') {
      sendEmpty(res, 204, s3CorsHeaders())
      return
    }

    if (url.pathname === '/login') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed')
        return
      }
      if (isAuthenticated(req)) {
        sendRedirect(res, '/')
        return
      }
      sendLoginPage(req, res)
      return
    }

    if (url.pathname === '/api/login') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      await handleLogin(req, res)
      return
    }

    if (url.pathname === '/api/login/challenge') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      handleCreateSliderChallenge(req, res)
      return
    }

    if (url.pathname === '/api/login/challenge/verify') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      await handleVerifySliderChallenge(req, res)
      return
    }

    if (url.pathname === '/api/logout') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      handleLogout(req, res)
      return
    }

    // Share pages and APIs are public: the signed token itself grants
    // read-only access, so no session is required.
    if (url.pathname.startsWith('/share/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed')
        return
      }
      const tokenPart = url.pathname.slice('/share/'.length)
      if (!tokenPart || tokenPart.includes('/')) {
        sendText(res, 404, 'Not Found')
        return
      }
      await sendSharePage(req, res)
      return
    }

    if (url.pathname.startsWith('/api/share/')) {
      await handleShareApi(req, res, url)
      return
    }

    if (PUBLIC_ASSETS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveStatic(req, res, url.pathname)
      return
    }

    if (!isAuthenticated(req)) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s3/')) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' })
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendRedirect(res, `/login?next=${encodeURIComponent(safeNextPath(url.pathname + url.search))}`)
        return
      }
      sendText(res, 401, 'Unauthorized')
      return
    }

    if (url.pathname === '/api/share') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      await handleCreateShare(req, res)
      return
    }

    if (url.pathname === '/api/tinify/compress') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      await handleTinifyCompress(req, res)
      return
    }

    if (
      url.pathname === '/api/auth/me' ||
      url.pathname === '/api/auth/change-password' ||
      url.pathname === '/api/users' ||
      url.pathname.startsWith('/api/users/')
    ) {
      await handleAuthApi(req, res, url)
      return
    }

    if (url.pathname === '/api/local-mode') {
      const current = getCurrentUser(req)
      sendJson(res, 200, {
        mode: 'local',
        endpoint: '/s3',
        bucket: LOCAL_BUCKET,
        authEnabled: Boolean(authStore),
        authUser: current?.username || '',
        authRole: current?.role || '',
      })
      return
    }

    if (url.pathname.startsWith('/s3/')) {
      await handleS3(req, res, url)
      return
    }

    if (url.pathname === '/' || !url.pathname.startsWith('/s3')) {
      await serveStatic(req, res, url.pathname)
      return
    }

    sendText(res, 404, 'Not Found')
  } catch (error) {
    console.error(error)
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error')
    else res.destroy()
  }
})

server.on('error', (error) => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
    console.error(
      `\n  ✗ 端口 ${PORT} 已被占用。请先停止占用该端口的进程（可能是之前启动的 serve 或 node server.js），\n` +
        `    或使用 --port 指定其他端口，例如：node server.js --port 5600\n`,
    )
  } else {
    console.error(error)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST
  console.log(`\n  Web-FileSystem (local mode)`)
  console.log(`  ➜  http://${displayHost}:${PORT}`)
  console.log(`  ➜  data: ${DATA_DIR}`)
  console.log(`  ➜  bucket: ${LOCAL_BUCKET}`)
  if (authStore) {
    if (generatedPassword) {
      console.log(
        `  ➜  auth: user "${generatedPasswordUser}" / password "${generatedPassword}" (generated, shown only once)`,
      )
    } else {
      const admins = authStore.users
        .filter((user) => user.role === 'admin')
        .map((user) => `"${user.username}"`)
        .join(', ')
      console.log(
        `  ➜  auth: ${authStore.users.length} user(s), admin: ${admins || 'none'} (password hashes stored in ${AUTH_FILE})`,
      )
    }
  } else {
    console.log('  ➜  auth: disabled')
  }
  console.log('')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    if (authStore) {
      console.warn(
        '  ⚠  Server is bound to a non-loopback address; sign-in is required but use HTTPS on untrusted networks.\n',
      )
    } else {
      console.warn(
        '  ⚠  Server is bound to a non-loopback address with authentication disabled; anyone on the network can access the data folder.\n',
      )
    }
  }
})
