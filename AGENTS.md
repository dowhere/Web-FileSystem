# AGENTS.md

本文档为本仓库提供开发指南。

## 项目速览

**Web-FileSystem** — 本地优先的 Web 文件管理器，零构建、零框架；内置登录认证与本地文件服务，只在本机运行，不连接任何云存储。

**核心特性** 文件上传、目录浏览、文件预览、文件操作、图片压缩、PWA、多语言（zh/zh_TW/en/ja）、浅色/深色主题、多选批量操作、本地文件夹存储、多用户登录与角色、滑动验证、修改/重置密码、免登录只读分享链接。

**快速启动**

```bash
# 本地文件模式（数据保存在 ./data/local，首次启动会生成登录密码）
npm run dev

# 指定登录账号密码 / 关闭认证
npm run dev -- --auth-user admin --auth-password secret
npm run dev -- --no-auth

# 可选：反代后开启真实 IP 限流
npm run dev -- --trust-proxy

# Docker 部署（数据保存在命名卷 web-filesystem-data）
cd docker && cp .env.example .env && docker compose up -d --build
```

本地模式由根目录的 `server.js` 提供：静态资源 + `/s3/<bucket>` 的 S3 兼容子集，后端为 `data/` 下的本地目录。前端启动时会请求 `/api/local-mode` 自动连接；应用**必须**由该服务提供，不支持纯静态部署。除 `/login`、`/share/<token>`、`/api/share/<token>/*` 与少量静态资源外，所有页面与 API 都要求登录会话。

## 代码地图

### 快速定位表

| 任务               | 文件                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| 修改文件名模板逻辑 | `src/js/utils.js` — `applyFilenameTemplate`                                   |
| 修改图片压缩逻辑   | `src/js/upload-manager.js` — `compressFile`                                   |
| 添加 i18n 文案     | `src/js/i18n.js` — `const I18N`                                               |
| 修改按钮样式       | `src/css/components.css` — `.btn`                                             |
| 添加设计 Token     | `src/css/tokens.css`                                                          |
| 修改对象 API 操作  | `src/js/storage-client.js`                                                    |
| 修改本地存储逻辑   | `server.js`                                                                   |
| 修改登录认证       | `server.js` — `Authentication` 段、`LOGIN_I18N`、`/api/login*`、`/api/logout` |
| 修改用户管理       | `server.js` — `handleAuthApi`、`/api/users*`；`src/js/app.js` — 账户设置页    |
| 修改分享链接服务端 | `server.js` — `Read-only share links` 段、`handleCreateShare`                 |
| 修改公开分享页     | `src/share.html`、`src/share.js`、`src/share.css`                             |
| 修改端点/本地模式  | `src/js/config-manager.js`、`src/js/app.js` — `#tryLocalMode`                 |
| 修改 Docker 部署   | `docker/Dockerfile`、`docker/docker-compose.yml`、`docker/.env.example`       |
| 修改文件浏览逻辑   | `src/js/file-explorer.js`                                                     |
| 修改上传管理逻辑   | `src/js/upload-manager.js`                                                    |
| 多选批量操作逻辑   | `src/js/file-explorer.js` — `toggleSelect` / `selectAll` / `clearSelection`   |

### 工具函数列表

以下函数定义在 `src/js/utils.js`，供各模块导入：

- `t(key, vars)` — i18n 翻译（来自 `src/js/i18n.js`）
- `applyFilenameTemplate(tpl, file)` — 文件名模板处理，占位符：`[name]`、`[ext]`、`[hash:N]`、`[date:FORMAT]`、`[timestamp]`、`[uuid]`、`/`
- `compressFile(file, config, onStatus)` — 图片压缩（定义在 `upload-manager.js`）
  - PNG 特殊处理：直接优化缓冲区，不重新编码
  - 自适应逻辑：压缩后更大则使用原文件

## 项目结构

