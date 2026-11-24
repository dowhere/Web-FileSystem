# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-11-24

The first release of the local-only edition. This is a **breaking** release:
cloud storage support has been removed and the app now always runs against the
bundled local server.

### Added

- Zero-dependency Node.js server with a local folder as storage, login, and a
  small S3-compatible object API.
- Multi-user accounts with `admin`/`member` roles, password changes, and
  administrator-driven reset/delete.
- Slider verification on the sign-in page, per-IP login and challenge rate
  limiting, and an optional `TRUST_PROXY` mode for reverse proxies.
- Login-free, read-only share links for files and directories (1 day to never),
  with a standalone share page and QR codes.
- Upload experience: drag/paste upload, configurable concurrency, automatic
  multipart uploads, pause/resume, cancel, and download.
- Drag/rename/copy/move/recursive delete and batch selection with bulk actions.
- Filename templates (`[name]`, `[ext]`, `[hash:N]`, `[date:FORMAT]`,
  `[timestamp]`, `[uuid]`, directory separators).
- Image compression: local WebAssembly (JPEG, PNG, WebP, AVIF) and optional
  Tinify relayed by your own server (the API key never leaves your machine).
- Preview for images, video, audio, and text (large text is capped and streamed
  with `Range`), plus Content-Type editing.
- PWA, light/dark themes, and zh / zh_TW / en / ja localization.
- Docker deployment (Alpine, non-root, named data volume) and bilingual docs
  with screenshots.

### Changed

- Uploads are staged in `data/.web-filesystem/tmp/` and moved into place with an
  atomic rename, so half-finished files are never listed or downloadable.
- Local folders are deleted recursively in a single request; recursive
  listing/copy uses one request per page instead of one per subfolder.
- Static assets and objects use stable ETags and conditional requests (`304`).
- Login hashing uses asynchronous `scrypt`, keeping file transfers responsive.
- The settings dialog now contains Preferences / Upload / Compression / Account
  / About only.

### Removed

- Cloudflare R2 support, storage credentials, custom endpoints, custom domains,
  bucket visibility, request signing (`aws4fetch`), and presigned URLs.
- Configuration sharing links (`?config=...`) and the generated QR code.
- Static-only deployment (`npm run dev:static`, Netlify/Vercel/Wrangler
  configs). The app must be served by `server.js`.

### Security

- Object keys containing `\`, `.`/`..` segments, or symlinks that resolve
  outside the bucket are rejected.
- Uploaded HTML/SVG is served with a sandboxing Content-Security-Policy and
  `nosniff`; the app uses a strict CSP and a hashed import map.
- Deleting an object only ignores `ENOENT`; permission and busy errors surface
  instead of pretending success.
- Multipart completion validates the part list sent by the client.
