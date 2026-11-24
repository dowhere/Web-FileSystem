import {
  VERSION,
  UPDATED_AT,
  THEME_KEY,
  VIEW_KEY,
  DENSITY_KEY,
  SORT_BY_KEY,
  SORT_ORDER_KEY,
  MAX_UPLOAD_SIZE,
} from './constants.js'
import { ConfigManager } from './config-manager.js'
import { FileExplorer } from './file-explorer.js'
import { FileOperations } from './file-operations.js'
import { FilePreview } from './file-preview.js'
import { UploadManager } from './upload-manager.js'
import { StorageClient } from './storage-client.js'
import { UIManager } from './ui-manager.js'
import { getCurrentLang, setLang, t } from './i18n.js'
import { $, getErrorMessage } from './utils.js'
import dayjs from 'dayjs'
import { filesize } from 'filesize'

/** @typedef {'zh'|'en'|'ja'} Lang */
/** @typedef {{ username: string; role: 'admin' | 'member'; createdAt: number }} AccountUser */

/** @param {Response} response @returns {Promise<string>} */
async function getApiError(response) {
  try {
    const data = await response.json()
    return data && typeof data.error === 'string' ? data.error : ''
  } catch {
    return ''
  }
}

class App {
  /** @type {ConfigManager} */
  #config
  /** @type {StorageClient} */
  #storage
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer | null} */
  #explorer = null
  /** @type {UploadManager | null} */
  #upload = null
  /** @type {FilePreview | null} */
  #preview = null
  /** @type {FileOperations | null} */
  #ops = null
  #appEventsBound = false
  #batchMode = false
  /** @type {{ enabled: boolean; user: string; role: 'admin' | 'member' | '' } | null} */
  #auth = null
  /** @type {string} */
  #resetPasswordUser = ''
  /** @type {((e: TransitionEvent) => void) | null} */
  #onBarTransitionEnd = null

  constructor() {
    this.#config = new ConfigManager()
    this.#storage = new StorageClient()
    this.#ui = new UIManager()

    this.#ui.initTheme()
    this.#ui.initTooltip()

    this.#applyI18nToHTML()
    this.#tryLocalMode()

    this.#bindGlobalEvents()
    this.#bindHeroEvents()
  }

  #applyI18nToHTML() {
    document.title = t('appTitle')
    const lang = getCurrentLang()
    document.documentElement.lang = lang === 'zh_TW' ? 'zh-TW' : lang
    $('.topbar-title').textContent = t('appTitle')

    const heroTitle = $('#hero-title')
    if (heroTitle) heroTitle.textContent = t('appTitle')
    const heroDesc = $('#hero-desc')
    if (heroDesc) heroDesc.textContent = t('heroDesc')
    const heroConnectText = $('#hero-connect-text')
    if (heroConnectText) heroConnectText.textContent = t('heroConnect')
    const heroF1 = $('#hero-f1')
    if (heroF1) heroF1.textContent = t('heroF1')
    const heroF2 = $('#hero-f2')
    if (heroF2) heroF2.textContent = t('heroF2')
    const heroF3 = $('#hero-f3')
    if (heroF3) heroF3.textContent = t('heroF3')
    const heroF4 = $('#hero-f4')
    if (heroF4) heroF4.textContent = t('heroF4')
    const heroF5 = $('#hero-f5')
    if (heroF5) heroF5.textContent = t('heroF5')
    const heroF6 = $('#hero-f6')
    if (heroF6) heroF6.textContent = t('heroF6')
    const heroF7 = $('#hero-f7')
    if (heroF7) heroF7.textContent = t('heroF7')

    $('#tab-preferences').textContent = t('configTabPreferences')
    $('#tab-upload').textContent = t('configTabUpload')
    $('#tab-compression').textContent = t('configTabCompression')
    $('#tab-account').textContent = t('configTabAccount')
    $('#tab-about').textContent = t('configTabAbout')

    $('#lbl-theme').textContent = t('lblTheme')
    const themeSelect = $('#cfg-theme')
    if (themeSelect) {
      $('option[value="light"]', themeSelect).textContent = t('themeLight')
      $('option[value="dark"]', themeSelect).textContent = t('themeDark')
      $('option[value="auto"]', themeSelect).textContent = t('themeAuto')
    }

    $('#lbl-language').textContent = t('lblLanguage')

    $('#lbl-density').textContent = t('lblDensity')
    const densitySelect = $('#cfg-density')
    if (densitySelect) {
      $('option[value="compact"]', densitySelect).textContent = t('densityCompact')
      $('option[value="normal"]', densitySelect).textContent = t('densityNormal')
      $('option[value="loose"]', densitySelect).textContent = t('densityLoose')
    }

    $('#config-title').textContent = t('appTitle')

    $('#lbl-filename-tpl').textContent = t('filenameTpl')
    $('#lbl-filename-tpl-scope').textContent = t('filenameTplScope')
    $('#lbl-upload-concurrency').textContent = t('uploadConcurrency')
    $('#multipart-cleanup-title').textContent = t('multipartCleanupTitle')
    $('#multipart-cleanup-desc').textContent = t('multipartCleanupDesc')
    $('#cleanup-multipart-btn').textContent = t('multipartCleanupButton')
    const filenameScopeSelect = $('#cfg-filename-tpl-scope')
    if (filenameScopeSelect) {
      $('option[value="images"]', filenameScopeSelect).textContent = t('filenameTplScopeImages')
      $('option[value="all"]', filenameScopeSelect).textContent = t('filenameTplScopeAll')
    }
    $('#filename-tpl-hint').textContent = t('filenameTplHintDetailed')

    $('#lbl-compress-mode').textContent = t('compressMode')

    const compressModeSelect = $('#cfg-compress-mode')
    if (compressModeSelect) {
      $('option[value="none"]', compressModeSelect).textContent = t('compressModeNone')
      $('option[value="local"]', compressModeSelect).textContent = t('compressModeLocal')
      $('option[value="tinify"]', compressModeSelect).textContent = t('compressModeTinify')
    }

    $('#lbl-compress-level').textContent = t('compressLevel')

    const compressLevelSelect = $('#cfg-compress-level')
    if (compressLevelSelect) {
      $('option[value="balanced"]', compressLevelSelect).textContent = t('compressLevelBalanced')
      $('option[value="extreme"]', compressLevelSelect).textContent = t('compressLevelExtreme')
    }

    $('#lbl-tinify-key').textContent = 'Tinify API Key'
    $('#tinify-key-hint-text').textContent = t('tinifyKeyHintText')
    $('#tinify-key-link').textContent = t('tinifyKeyLink')

    $('#config-cancel').textContent = t('cancel')
    $('#config-submit').textContent = t('save')
    $('#config-dialog-close').dataset.tooltip = t('close')

    $('#about-version').textContent = `v${VERSION}`
    $('#about-updated').textContent = `${t('aboutUpdatedLabel')}: ${dayjs(UPDATED_AT).format('YYYY-MM-DD HH:mm:ss')}`
    $('#about-description').textContent = t('aboutDescription')
    $('#about-license-label').textContent = t('aboutLicense')
    $('#about-logout').textContent = t('aboutLogout')
    this.#updateAboutPanel()

    $('#account-title').textContent = t('accountTitle')
    $('#account-change-password').textContent = t('accountChangePassword')
    $('#account-users-title').textContent = t('accountUsersTitle')
    $('#account-users-desc').textContent = t('accountUsersDesc')
    $('#account-add-user').textContent = t('accountAddUser')

    $('#password-dialog-title').textContent = t('accountPasswordDialogTitle')
    $('#password-dialog-desc').textContent = t('accountPasswordDialogDesc')
    $('#password-current-label').textContent = t('accountCurrentPassword')
    $('#password-new-label').textContent = t('accountNewPassword')
    $('#password-confirm-label').textContent = t('accountConfirmPassword')
    $('#password-new-hint').textContent = t('accountPasswordHint')
    $('#password-cancel').textContent = t('cancel')
    $('#password-submit').textContent = t('save')

    $('#user-dialog-title').textContent = t('accountAddUserTitle')
    $('#user-username-label').textContent = t('accountUsername')
    $('#user-role-label').textContent = t('accountRole')
    $('#user-role-hint').textContent = t('accountRoleHint')
    $('#user-password-label').textContent = t('accountUserPassword')
    $('#user-password-hint').textContent = t('accountPasswordHint')
    $('#user-cancel').textContent = t('cancel')
    $('#user-submit').textContent = t('accountAdd')
    const userRoleSelect = $('#user-role')
    if (userRoleSelect) {
      $('option[value="member"]', userRoleSelect).textContent = t('accountRoleMember')
      $('option[value="admin"]', userRoleSelect).textContent = t('accountRoleAdmin')
    }

    $('#reset-password-title').textContent = t('accountResetTitle')
    $('#reset-password-label').textContent = t('accountNewPassword')
    $('#reset-password-hint').textContent = t('accountPasswordHint')
    $('#reset-password-cancel').textContent = t('cancel')
    $('#reset-password-submit').textContent = t('save')

    $('#help-theme').dataset.tooltip = t('tooltipTheme')
    $('#help-language').dataset.tooltip = t('tooltipLanguage')
    $('#help-density').dataset.tooltip = t('tooltipDensity')

    $('#help-filename-tpl').dataset.tooltip = t('tooltipFilenameTpl')
    $('#help-filename-tpl-scope').dataset.tooltip = t('tooltipFilenameTplScope')
    $('#help-compress-mode').dataset.tooltip = t('tooltipCompressMode')
    $('#help-compress-level').dataset.tooltip = t('tooltipCompressLevel')
    $('#help-tinify-key').dataset.tooltip = t('tooltipTinifyKey')

    $('#sort-asc-btn').dataset.tooltip = t('sortAsc')
    $('#sort-desc-btn').dataset.tooltip = t('sortDesc')

    $('#view-grid-btn').dataset.tooltip = t('viewGrid')
    $('#view-list-btn').dataset.tooltip = t('viewList')

    $('#sort-name-btn').dataset.tooltip = t('sortName')
    $('#sort-date-btn').dataset.tooltip = t('sortDate')
    $('#sort-size-btn').dataset.tooltip = t('sortSize')

    $('#new-folder-btn span').textContent = t('newFolder')
    $('#upload-btn span').textContent = t('upload')

    $('#dropzone-text').textContent = t('dropToUpload')

    $('#empty-state p').textContent = t('emptyFolder')
    $('#empty-upload-btn').lastChild.textContent = ' ' + t('uploadFiles')
    $('#empty-upload-hint').textContent = t('uploadHint', {
      size: filesize(MAX_UPLOAD_SIZE, { standard: 'iec' }),
    })
    $('#paste-hint-text').textContent = t('pasteHint')

    $('#load-more-btn').textContent = t('loadMore')
    this.#explorer?.updateCountDisplay()

    $('[data-action="preview"] span').textContent = t('preview')
    $('[data-action="download"] span').textContent = t('download')
    $('#ctx-copy-link > span').textContent = t('copyLink')
    $('[data-action="copyPath"] span').textContent = t('copyPath')
    $('[data-action="copyUrl"] span').textContent = t('copyUrl')
    $('[data-action="copyMarkdown"] span').textContent = t('copyMarkdown')
    $('[data-action="copyHtml"] span').textContent = t('copyHtml')
    $('[data-action="copyImage"] span').textContent = t('copyImage')
    $('[data-action="shareQr"] span').textContent = t('shareQr')
    $('[data-action="shareLink"] span').textContent = t('linkShare')
    $('[data-action="editContentType"] span').textContent = t('editContentType')
    $('[data-action="rename"] span').textContent = t('rename')
    $('[data-action="copy"] span').textContent = t('copy')
    $('[data-action="move"] span').textContent = t('move')
    $('[data-action="delete"] span').textContent = t('delete')

    $('#settings-btn').dataset.tooltip = t('settings')
    $('#logout-btn').dataset.tooltip = t('logout')
    $('#refresh-btn').dataset.tooltip = t('refresh')
    $('#share-dir-btn').dataset.tooltip = t('shareCurrentDir')
    $('#preview-copy-text').dataset.tooltip = t('copyText')
    $('#preview-copy-image').dataset.tooltip = t('copyImage')
    $('#preview-copy').dataset.tooltip = t('copyLink')
    $('#preview-download').dataset.tooltip = t('download')
    $('#preview-close').dataset.tooltip = t('close')
    $('#file-qr-close').dataset.tooltip = t('close')
    $('#view-grid-btn').dataset.tooltip = t('viewGrid')
    $('#view-list-btn').dataset.tooltip = t('viewList')
    $('#upload-panel-close').dataset.tooltip = t('close')

    $('#prompt-cancel').textContent = t('cancel')
    $('#prompt-ok').textContent = t('ok')

    $('#confirm-cancel').textContent = t('cancel')
    $('#confirm-ok').textContent = t('confirm')

    $('#filename-path-title').textContent = t('filenameTplPathTitle')
    $('#filename-path-desc').textContent = t('filenameTplPathDesc')
    $('#filename-path-cancel').textContent = t('cancel')
    $('#filename-path-ok').textContent = t('confirm')

    $('#file-qr-title').textContent = t('fileQrTitle')
    $('#file-qr-desc').textContent = t('fileQrDesc')
    $('#file-qr-copy-text').textContent = t('copyLink')

    $('#share-link-dialog-title').textContent = t('linkShareTitle')
    $('#share-link-dialog-desc').textContent = t('linkShareDesc')
    $('#share-link-expiry-label').textContent = t('linkShareExpiry')
    $('#share-link-expiry-1d').textContent = t('linkShareExpiry1d')
    $('#share-link-expiry-7d').textContent = t('linkShareExpiry7d')
    $('#share-link-expiry-30d').textContent = t('linkShareExpiry30d')
    $('#share-link-expiry-1y').textContent = t('linkShareExpiry1y')
    $('#share-link-expiry-never').textContent = t('linkShareExpiryNever')
    $('#share-link-copy-text').textContent = t('copyLink')
    $('#share-link-warning-text').textContent = t('linkShareWarning')
    $('#share-link-dialog-close').dataset.tooltip = t('close')
    $('#share-link-url').setAttribute('aria-label', t('shareUrlLabel'))
    $('#file-qr-url').setAttribute('aria-label', t('shareUrlLabel'))

    this.#updateSelectAllBtn()
    $('#batch-move-text').textContent = t('move')
    $('#batch-copy-text').textContent = t('copy')
    $('#batch-delete-text').textContent = t('delete')
    $('#batch-toggle-text').textContent = t(this.#batchMode ? 'exitBatchMode' : 'batchMode')

    // Icon-only buttons have no text for assistive technology; mirror their
    // (translated) tooltip into an accessible name.
    document.querySelectorAll('button[data-tooltip]').forEach((btn) => {
      const el = /** @type {HTMLElement} */ (btn)
      if (!el.textContent?.trim() && el.dataset.tooltip) el.setAttribute('aria-label', el.dataset.tooltip)
    })

    this.#ui.initTooltip()
  }

  /** @returns {Promise<{ endpoint: string; bucket: string; authEnabled: boolean; authUser: string; authRole: 'admin' | 'member' | '' } | null>} */
  async #fetchLocalModeInfo() {
    try {
      const res = await fetch('/api/local-mode', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!res.ok) return null
      const info = await res.json()
      if (!info || typeof info.endpoint !== 'string' || typeof info.bucket !== 'string') return null
      return {
        endpoint: info.endpoint,
        bucket: info.bucket,
        authEnabled: Boolean(info.authEnabled),
        authUser: typeof info.authUser === 'string' ? info.authUser : '',
        authRole: info.authRole === 'admin' || info.authRole === 'member' ? info.authRole : '',
      }
    } catch {
      return null
    }
  }

  /** @param {{ endpoint: string; bucket: string; authEnabled: boolean; authUser: string; authRole: 'admin' | 'member' | '' }} info */
  #applyLocalMode(info) {
    this.#auth = { enabled: info.authEnabled, user: info.authUser, role: info.authRole }
    this.#config.save({
      ...this.#config.get(),
      endpoint: new URL(info.endpoint, window.location.origin).toString().replace(/\/+$/, ''),
      bucket: info.bucket,
    })
    this.#updateAboutPanel()
  }

  /** Account management only applies when the server has authentication enabled. */
  #canManageAccount() {
    return Boolean(this.#auth?.enabled)
  }

  #updateAboutPanel() {
    const showSession = Boolean(this.#auth?.enabled)
    const session = $('#about-session')
    const label = $('#about-session-label')
    if (session) session.hidden = !showSession
    if (label && showSession) {
      label.textContent = t('aboutSessionLabel', { user: this.#auth?.user || '' })
    }
    // Logging out only makes sense when there is a session to destroy.
    for (const id of ['#logout-btn', '#about-logout']) {
      const button = $(id)
      if (button) button.hidden = !showSession
    }
    const accountTab = $('#tab-account-btn')
    if (accountTab) accountTab.hidden = !this.#canManageAccount()
  }

  /** @param {string} code @returns {string} */
  #accountErrorMessage(code) {
    switch (code) {
      case 'CURRENT_PASSWORD_INCORRECT':
        return t('accountCurrentPasswordWrong')
      case 'WEAK_PASSWORD':
        return t('accountPasswordTooShort')
      case 'PASSWORD_UNCHANGED':
        return t('accountPasswordUnchanged')
      case 'USER_EXISTS':
        return t('accountUserExists')
      case 'INVALID_USERNAME':
        return t('accountInvalidUsername')
      case 'CANNOT_DELETE_SELF':
        return t('accountCannotDeleteSelf')
      case 'LAST_ADMIN':
        return t('accountLastAdmin')
      case 'USER_NOT_FOUND':
        return t('accountUserNotFound')
      case 'FORBIDDEN':
      case 'AUTH_DISABLED':
        return t('accountAdminRequired')
      default:
        return t('accountRequestFailed')
    }
  }

  /** @param {HTMLElement} errorEl @param {string} message */
  #setAccountError(errorEl, message) {
    errorEl.textContent = message
    errorEl.hidden = !message
  }

  async #refreshAccountPanel() {
    if (!this.#canManageAccount() || !this.#auth) return
    const me = this.#auth
    const isAdmin = me.role === 'admin'
    const avatar = $('#account-avatar')
    const username = $('#account-username')
    const role = $('#account-role')
    if (avatar) avatar.textContent = (me.user || '?').slice(0, 1).toLocaleUpperCase()
    if (username) username.textContent = me.user
    if (role) {
      role.textContent = t(isAdmin ? 'accountRoleAdmin' : 'accountRoleMember')
      role.dataset.role = isAdmin ? 'admin' : 'member'
    }
    const usersSection = $('#account-users-section')
    if (usersSection) usersSection.hidden = !isAdmin
    if (isAdmin) await this.#loadAccountUsers()
  }

  async #loadAccountUsers() {
    const list = $('#account-user-list')
    if (!list) return
    list.replaceChildren()
    const loading = document.createElement('p')
    loading.className = 'user-list-message'
    loading.textContent = t('accountLoading')
    list.append(loading)
    try {
      const res = await fetch('/api/users', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) throw new Error('load')
      const data = /** @type {{ users?: AccountUser[]; currentUser?: string }} */ (await res.json())
      const users = Array.isArray(data.users) ? data.users : []
      list.replaceChildren()
      users.forEach((user) => list.append(this.#renderUserRow(user, data.currentUser || '')))
    } catch {
      list.replaceChildren()
      const message = document.createElement('p')
      message.className = 'user-list-message'
      message.textContent = t('accountLoadFailed')
      list.append(message)
    }
  }

  /** @param {AccountUser} user @param {string} currentUsername @returns {HTMLElement} */
  #renderUserRow(user, currentUsername) {
    const isCurrentUser = user.username === currentUsername
    const row = document.createElement('div')
    row.className = 'user-row'

    const avatar = document.createElement('div')
    avatar.className = 'account-avatar sm'
    avatar.setAttribute('aria-hidden', 'true')
    avatar.textContent = (user.username || '?').slice(0, 1).toLocaleUpperCase()

    const info = document.createElement('div')
    info.className = 'user-info'
    const nameLine = document.createElement('div')
    nameLine.className = 'user-name-line'
    const name = document.createElement('strong')
    name.textContent = user.username
    nameLine.append(name)
    if (isCurrentUser) {
      const badge = document.createElement('span')
      badge.className = 'user-current-badge'
      badge.textContent = t('accountCurrentUser')
      nameLine.append(badge)
    }
    const meta = document.createElement('div')
    meta.className = 'user-meta'
    const roleBadge = document.createElement('span')
    roleBadge.className = 'role-badge'
    roleBadge.dataset.role = user.role
    roleBadge.textContent = t(user.role === 'admin' ? 'accountRoleAdmin' : 'accountRoleMember')
    meta.append(roleBadge)
    info.append(nameLine, meta)

    const actions = document.createElement('div')
    actions.className = 'user-actions'
    if (!isCurrentUser) {
      const resetButton = document.createElement('button')
      resetButton.type = 'button'
      resetButton.className = 'btn secondary sm'
      resetButton.textContent = t('accountResetPassword')
      resetButton.onclick = () => this.#openResetPasswordDialog(user.username)
      const deleteButton = document.createElement('button')
      deleteButton.type = 'button'
      deleteButton.className = 'btn danger sm'
      deleteButton.textContent = t('delete')
      deleteButton.onclick = () => void this.#deleteUser(user.username)
      actions.append(resetButton, deleteButton)
    }

    row.append(avatar, info, actions)
    return row
  }

  #openChangePasswordDialog() {
    const dialog = /** @type {HTMLDialogElement} */ ($('#password-dialog'))
    const form = /** @type {HTMLFormElement} */ ($('#password-form'))
    const currentInput = /** @type {HTMLInputElement} */ ($('#password-current'))
    form.reset()
    this.#setAccountError($('#password-error'), '')
    dialog.showModal()
    currentInput.focus()
  }

  /** @param {Event} event */
  async #submitPasswordChange(event) {
    event.preventDefault()
    const form = /** @type {HTMLFormElement} */ ($('#password-form'))
    const errorEl = $('#password-error')
    const currentPassword = /** @type {HTMLInputElement} */ ($('#password-current')).value
    const newPassword = /** @type {HTMLInputElement} */ ($('#password-new')).value
    const confirmPassword = /** @type {HTMLInputElement} */ ($('#password-confirm')).value
    if (newPassword.length < 8) {
      this.#setAccountError(errorEl, t('accountPasswordTooShort'))
      return
    }
    if (newPassword !== confirmPassword) {
      this.#setAccountError(errorEl, t('accountPasswordMismatch'))
      return
    }
    const submit = /** @type {HTMLButtonElement} */ ($('#password-submit'))
    submit.disabled = true
    this.#setAccountError(errorEl, '')
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!res.ok) {
        this.#setAccountError(errorEl, this.#accountErrorMessage(await getApiError(res)))
        return
      }
      form.reset()
      const dialog = /** @type {HTMLDialogElement} */ ($('#password-dialog'))
      dialog.close()
      this.#ui.toast(t('accountPasswordChanged'), 'success')
    } catch {
      this.#setAccountError(errorEl, t('accountRequestFailed'))
    } finally {
      submit.disabled = false
    }
  }

  #openAddUserDialog() {
    const dialog = /** @type {HTMLDialogElement} */ ($('#user-dialog'))
    const form = /** @type {HTMLFormElement} */ ($('#user-form'))
    const usernameInput = /** @type {HTMLInputElement} */ ($('#user-username'))
    form.reset()
    this.#setAccountError($('#user-error'), '')
    dialog.showModal()
    usernameInput.focus()
  }

  /** @param {Event} event */
  async #submitAddUser(event) {
    event.preventDefault()
    const form = /** @type {HTMLFormElement} */ ($('#user-form'))
    const errorEl = $('#user-error')
    const username = /** @type {HTMLInputElement} */ ($('#user-username')).value.trim()
    const password = /** @type {HTMLInputElement} */ ($('#user-password')).value
    const role = /** @type {HTMLSelectElement} */ ($('#user-role')).value
    if (!username) {
      this.#setAccountError(errorEl, t('accountInvalidUsername'))
      return
    }
    if (password.length < 8) {
      this.#setAccountError(errorEl, t('accountPasswordTooShort'))
      return
    }
    const submit = /** @type {HTMLButtonElement} */ ($('#user-submit'))
    submit.disabled = true
    this.#setAccountError(errorEl, '')
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password, role }),
      })
      if (!res.ok) {
        this.#setAccountError(errorEl, this.#accountErrorMessage(await getApiError(res)))
        return
      }
      form.reset()
      const dialog = /** @type {HTMLDialogElement} */ ($('#user-dialog'))
      dialog.close()
      this.#ui.toast(t('accountUserAdded'), 'success')
      await this.#loadAccountUsers()
    } catch {
      this.#setAccountError(errorEl, t('accountRequestFailed'))
    } finally {
      submit.disabled = false
    }
  }

  /** @param {string} username */
  #openResetPasswordDialog(username) {
    this.#resetPasswordUser = username
    const dialog = /** @type {HTMLDialogElement} */ ($('#reset-password-dialog'))
    const form = /** @type {HTMLFormElement} */ ($('#reset-password-form'))
    const passwordInput = /** @type {HTMLInputElement} */ ($('#reset-password-input'))
    form.reset()
    $('#reset-password-desc').textContent = t('accountResetDesc', { user: username })
    this.#setAccountError($('#reset-password-error'), '')
    dialog.showModal()
    passwordInput.focus()
  }

  /** @param {Event} event */
  async #submitResetPassword(event) {
    event.preventDefault()
    const form = /** @type {HTMLFormElement} */ ($('#reset-password-form'))
    const errorEl = $('#reset-password-error')
    const password = /** @type {HTMLInputElement} */ ($('#reset-password-input')).value
    if (password.length < 8) {
      this.#setAccountError(errorEl, t('accountPasswordTooShort'))
      return
    }
    const submit = /** @type {HTMLButtonElement} */ ($('#reset-password-submit'))
    submit.disabled = true
    this.#setAccountError(errorEl, '')
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(this.#resetPasswordUser)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        this.#setAccountError(errorEl, this.#accountErrorMessage(await getApiError(res)))
        return
      }
      form.reset()
      const dialog = /** @type {HTMLDialogElement} */ ($('#reset-password-dialog'))
      dialog.close()
      this.#ui.toast(t('accountPasswordReset'), 'success')
      await this.#loadAccountUsers()
    } catch {
      this.#setAccountError(errorEl, t('accountRequestFailed'))
    } finally {
      submit.disabled = false
    }
  }

  /** @param {string} username */
  async #deleteUser(username) {
    const confirmed = await this.#ui.confirm(t('accountDeleteTitle'), t('accountDeleteConfirm', { user: username }))
    if (!confirmed) return
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        this.#ui.toast(this.#accountErrorMessage(await getApiError(res)), 'error')
        await this.#loadAccountUsers()
        return
      }
      this.#ui.toast(t('accountUserDeleted'), 'success')
      await this.#loadAccountUsers()
    } catch {
      this.#ui.toast(t('accountRequestFailed'), 'error')
    }
  }

  async #logout() {
    const ok = await this.#ui.confirm(t('logoutConfirmTitle'), t('logoutSessionConfirmMsg'))
    if (!ok) return
    try {
      await fetch('/api/logout', { method: 'POST', headers: { Accept: 'application/json' } })
    } catch {
      // Redirect anyway; the cookie may already be invalid.
    }
    window.location.replace('/login')
  }

  /**
   * Detect the bundled local server. The app is local-only: when the server
   * is not reachable (for example the page was opened from a plain static
   * host) there is nowhere to read files from, so the hero explains that.
   */
  async #tryLocalMode() {
    const info = await this.#fetchLocalModeInfo()
    if (!info) {
      this.#showHero()
      return
    }
    this.#applyLocalMode(info)
    await this.#connectAndLoad()
  }

  async #connectAndLoad() {
    try {
      this.#storage.init(this.#config)
      // Reuse manager instances across reconnects (e.g. saving settings).
      // Recreating them would leave document-level listeners bound to stale
      // instances, and keeping the old listing cache would show files from
      // the previous bucket.
      let explorer = this.#explorer
      if (!explorer) {
        explorer = new FileExplorer(this.#storage, this.#ui)
        this.#explorer = explorer
        this.#upload = new UploadManager(this.#storage, this.#ui, explorer, this.#config)
        this.#preview = new FilePreview(this.#storage, this.#ui)
        this.#ops = new FileOperations(this.#storage, this.#ui, explorer)
      } else {
        explorer.invalidateCache()
      }

      this.#hideHero()
      $('#app').hidden = false
      $('#share-dir-btn').hidden = false
      this.#updateAboutPanel()
      this.#restoreViewPrefs()
      explorer.setOnSelectionChange((count) => {
        if (!this.#batchMode) return
        $('#batch-count').textContent = t('batchSelected', { count })
        this.#updateSelectAllBtn()
      })
      if (!this.#appEventsBound) {
        this.#upload?.initDragDrop()
        this.#bindAppEvents()
        this.#appEventsBound = true
      }
      await explorer.navigate('')
    } catch (/** @type {any} */ err) {
      // The server must be reachable: without it there is no storage at all.
      /** @type {HTMLElement} */ ($('#app')).hidden = true
      this.#showHero()
      const errorKey = getErrorMessage(err)
      this.#ui.toast(
        errorKey === 'networkError' ? t('networkError', { msg: err.message }) : t(/** @type {any} */ (errorKey)),
        'error',
      )
    }
  }

  #restoreViewPrefs() {
    const view = localStorage.getItem(VIEW_KEY) || 'grid'
    const density = localStorage.getItem(DENSITY_KEY) || 'normal'
    const sortBy = localStorage.getItem(SORT_BY_KEY) || 'name'
    const sortOrder = /** @type {'asc' | 'desc'} */ (localStorage.getItem(SORT_ORDER_KEY) || 'asc')
    this.#setView(view)
    this.#setDensity(density)
    this.#setSortBy(sortBy)
    this.#setSortOrder(sortOrder)
  }

  #enterBatchMode() {
    this.#batchMode = true
    const app = /** @type {HTMLElement} */ ($('#app'))
    app.classList.add('batch-mode')
    const btn = /** @type {HTMLElement} */ ($('#batch-toggle-btn'))
    btn.setAttribute('aria-pressed', 'true')
    $('#batch-toggle-text').textContent = t('exitBatchMode')
    const bar = /** @type {HTMLElement} */ ($('#batch-action-bar'))
    if (this.#onBarTransitionEnd) {
      bar.removeEventListener('transitionend', this.#onBarTransitionEnd)
      this.#onBarTransitionEnd = null
    }
    bar.classList.remove('hiding')
    bar.hidden = false
    $('#batch-count').textContent = t('batchSelected', { count: this.#explorer?.selectionCount ?? 0 })
    this.#updateSelectAllBtn()
  }

  #exitBatchMode() {
    this.#batchMode = false
    const explorer = /** @type {FileExplorer} */ (this.#explorer)
    explorer.clearSelection()
    const app = /** @type {HTMLElement} */ ($('#app'))
    app.classList.remove('batch-mode')
    const btn = /** @type {HTMLElement} */ ($('#batch-toggle-btn'))
    btn.setAttribute('aria-pressed', 'false')
    $('#batch-toggle-text').textContent = t('batchMode')
    const bar = /** @type {HTMLElement} */ ($('#batch-action-bar'))
    bar.classList.add('hiding')
    // `transitionend` is the normal path, but a disabled/reduced transition
    // would never fire it, leaving the bar visible forever.
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      // Re-entering batch mode removes `.hiding` before this timer fires.
      if (!bar.classList.contains('hiding')) return
      if (this.#onBarTransitionEnd) {
        bar.removeEventListener('transitionend', this.#onBarTransitionEnd)
        this.#onBarTransitionEnd = null
      }
      bar.hidden = true
      bar.classList.remove('hiding')
    }
    this.#onBarTransitionEnd = (/** @type {TransitionEvent} */ e) => {
      if (e.propertyName !== 'opacity') return
      finish()
    }
    bar.addEventListener('transitionend', this.#onBarTransitionEnd)
    setTimeout(finish, 400)
  }

  #updateSelectAllBtn() {
    if (!this.#explorer) {
      $('#batch-select-all-text').textContent = t('batchSelectAll')
      return
    }
    const total = document.querySelectorAll('#file-grid .file-card').length
    const selected = this.#explorer.selectionCount
    const allSelected = total > 0 && selected === total
    $('#batch-select-all-text').textContent = allSelected ? t('batchDeselectAll') : t('batchSelectAll')
  }

  /** @param {string} view */
  #setView(view) {
    $('#file-browser').dataset.view = view
    $('#view-grid-btn').setAttribute('aria-pressed', String(view === 'grid'))
    $('#view-list-btn').setAttribute('aria-pressed', String(view === 'list'))
    localStorage.setItem(VIEW_KEY, view)
  }

  /** @param {string} density */
  #setDensity(density) {
    $('#file-browser').dataset.density = density
    localStorage.setItem(DENSITY_KEY, density)
  }

  /** @param {string} sortBy */
  #setSortBy(sortBy) {
    $('#sort-name-btn').setAttribute('aria-pressed', String(sortBy === 'name'))
    $('#sort-date-btn').setAttribute('aria-pressed', String(sortBy === 'date'))
    $('#sort-size-btn').setAttribute('aria-pressed', String(sortBy === 'size'))
    if (this.#explorer) this.#explorer.setSortBy(sortBy)
    localStorage.setItem(SORT_BY_KEY, sortBy)
  }

  /** @param {'asc' | 'desc'} order */
  #setSortOrder(order) {
    $('#sort-asc-btn').setAttribute('aria-pressed', String(order === 'asc'))
    $('#sort-desc-btn').setAttribute('aria-pressed', String(order === 'desc'))
    if (this.#explorer) this.#explorer.setSortOrder(order)
    localStorage.setItem(SORT_ORDER_KEY, order)
  }

  #showHero() {
    $('#hero').hidden = false
    $('#app').hidden = true
  }

  #hideHero() {
    $('#hero').hidden = true
  }

  #bindHeroEvents() {
    $('#hero-connect-btn').addEventListener('click', () => {
      void this.#tryLocalMode()
    })
  }

  /**
   * Show Config Dialog
   * @param {string} [defaultTab='preferences']
   */
  #showConfigDialog(defaultTab = 'preferences') {
    const dialog = /** @type {HTMLDialogElement} */ ($('#config-dialog'))

    const tabButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (dialog.querySelectorAll('.config-tab-btn'))
    const tabPanels = /** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('.config-tab-panel'))
    const footer = /** @type {HTMLElement | null} */ (dialog.querySelector('.dialog-footer'))

    /** @param {string} tabId */
    const switchTab = (tabId) => {
      const accountTab = /** @type {HTMLButtonElement | null} */ ($('#tab-account-btn'))
      if (tabId === 'account' && accountTab?.hidden) tabId = 'preferences'
      tabButtons.forEach((btn) => {
        const isActive = btn.dataset.tab === tabId
        btn.setAttribute('aria-selected', String(isActive))
        btn.tabIndex = isActive ? 0 : -1
      })
      tabPanels.forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tabId
      })
      if (footer) footer.hidden = tabId === 'account'
      if (tabId === 'account') void this.#refreshAccountPanel()
    }

    tabButtons.forEach((btn) => {
      btn.onclick = () => {
        const tabId = btn.dataset.tab
        if (tabId) switchTab(tabId)
      }
    })

    const tablist = /** @type {HTMLElement | null} */ (dialog.querySelector('[role="tablist"]'))
    if (tablist) {
      tablist.onkeydown = (e) => {
        const target = /** @type {HTMLElement} */ (e.target).closest('.config-tab-btn')
        if (!target) return
        const enabled = [...tabButtons].filter((btn) => !btn.hidden)
        const index = enabled.indexOf(/** @type {HTMLButtonElement} */ (target))
        if (index < 0) return
        let next = -1
        if (e.key === 'ArrowRight') next = (index + 1) % enabled.length
        else if (e.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = enabled.length - 1
        if (next < 0) return
        e.preventDefault()
        enabled[next].focus()
        enabled[next].click()
      }
    }

    switchTab(defaultTab)

    const themeInput = /** @type {HTMLSelectElement | null} */ ($('#cfg-theme'))
    const languageInput = /** @type {HTMLSelectElement | null} */ ($('#cfg-language'))
    const densityInput = /** @type {HTMLSelectElement | null} */ ($('#cfg-density'))

    const cfg = this.#config.get()
    const tplInput = /** @type {HTMLInputElement} */ ($('#cfg-filename-tpl'))
    const tplScopeInput = /** @type {HTMLSelectElement | null} */ ($('#cfg-filename-tpl-scope'))

    const compressModeInput = /** @type {HTMLSelectElement} */ ($('#cfg-compress-mode'))
    const compressLevelInput = /** @type {HTMLSelectElement} */ ($('#cfg-compress-level'))
    const tinifyKeyInput = /** @type {HTMLInputElement} */ ($('#cfg-tinify-key'))
    const uploadConcurrencyInput = /** @type {HTMLSelectElement} */ ($('#cfg-upload-concurrency'))

    const currentTheme = localStorage.getItem(THEME_KEY) || 'auto'
    const savedLang = getCurrentLang()
    const currentDensityValue = localStorage.getItem(DENSITY_KEY) || 'normal'

    if (themeInput) themeInput.value = currentTheme
    if (languageInput) languageInput.value = savedLang
    if (densityInput) densityInput.value = currentDensityValue

    if (cfg.filenameTpl) tplInput.value = cfg.filenameTpl
    if (tplScopeInput) tplScopeInput.value = cfg.filenameTplScope || 'images'

    if (compressModeInput) compressModeInput.value = cfg.compressMode || 'none'
    if (compressLevelInput) compressLevelInput.value = cfg.compressLevel || 'balanced'
    if (tinifyKeyInput) tinifyKeyInput.value = cfg.tinifyKey || ''
    if (uploadConcurrencyInput) uploadConcurrencyInput.value = String(cfg.uploadConcurrency ?? 3)

    const cleanupMultipartButton = /** @type {HTMLButtonElement} */ ($('#cleanup-multipart-btn'))
    cleanupMultipartButton.disabled = !this.#config.isReady()
    cleanupMultipartButton.onclick = async () => {
      const confirmed = await this.#ui.confirm(t('multipartCleanupConfirmTitle'), t('multipartCleanupConfirmMsg'))
      if (!confirmed) return

      cleanupMultipartButton.disabled = true
      cleanupMultipartButton.textContent = t('multipartCleaning')
      this.#upload?.cancelAllUploads()
      try {
        const result = await this.#storage.abortAllMultipartUploads()
        if (result.failed > 0) {
          this.#ui.toast(t('multipartCleanupPartial', { success: result.succeeded, fail: result.failed }), 'error')
        } else if (result.total === 0) {
          this.#ui.toast(t('multipartCleanupEmpty'), 'info')
        } else {
          this.#ui.toast(t('multipartCleanupSuccess', { count: result.succeeded }), 'success')
        }
      } catch (error) {
        this.#ui.toast(t(getErrorMessage(/** @type {Error} */ (error)), { msg: String(error) }), 'error')
      } finally {
        cleanupMultipartButton.disabled = false
        cleanupMultipartButton.textContent = t('multipartCleanupButton')
      }
    }

    const updateCompressVisibility = () => {
      const mode = compressModeInput ? compressModeInput.value : 'none'
      const localOpts = $('#compress-local-options')
      const tinifyOpts = $('#compress-tinify-options')
      if (localOpts) localOpts.hidden = mode !== 'local'
      if (tinifyOpts) tinifyOpts.hidden = mode !== 'tinify'
    }

    if (compressModeInput) {
      compressModeInput.onchange = updateCompressVisibility
      updateCompressVisibility()
    }

    $('#config-cancel').onclick = () => dialog.close()
    $('#config-dialog-close').onclick = () => dialog.close()

    const onBackdropClick = (/** @type {Event} */ e) => {
      if (e.target === dialog) dialog.close()
    }
    dialog.addEventListener('click', onBackdropClick)

    dialog.addEventListener(
      'close',
      () => {
        dialog.removeEventListener('click', onBackdropClick)
      },
      { once: true },
    )

    $('#config-submit').onclick = async () => {
      const newTheme = themeInput ? themeInput.value : 'auto'
      if (newTheme !== currentTheme) {
        this.#ui.setTheme(newTheme)
      }

      const newLang = languageInput ? languageInput.value : 'zh'
      if (newLang !== savedLang) {
        setLang(/** @type {Lang} */ (newLang))
        this.#applyI18nToHTML()
      }

      const newDensity = densityInput ? densityInput.value : 'normal'
      if (newDensity !== currentDensityValue) {
        this.#setDensity(newDensity)
      }

      this.#config.save({
        ...this.#config.get(),
        filenameTpl: tplInput ? tplInput.value.trim() : '',
        filenameTplScope: tplScopeInput ? tplScopeInput.value : 'images',
        compressMode: compressModeInput ? compressModeInput.value : 'none',
        compressLevel: compressLevelInput ? compressLevelInput.value : 'balanced',
        tinifyKey: tinifyKeyInput ? tinifyKeyInput.value.trim() : '',
        uploadConcurrency: uploadConcurrencyInput ? Number(uploadConcurrencyInput.value) : 3,
      })

      dialog.close()
      await this.#explorer?.refresh()
    }

    dialog.querySelectorAll('form.config-tab-panel').forEach((form) => {
      const formElement = /** @type {HTMLFormElement} */ (form)
      formElement.onsubmit = (/** @type {Event} */ e) => e.preventDefault()
    })

    dialog.showModal()
  }

  #bindGlobalEvents() {
    $('#settings-btn').addEventListener('click', () => this.#showConfigDialog())

    $('#logout-btn').addEventListener('click', () => this.#logout())
    $('#about-logout').addEventListener('click', () => this.#logout())

    $('#account-change-password').addEventListener('click', () => this.#openChangePasswordDialog())
    $('#account-add-user').addEventListener('click', () => this.#openAddUserDialog())
    $('#password-form').addEventListener('submit', (event) => void this.#submitPasswordChange(event))
    $('#user-form').addEventListener('submit', (event) => void this.#submitAddUser(event))
    $('#reset-password-form').addEventListener('submit', (event) => void this.#submitResetPassword(event))
    /** @type {Array<[string, string]>} */
    const accountDialogs = [
      ['#password-dialog', '#password-cancel'],
      ['#user-dialog', '#user-cancel'],
      ['#reset-password-dialog', '#reset-password-cancel'],
    ]
    for (const [dialogSelector, cancelSelector] of accountDialogs) {
      const dialog = /** @type {HTMLDialogElement} */ ($(dialogSelector))
      $(cancelSelector).addEventListener('click', () => dialog.close())
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close()
      })
    }

    document.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      if (!target.closest('.context-menu') && !target.closest('.file-card-menu')) {
        this.#ui.hideContextMenu(true)
      }
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.#ui.hideContextMenu()
      }
    })
  }

  #bindAppEvents() {
    $('#refresh-btn').addEventListener('click', async () => {
      const btn = /** @type {HTMLElement} */ ($('#refresh-btn'))
      btn.classList.add('refreshing')
      btn.addEventListener('animationend', () => btn.classList.remove('refreshing'), { once: true })
      await this.#explorer.refresh()
    })

    $('#share-dir-btn').addEventListener('click', () => {
      if (!this.#ops || !this.#explorer) return
      /** @type {FileOperations} */ this.#ops.shareLink(this.#explorer.currentPrefix)
    })

    $('#breadcrumb').addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.breadcrumb-btn'))
      if (btn) {
        /** @type {FileExplorer} */ this.#explorer.navigate(btn.dataset.prefix ?? '')
      }
    })

    $('#file-grid').addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      const menuBtn = /** @type {HTMLElement | null} */ (target.closest('.file-card-menu'))
      if (menuBtn) {
        e.stopPropagation()
        const card = /** @type {HTMLElement} */ (menuBtn.closest('.file-card'))
        const rect = menuBtn.getBoundingClientRect()
        this.#ui.showContextMenu(rect.right, rect.bottom, card.dataset.key ?? '', card.dataset.isFolder === 'true', {
          size: Number(card.dataset.size ?? 0),
          mod: Number(card.dataset.mod ?? 0),
          canShare: true,
        })
        return
      }

      const checkboxWrap = /** @type {HTMLElement | null} */ (target.closest('.file-card-checkbox-wrap'))
      if (checkboxWrap) {
        e.stopPropagation()
        const card = /** @type {HTMLElement | null} */ (checkboxWrap.closest('.file-card'))
        if (card)
          /** @type {FileExplorer} */ (this.#explorer).toggleSelect(
            card.dataset.key ?? '',
            card.dataset.isFolder === 'true',
          )
        return
      }

      const card = /** @type {HTMLElement | null} */ (target.closest('.file-card'))
      if (card) {
        if (this.#batchMode) {
          /** @type {FileExplorer} */ this.#explorer.toggleSelect(
            card.dataset.key ?? '',
            card.dataset.isFolder === 'true',
          )
          return
        }
        if (e.ctrlKey || e.metaKey) {
          /** @type {FileExplorer} */ this.#explorer.toggleSelect(
            card.dataset.key ?? '',
            card.dataset.isFolder === 'true',
          )
          return
        }
        /** @type {FileExplorer} */ this.#explorer.clearSelection()
        if (card.dataset.isFolder === 'true') {
          /** @type {FileExplorer} */ this.#explorer.navigate(card.dataset.key ?? '')
        } else {
          /** @type {FilePreview} */ this.#preview.preview({
            key: card.dataset.key ?? '',
            size: Number(card.dataset.size ?? 0),
            lastModified: Number(card.dataset.mod ?? 0),
          })
        }
      }
    })

    $('#file-grid').addEventListener('keydown', (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      if (!target.classList.contains('file-card')) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()

      const key = target.dataset.key ?? ''
      if (this.#batchMode) {
        /** @type {FileExplorer} */ this.#explorer.toggleSelect(key, target.dataset.isFolder === 'true')
        return
      }
      /** @type {FileExplorer} */ this.#explorer.clearSelection()
      if (target.dataset.isFolder === 'true') {
        /** @type {FileExplorer} */ this.#explorer.navigate(key)
      } else {
        /** @type {FilePreview} */ this.#preview.preview({
          key,
          size: Number(target.dataset.size ?? 0),
          lastModified: Number(target.dataset.mod ?? 0),
        })
      }
    })

    $('#file-grid').addEventListener('contextmenu', (e) => {
      const card = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.file-card'))
      if (card) {
        e.preventDefault()
        this.#ui.showContextMenu(e.clientX, e.clientY, card.dataset.key ?? '', card.dataset.isFolder === 'true', {
          size: Number(card.dataset.size ?? 0),
          mod: Number(card.dataset.mod ?? 0),
          canShare: true,
        })
      }
    })

    $('#context-menu').addEventListener('click', (e) => {
      const item = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement} */ (e.target).closest('.context-menu-item')
      )
      if (!item) return

      const action = item.dataset.action
      if (!action) return

      const menu = /** @type {HTMLElement} */ ($('#context-menu'))
      const key = menu.dataset.key ?? ''
      const isFolder = menu.dataset.isFolder === 'true'

      this.#ui.hideContextMenu()

      switch (action) {
        case 'preview':
          /** @type {FilePreview} */ this.#preview.preview({
            key,
            size: Number(menu.dataset.size ?? 0),
            lastModified: Number(menu.dataset.mod ?? 0),
          })
          break
        case 'download':
          /** @type {FileOperations} */ this.#ops.download(key)
          break
        case 'copyPath':
          /** @type {FileOperations} */ this.#ops.copyAs(key, 'path')
          break
        case 'copyUrl':
          /** @type {FileOperations} */ this.#ops.copyAs(key, 'url')
          break
        case 'copyMarkdown':
          /** @type {FileOperations} */ this.#ops.copyAs(key, 'markdown')
          break
        case 'copyHtml':
          /** @type {FileOperations} */ this.#ops.copyAs(key, 'html')
          break
        case 'copyImage':
          /** @type {FileOperations} */ this.#ops.copyImage(key)
          break
        case 'shareQr':
          /** @type {FileOperations} */ this.#ops.shareQr(key)
          break
        case 'shareLink':
          /** @type {FileOperations} */ this.#ops.shareLink(key)
          break
        case 'editContentType':
          /** @type {FileOperations} */ this.#ops.editContentType(key)
          break
        case 'rename':
          /** @type {FileOperations} */ this.#ops.rename(key, isFolder)
          break
        case 'copy':
          /** @type {FileOperations} */ this.#ops.copy(key, isFolder)
          break
        case 'move':
          /** @type {FileOperations} */ this.#ops.move(key, isFolder)
          break
        case 'delete':
          /** @type {FileOperations} */ this.#ops.delete(key, isFolder)
          break
      }
    })

    const fileInput = /** @type {HTMLInputElement} */ ($('#file-input'))
    $('#upload-btn').addEventListener('click', () => fileInput.click())
    $('#empty-upload-btn').addEventListener('click', () => fileInput.click())

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        /** @type {UploadManager} */ this.#upload.uploadFiles([...fileInput.files])
        fileInput.value = ''
      }
    })

    $('#new-folder-btn').addEventListener('click', async () => {
      const name = await this.#ui.prompt(t('newFolderTitle'), t('newFolderLabel'), '', {
        validate: (v) => {
          const trimmed = v.trim()
          if (!trimmed) return t('fileNameRequired')
          const illegal = trimmed.match(/[/\\:*?"<>|\x00-\x1F]/g)
          if (illegal) return t('renameInvalidChars', { chars: [...new Set(illegal)].join('  ') })
          if (trimmed === '.' || trimmed === '..') return t('folderNameReserved')
          return null
        },
      })
      if (!name) return
      try {
        const key = this.#explorer.currentPrefix + name
        await this.#storage.createFolder(key)
        this.#ui.toast(t('folderCreated', { name }), 'success')
        await this.#explorer.refresh()
      } catch (/** @type {any} */ err) {
        const errorKey = getErrorMessage(err)
        if (errorKey === 'networkError') {
          this.#ui.toast(t('networkError', { msg: err.message }), 'error')
        } else {
          this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
        }
      }
    })

    $('#load-more-btn').addEventListener('click', () => /** @type {FileExplorer} */ (this.#explorer).loadMore())

    const previewDialog = /** @type {HTMLDialogElement} */ ($('#preview-dialog'))
    $('#preview-close').addEventListener('click', () => previewDialog.close())
    previewDialog.addEventListener('click', (e) => {
      if (e.target === previewDialog) previewDialog.close()
    })
    $('#preview-download').addEventListener('click', () => /** @type {FilePreview} */ (this.#preview).downloadCurrent())
    $('#preview-copy-text').addEventListener('click', () =>
      /** @type {FilePreview} */ (this.#preview).copyCurrentText(),
    )
    $('#preview-copy-image').addEventListener('click', () =>
      /** @type {FilePreview} */ (this.#preview).copyCurrentImage(),
    )
    $('#preview-copy').addEventListener('click', () => /** @type {FilePreview} */ (this.#preview).copyCurrentLink())

    $('#upload-panel-close').addEventListener('click', () => {
      $('#upload-panel').hidden = true
    })

    $('#sort-name-btn').addEventListener('click', () => this.#setSortBy('name'))
    $('#sort-date-btn').addEventListener('click', () => this.#setSortBy('date'))
    $('#sort-size-btn').addEventListener('click', () => this.#setSortBy('size'))

    $('#sort-asc-btn').addEventListener('click', () => this.#setSortOrder('asc'))
    $('#sort-desc-btn').addEventListener('click', () => this.#setSortOrder('desc'))

    $('#view-grid-btn').addEventListener('click', () => this.#setView('grid'))
    $('#view-list-btn').addEventListener('click', () => this.#setView('list'))

    $('#batch-delete-btn').addEventListener('click', async () => {
      const items = /** @type {FileExplorer} */ (this.#explorer).getSelection()
      if (!items.length) return
      const executed = await /** @type {FileOperations} */ (this.#ops).deleteMany(items)
      if (executed) this.#exitBatchMode()
    })

    $('#batch-move-btn').addEventListener('click', async () => {
      const items = /** @type {FileExplorer} */ (this.#explorer).getSelection()
      if (!items.length) return
      const executed = await /** @type {FileOperations} */ (this.#ops).moveMany(items)
      if (executed) this.#exitBatchMode()
    })

    $('#batch-copy-btn').addEventListener('click', async () => {
      const items = /** @type {FileExplorer} */ (this.#explorer).getSelection()
      if (!items.length) return
      const executed = await /** @type {FileOperations} */ (this.#ops).copyMany(items)
      if (executed) this.#exitBatchMode()
    })

    $('#batch-cancel-btn').addEventListener('click', () => {
      this.#exitBatchMode()
    })

    $('#batch-select-all-btn').addEventListener('click', () => {
      const total = document.querySelectorAll('#file-grid .file-card').length
      const selected = /** @type {FileExplorer} */ (this.#explorer).selectionCount
      if (total > 0 && selected === total) {
        /** @type {FileExplorer} */ this.#explorer.clearSelection()
      } else {
        /** @type {FileExplorer} */ this.#explorer.selectAll()
      }
    })

    $('#batch-toggle-btn').addEventListener('click', () => {
      if (this.#batchMode) {
        this.#exitBatchMode()
      } else {
        this.#enterBatchMode()
      }
    })
  }
}

export { App }