```
web-filesystem/
├── server.js          — 零依赖本地文件服务（静态资源 + S3 兼容 API + 登录认证 + 只读分享）
├── README.md          — 项目说明、使用指南（English）
├── README-CN.md       — 项目说明、使用指南（中文）
├── package.json       — 依赖声明（仅用于类型提示）
├── jsconfig.json      — JSDoc 类型检查配置
├── .dockerignore      — Docker 构建上下文忽略规则（排除 data/、node_modules/）
├── docs/screenshots/  — README 截图（`en-*` / `zh-*`）
├── docker/            — Docker 部署（Dockerfile、compose、.env.example、说明）
└── src/               — 源码目录（即部署目录）
     ├── index.html    — 应用外壳、import map、对话框模板
     ├── main.js       — 入口（仅 new App()）
     ├── manifest.json — PWA 配置
     ├── style.css     — 样式主入口（仅导入 css 子目录）
     ├── share.html    — 公开只读分享页（独立、无框架）
     ├── share.js      — 公开分享页逻辑（列表、预览、下载）
     ├── share.css     — 公开分享页样式
     ├── vendor/       — 本地内置的浏览器依赖（dayjs/filesize）
     ├── js/           — 业务逻辑模块
     │    ├── app.js              — 主协调器、本地模式自动连接
     │    ├── config-manager.js   — 配置持久化、端点解析、Base64 分享
     │    ├── storage-client.js   — 对象 API 客户端（同源 `/s3`）
     │    ├── ui-manager.js       — 主题、Toast、对话框、Tooltip
     │    ├── file-explorer.js    — 目录导航、排序、分页、缩略图
     │    ├── upload-manager.js   — 上传、文件名模板、图片压缩
     │    ├── file-preview.js     — 图片/视频/音频/文本预览
     │    ├── file-operations.js  — 重命名、复制、移动、删除
     │    ├── i18n.js             — 多语言（zh/zh_TW/en/ja）
     │    ├── constants.js        — 常量
     │    └── utils.js            — 工具函数
     └── css/          — 样式模块（CSS Layers）
          ├── reset.css       — CSS Reset
          ├── tokens.css      — 设计 Token（定义所有变量）
          ├── base.css        — 全局基础样式
          ├── layout.css      — 布局容器
          ├── components.css  — 通用 UI 组件
          ├── utilities.css   — 工具类
          └── animations.css  — 动画与过渡
```

> `src/index.html` 里的内联 `<script type="importmap">` 受 CSP 保护：`script-src` 中的 sha256 必须与 import map 文本内容一致，修改 import map（依赖映射）后需重新计算，否则模块解析失败、页面空白。

### 本地存储服务

`server.js` 实现了前端用到的 S3 子集，无需数据库或第三方依赖：

