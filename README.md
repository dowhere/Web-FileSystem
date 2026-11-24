# Web-FileSystem

📁 A local-first web file manager that runs entirely on your own machine. A zero-dependency Node.js server uses a folder on disk as storage — no cloud account, no external service.

**[中文](./README-CN.md) | English**

## Features

| Capability               | Details                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Local file service**   | A zero-dependency Node.js server uses a folder on your machine as the bucket; no cloud account or external service             |
| **Accounts & auth**      | Sign-in page with slider verification and 7-day sessions; multiple users, admin/member roles, password changes          |
| **Full file management** | Directory browsing, name/date/size sorting, previews, rename, copy, move, recursive delete, batch operations            |
| **Upload experience**    | Drag/paste upload, concurrency, automatic multipart, pause/resume, cleanup of unfinished parts                          |
| **Filename templates**   | `[name]`, `[ext]`, `[hash:N]`, date, timestamp, UUID, and directory templates                                           |
| **Image compression**    | Local WebAssembly compression for JPEG, PNG, WebP, and AVIF; optional Tinify relayed through your own local server      |
| **Preview & share**      | Image, video, audio, and text previews; direct URLs, QR codes, Markdown, HTML; login-free read-only share links                        |
| **Cross-platform UX**    | PWA, light/dark themes, zh / zh_TW / en / ja localization                                                               |

## Screenshots

![File manager](./docs/screenshots/en-files.png)

| List view | Image preview |
| --- | --- |
| ![List view](./docs/screenshots/en-list.png) | ![Image preview](./docs/screenshots/en-preview.png) |

| Account settings | Read-only share |
| --- | --- |
| ![Account settings](./docs/screenshots/en-settings.png) | ![Read-only share page](./docs/screenshots/en-share.png) |

| Sign-in | Sessions & roles |
| --- | --- |
| ![Sign-in](./docs/screenshots/en-login.png) | Password plus a slider gesture, 7-day sessions, admin/member roles. |

## Quick Start

Node.js 18+ is required. There are no third-party runtime dependencies, so no install step is needed:

```bash
npm run dev
# open http://127.0.0.1:5500
```

On the first start, the server generates a random login password and prints it once:

```text
  Web-FileSystem (local mode)
  ➜  http://127.0.0.1:5500
  ➜  data: /path/to/web-filesystem/data
  ➜  bucket: local
  ➜  auth: user "admin" / password "xxxxxxxxxxxx" (generated, shown only once)
```

Save that password. Its hash is stored in `data/.web-filesystem/auth.json` and reused on later starts.

### Configure the login account

```bash
# Set username and password (persisted to auth.json for future starts)
npm run dev -- --auth-user admin --auth-password 'your-password'

# Disable authentication (only recommended for loopback/local use)
npm run dev -- --no-auth
```

Environment variables are also supported: `AUTH_USER`, `AUTH_PASSWORD`, `NO_AUTH=1`, `TRUST_PROXY=1`.

### Docker deployment

```bash
cd docker
cp .env.example .env          # optional: port, login account, password
docker compose up -d --build
```

Open `http://localhost:5500`. Data is kept in the `web-filesystem-data` named volume and survives restarts. If `AUTH_PASSWORD` is not set in `.env`, the first start prints a generated password once in `docker compose logs app`. See [docker/README.md](./docker/README.md) for backups, host-directory mounts, and security notes.

### CLI options

| Option            | Environment     | Default     | Description                                     |
| ----------------- | --------------- | ----------- | ----------------------------------------------- |
| `--port`          | `PORT`          | `5500`      | Listening port                                  |
| `--host`          | `HOST`          | `127.0.0.1` | Listening address; use `0.0.0.0` for LAN access |
| `--data`          | `DATA_DIR`      | `./data`    | Data directory                                  |
| `--bucket`        | `BUCKET`        | `local`     | Local bucket name                               |
| `--auth-user`     | `AUTH_USER`     | `admin`     | Login username                                  |
| `--auth-password` | `AUTH_PASSWORD` | generated   | Login password                                  |
| `--no-auth`       | `NO_AUTH=1`     | —           | Disable login entirely                          |
| `--trust-proxy`   | `TRUST_PROXY=1` | —           | Trust `X-Forwarded-For` for login rate limiting (only behind a trusted reverse proxy) |

### User management

- The first start creates an administrator account (username `admin` by default). Use **Settings → Account** to change your own password.
- Administrators can also add users, assign the admin/member role, reset other users' passwords, and delete users. Members can only change their own password.
- New passwords must be at least 8 characters. Resetting a password or deleting an account invalidates that user's existing sessions; changing your own password keeps the current session and signs out your other sessions.
- Accounts and password hashes live in `data/.web-filesystem/auth.json`. A legacy single-user record is migrated automatically to an administrator account and keeps its password.
- Passing `--auth-password` at startup sets the password for the target account (`--auth-user`, or the existing administrator when omitted), ensures it is an administrator, and leaves other users untouched.

### Login verification

