import { STORAGE_KEY } from './constants.js'

/**
 * @typedef {{
 *   endpoint?: string
 *   bucket?: string
 *   filenameTpl?: string
 *   filenameTplScope?: string
 *   compressMode?: string
 *   compressLevel?: string
 *   tinifyKey?: string
 *   uploadConcurrency?: number
 * }} AppConfig
 */

/**
 * Persists the connection details assigned by the bundled server plus the
 * user's preferences. There are no credentials in local mode.
 */
class ConfigManager {
  /** @returns {AppConfig} */
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') || {}
    } catch {
      return {}
    }
  }

  /** @param {AppConfig} cfg */
  save(cfg) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
    } catch {
      /* storage can be unavailable in private browsing */
    }
  }

  /** @returns {AppConfig} */
  get() {
    return this.load()
  }

  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
  }

  /** The app is usable once the local server has told us where its bucket is. */
  isReady() {
    const cfg = this.load()
    return Boolean(cfg.endpoint && cfg.bucket)
  }

  getBucketUrl() {
    const cfg = this.load()
    const endpoint = (cfg.endpoint || '/s3').replace(/\/+$/, '')
    return `${endpoint}/${cfg.bucket || 'local'}`
  }
}

export { ConfigManager }