- `GET /api/local-mode` — 返回 `{ endpoint: '/s3', bucket, authEnabled, authUser, authRole }`，前端据此自动连接
- `GET /api/auth/me`、`POST /api/auth/change-password` — 当前会话用户、修改自己的密码
- `GET/POST /api/users`、`DELETE /api/users/<username>`、`POST /api/users/<username>/password` — 管理员用户管理（创建、删除、重置密码）
- `GET /s3/<bucket>?list-type=2&prefix=&delimiter=/&max-keys=&continuation-token=` — 列表（支持分页）；ETag 由 size+mtime 生成（稳定值）
- `GET/HEAD/PUT/DELETE /s3/<bucket>/<key>` — 对象读写、Range、`If-None-Match` 304、复制、目录删除（本地模式一次 `fs.rm` 递归删除）
- `POST/PUT/DELETE ...?uploads / ?uploadId / ?partNumber` — 分片上传；完成时按请求体中的 part 列表拼接并校验缺失分片
- 上传请求体先写入 `data/.web-filesystem/tmp/` 再原子 `rename` 到目标键，半成品不会出现在列表里；启动时清空该目录
- key 中不允许 `\0`、`\` 或 `.`/`..` 段；读写前用 `realpath` 校验，拒绝通过符号链接逃逸出 bucket 的路径
- 静态资源与对象都返回 ETag + `no-cache`，支持 304 重新验证
- 对象元数据（Content-Type）持久化在 `data/.web-filesystem/meta.json`
- `GET /share/<token>` — 公开只读分享页；`GET /api/share/<token>/{,list,content,download}` — 公开读取 API
- `POST /api/share` — 创建分享链接（需登录会话），JSON `{ key, expiresIn? }`
- `POST /api/tinify/compress` — 登录后可用；把图片原样转发到 `api.tinify.com` 并回传压缩结果（Key 通过 `X-Tinify-Key` 头传入，不落盘）。浏览器无法直接调用 Tinify（无 CORS 头）
- 分享签名密钥持久化在 `data/.web-filesystem/share-secret`（32 字节，权限 0600）
- 默认数据目录 `data/<bucket>`，可用 `--data` / `DATA_DIR`、`--bucket` / `BUCKET` 修改
- 默认监听 `127.0.0.1:5500`，可用 `--port` / `PORT`、`--host` / `HOST` 修改

### Docker 部署

- `docker/Dockerfile` 基于 `node:24-alpine`，只复制 `package.json`、`server.js`、`src/`；服务端无第三方依赖，无需 `npm install`
- `package.json` 必须进镜像，Node 依靠其中的 `"type": "module"` 将 `server.js` 作为 ES module 执行
- `docker/docker-compose.yml` 的构建上下文为仓库根目录（`context: ..`），服务名 `app`，容器内端口 `5500`
- 数据保存在命名卷 `web-filesystem-data` 并挂载到 `/data`；`.dockerignore` 排除仓库 `data/`、`node_modules/` 等，避免把本地文件打进镜像
- 容器以 `node` 用户（UID/GID 1000）运行，启用 `no-new-privileges`，健康检查通过 TCP 探测容器内 `PORT`
- `.env` 由 `docker/.env.example` 复制而来；`AUTH_PASSWORD` 为空时首次启动生成随机密码并只在容器日志显示一次，设置后每次启动都会强制重置该管理员密码
- 修改代码后执行 `docker compose up -d --build` 重新构建；详细使用与备份说明见 `docker/README.md`

### 登录认证与用户管理

- 默认开启。`GET /login` 提供内置登录页（根据 `Accept-Language` 显示 zh / zh_TW / en / ja）
- 用户存储为 v2 结构 `{ version: 2, users: [{ username, salt, hash, role, createdAt }] }`，位于 `data/.web-filesystem/auth.json`；`role` 为 `admin` 或 `member`
- 旧版单用户记录 `{ user, salt, hash }` 启动时自动迁移为一个管理员，原密码继续有效；迁移后立即写回 v2
- 密码策略：新建/修改密码 8–256 个字符；用户名去空格后 1–64 字符，不允许控制字符和 `/ \ :`
- 启动参数：`--auth-user` / `AUTH_USER`（默认 `admin`）、`--auth-password` / `AUTH_PASSWORD`。传入密码时会更新目标账户（存在则改密，不存在则创建），确保其为管理员，已有其他用户保持不变；不传密码且没有存储时生成随机管理员密码并只在启动日志显示一次
- 使用 `--no-auth` 或 `NO_AUTH=1` 可完全关闭登录（仅建议在本机回环地址使用）；关闭时用户 API 返回 403 `AUTH_DISABLED`
- 会话：登录成功后下发 `wf_session` Cookie（HttpOnly、SameSite=Strict、7 天），服务端 `sessions` Map 保存 `{ expiresAt, username }`；重启服务后内存会话清空，需要重新登录
- `POST /api/logout` — 销毁当前会话并清除 Cookie
- 未登录访问受保护页面会 302 到 `/login?next=...`；受保护的 `/api/*` 与 `/s3/*` 返回 401 JSON（公开分享路由除外）
- 连续登录失败 10 次后，同一 IP 会被限流 15 分钟；可用 `TRUST_PROXY=1` / `--trust-proxy` 从 `X-Forwarded-For` 取真实 IP（仅在可信反代后开启）
- 密码哈希使用异步 `crypto.scrypt`，不会阻塞文件下载等其他请求
- 滑动验证挑战按 IP 限流（5 分钟 30 次），全局上限 5000；最短挑战时长 300 ms

#### 滑动验证（简化二次验证）

- 登录页在密码之外还有一个向右滑动的滑条；滑到 ≥90% 才视为验证通过，登录按钮在此之前保持禁用
- `POST /api/login/challenge` — 公开，签发一次性挑战 `{ id, expiresIn }`，存入 `sliderChallenges`（5 分钟过期）
- `POST /api/login/challenge/verify` — 公开，提交 `{ id, position }`；要求挑战存在、未使用、已满最短等待时间（500 ms），`position >= 0.9` 时记录 `verifiedAt`
- `POST /api/login` — JSON `{ username, password, challengeId }`；必须携带已验证的一次性挑战，无论密码正确与否该挑战都会被消费；密码错误或缺少/无效挑战都会导致登录失败并要求重新滑动
- 该机制仅用于抬高简单自动化的成本，**不是** TOTP/WebAuthn 一类的密码学双因子认证，文档与 UI 不应夸大其安全性

#### 账户与用户 API

- `GET /api/auth/me` — 返回当前会话用户 `{ username, role }`
- `POST /api/auth/change-password` — JSON `{ currentPassword, newPassword }`；校验当前密码、策略与“不能与旧密码相同”；成功后保留当前会话并注销该用户的其他会话
- `GET /api/users` — 管理员；按管理员优先排序返回 `{ username, role, createdAt }` 列表（不含哈希）
- `POST /api/users` — 管理员；JSON `{ username, password, role }`，创建用户
- `DELETE /api/users/<username>` — 管理员；不能删除自己，也不能删除最后一个管理员；成功后注销该用户全部会话
- `POST /api/users/<username>/password` — 管理员重置他人密码；不能重置自己（应走修改密码接口）；成功后注销目标用户全部会话
- 权限辅助：`getCurrentUser`、`requireApiUser(req, res, { admin })`、`invalidateUserSessions(user, exceptToken)`；写文件失败时回滚内存中的用户变更
- 前端入口：设置对话框的「账户」标签页（`src/index.html` 的 `#tab-account-btn` / `[data-panel="account"]`，逻辑在 `src/js/app.js` 的账户相关方法）；仅在内置本地服务且开启认证时显示，管理员额外看到用户管理区域

### 只读分享链接

- Token = `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))`，payload 为 `{ v:1, b, k, t, e? }`（bucket、key、`file`/`dir`、可选过期时间戳）
- `POST /api/share` 需要登录会话；`expiresIn` 为秒数（`0` 表示永久，默认 7 天，上限 366 天）
- 公开路由绕过登录：`/share/<token>` 与 `/api/share/<token>/{,list,content,download}`，仅允许 `GET`/`HEAD`
- 文件分享 token 直接指向文件；目录分享 token 的 key 以 `/` 结尾，所有相对路径都经过 `normalizeSharePath` 校验，再拼接为完整 key
- 只读保证：分享路由没有写操作，内容响应强制 `Cache-Control: no-store`、`Content-Security-Policy: sandbox; default-src 'none'` 与 `X-Content-Type-Options: nosniff`；下载使用 RFC 5987 `Content-Disposition`
- 分享页是独立的 `src/share.html` + `src/share.js`，通过严格 CSP（无内联脚本/样式）和 `textContent` 渲染文件名，避免 XSS
- 所有者侧入口：工具栏 `#share-dir-btn`、右键菜单 `shareLink`、`UIManager.showShareLinkDialog`、`FileOperations.shareLink`；仅在连接内置本地服务且使用本地端点时显示
- 无单条链接撤销机制；删除/轮换 `share-secret` 会使全部链接失效。修改 token 格式或 payload 时必须保持向后兼容或接受旧链接失效
- 修改公开分享页文案时，注意 `src/share.js` 内有独立的 `I18N`（zh/zh_TW/en/ja），与 `src/js/i18n.js` 分开维护

## 架构速查

### JavaScript 类架构

每个类独立为一个模块，位于 `src/js/`：

| 类               | 文件                 | 职责                                                     |
| ---------------- | -------------------- | -------------------------------------------------------- |
| `ConfigManager`  | `config-manager.js`  | localStorage 持久化、Base64 配置分享                     |
| `StorageClient`  | `storage-client.js`  | 对象 API 客户端（同源 `/s3`，仅凭会话 Cookie）           |
| `UIManager`      | `ui-manager.js`      | 主题、Toast、对话框、上下文菜单、Tooltip、分享链接对话框 |
| `FileExplorer`   | `file-explorer.js`   | 目录导航、排序、分页、懒加载缩略图、列表缓存             |
| `UploadManager`  | `upload-manager.js`  | 拖拽/粘贴上传、文件名模板、图片压缩                      |
| `FilePreview`    | `file-preview.js`    | 图片/视频/音频/文本预览                                  |
| `FileOperations` | `file-operations.js` | 重命名、复制、移动、删除（递归删除目录）、创建分享链接   |
| `App`            | `app.js`             | 主协调器、i18n 处理、账户设置与用户管理                  |

独立的公开分享页逻辑位于 `src/share.js`（非类模块，仅由 `src/share.html` 加载）。

## i18n 速查

### 多语言机制

- **I18N 对象** `src/js/i18n.js`（zh / zh_TW / en / ja 四语言）
- **翻译函数** `t(key, vars)` 支持变量替换
- **支持语言** zh（中文）、zh_TW（繁体）、en（英语）、ja（日语）
- **语言切换** `App.updateLanguage()` 自动更新所有文案

### 添加新文案

1. 在 `src/js/i18n.js` 的 `I18N` 对象添加 zh / zh_TW / en / ja 键值
2. 代码中使用 `t('key')` 或 `t('key', { var: 'value' })`
3. HTML 元素使用 `data-tooltip-key="key"` 支持动态更新

**示例**

```javascript
// 1. 在 I18N 对象添加
const I18N = {
  zh: {
    deleteConfirm: '确定删除 {name} 吗？',
    deleteSuccess: '删除成功',
  },
  en: {
    deleteConfirm: 'Delete {name}?',
    deleteSuccess: 'Deleted successfully',
  },
  ja: {
    deleteConfirm: '{name} を削除しますか？',
    deleteSuccess: '削除しました',
  },
}

// 2. 代码中使用
const message = t('deleteConfirm', { name: fileName })
uiManager.toast(t('deleteSuccess'), 'success')

// 3. Tooltip 使用
button.dataset.tooltipKey = 'deleteConfirm'
button.dataset.tooltip = t('deleteConfirm')
```