The sign-in page requires a rightward slider gesture in addition to the password. The server issues a one-time challenge (5-minute expiry and a minimum delay), and `/api/login` only accepts a verified challenge. A failed verification or failed sign-in requires a new gesture. This raises the cost of simple automation; it is **not** a cryptographic second factor such as TOTP. The existing per-IP login rate limit still applies.

Challenges are rate-limited per IP (30 per 5 minutes) on top of the 10-attempt login limit. When the server sits behind a reverse proxy, start it with `--trust-proxy` (or `TRUST_PROXY=1`) so both limits see the real client address instead of the proxy's. Only enable this when the proxy overwrites `X-Forwarded-For`.

### Data layout

```text
data/
├── local/                     # bucket contents (the actual files)
├── .web-filesystem/
│   ├── meta.json              # Content-Type metadata
│   ├── auth.json              # users, roles, and password hashes (v2)
│   ├── share-secret           # signing key for share links (keep private)
│   └── tmp/                   # staged upload bodies (cleared on startup)
└── .uploads/                  # temporary multipart parts (cleared on startup)
```

### Storage behaviour

- Uploads are written to `data/.web-filesystem/tmp/` first and moved into place with an atomic rename, so a half-finished file is never listed or downloadable.
- Static assets and objects are served with an `ETag`; reloads and repeated previews revalidate and normally cost only a `304`.
- Deleting a folder removes the whole directory tree in one request.
- Object keys containing `\`, `.`/`..` segments, or symlinks that resolve outside the bucket are rejected.

> [!WARNING]
> `--host 0.0.0.0` exposes the server to your LAN. The login password travels over plain HTTP, so use this only on trusted networks; put the server behind an HTTPS reverse proxy for remote access. Never combine `--no-auth` with a non-loopback address.

## Common Configuration

### Filename templates

- `[name]_[hash:6].[ext]` — original name plus content hash
- `images/[date:YYYY/MM/DD]/[uuid].[ext]` — date-based directories
- `backup/[timestamp]-[name].[ext]` — timestamped backups

### Read-only share links

When serving the app with the bundled file service (`npm run dev`), you can create **login-free, read-only share links** for files and directories. The links are signed by the server and keep working even when the recipient is not signed in.

- Choose **Share link** from a file or folder context menu; folders also have a toolbar button.
- Pick an expiry: 1 day, 7 days, 30 days, 1 year, or never. Expired links are rejected by the server.
- The signature covers the bucket, path, and expiry. Changing any of them invalidates the link. Recipients need no account or session.
- A link can only list, preview, and download content inside its scope. It cannot upload, modify, or delete anything.
- A directory share is rooted at the directory chosen when the link was created and includes every descendant, including files added while the link is valid. Avoid sharing parent folders that contain sensitive content.

The signing key is stored in `data/.web-filesystem/share-secret`. Deleting or rotating that file immediately invalidates **all** existing share links (a new key is generated on restart). There is currently no UI to revoke an individual link; to invalidate one early, delete the shared file/folder, wait for expiry, or rotate the key.

> [!CAUTION]
> A share link is itself a bearer credential: anyone who has it can read the shared content. Send links only through trusted channels, and serve the app over HTTPS when it is reachable from the internet.

## Local Development

```bash
# Local file mode (recommended, includes login authentication)
npm run dev
```

No build is required. Core browser dependencies (`dayjs`, `filesize`) are vendored in `src/vendor/`, so the app starts offline; image compression and QR code modules are loaded on demand. The app **must** be served by `server.js` — there is no static-only mode. See [AGENTS.md](./AGENTS.md) for development conventions.

Type checking:

```bash
npm run typecheck
```

## FAQ

**I forgot the login password.** If another administrator can sign in, reset it under **Settings → Account → User management**. Otherwise pass `--auth-password` to set a new password for the target account (omit `--auth-user` to reset the existing administrator); other users are preserved. Deleting `data/.web-filesystem/auth.json` removes all users and generates a new administrator password.

**How long does the login last?** The session cookie is valid for 7 days. Sessions live in server memory, so restarting the server requires signing in again. Resetting a password or deleting an account invalidates its sessions immediately.

**Do share links require a login? What can recipients do?** No. The link carries its own read-only signature, so recipients can browse, preview, and download but cannot write or delete. Links stop working at their configured expiry, and directory links include everything under the shared directory.

**Is Tinify compression safe?** The Tinify key stays in your browser and is sent only to your own local server, which relays the image to `api.tinify.com` and streams the result back (the Tinify API sends no CORS headers, so a browser cannot call it directly). No third-party proxy is involved, and the key is never written to disk.

**Which browsers are supported?** The latest Chrome, Edge, Firefox, and Safari. Internet Explorer is not supported.

**Why is my upload failing?** Make sure the data directory (including `.web-filesystem/tmp`) is writable and has enough free space, and that the server process is still running. Multipart uploads require `POST` / `PUT` / `DELETE` on `/s3`; files must not exceed 1 TiB.

## License

MIT License

This project is based on [R2 Web](https://github.com/vikiboss/r2-web) by [Viki](https://github.com/vikiboss) (MIT License), rebranded and extended as Web-FileSystem. Thanks to the original author.
