# FlexFlix Desktop (Production Build)

A production-ready Windows desktop app for browsing local movies, enriching metadata from OMDb, watching trailer popups, and launching playback in VLC.

## What Changed

- Desktop app shell using Electron (runs as a native Windows app).
- Hardened backend with security middleware (`helmet`, `compression`, API rate limiting).
- Structured request logging with `pino` / `pino-http`.
- Graceful startup/shutdown and writable app data directory support.
- Windows installer packaging via `electron-builder`.
- Desktop runtime config bootstrap (`config.json` in AppData) so packaged app works without `.env`.

## Runtime Config (Desktop)

Packaged desktop app reads settings from:

```text
%APPDATA%\FlexFlix\config.json
```

Auto-created defaults:

```json
{
  "moviesDir": "D:\\Movies",
  "omdbApiKey": "b1663db",
  "vlcPath": "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
  "logLevel": "info",
  "apiRateLimitPerMinute": 300
}
```

If your library path is different, edit `moviesDir` and restart the app.

## Features

- Scans your local movie folder recursively.
- Parses files named as `Movie Title - 2010.ext` into title + release year.
- Fetches OMDb metadata:
  - Title
  - Release Year
  - Rated
  - Short Description
  - Genre
  - Language
  - Country of Origin
  - Poster
- Trailer popup with embedded YouTube playback.
- Local profile system with register/login, display name, and display image.
- Persisted signed-in session (no password needed again until sign out).
- Settings panel to change movie folder and refresh collection instantly.
- Parental lock option to show only G, U, and PG-13 rated titles.
- Manual metadata/poster/trailer/tag overrides.
- `Play` launches the selected movie in VLC desktop player.

## Configuration (Web / Dev)

Create `.env` from `.env.example` and set:

```env
OMDB_API_KEY=b1663db
MOVIES_DIR=D:\Movies
PORT=3000
HOST=127.0.0.1
VLC_PATH=C:\Program Files\VideoLAN\VLC\vlc.exe
LOG_LEVEL=info
API_RATE_LIMIT_PER_MINUTE=300
# APP_DATA_DIR=C:\FlexFlixData
# FLEXFLIX_AUTH_SECRET=replace_with_a_long_random_secret
```

## Run (Desktop)

```bash
npm install
npm start
```

## Run (Web Server Only)

```bash
npm run start:web
```

Then open `http://127.0.0.1:3000`.

## Build Windows Installer

```bash
npm run build:win
```

Output will be in `dist/`.

## Build macOS Installer

macOS artifacts (`.dmg` and `.zip`) can be produced in two ways:

1. On a macOS machine:

```bash
npm run build:mac
```

2. In GitHub Actions (recommended from Windows/Linux):
- Open **Actions** in GitHub.
- Run **Build macOS Installer** workflow.
- Download artifact: `flexflix-macos-installers`.
## Data Files

Runtime data caches are stored in the app data directory (`APP_DATA_DIR` or default runtime path):

- `omdb-cache.json`
- `manual-overrides.json`
- `trailer-cache.json`
- `users.secure.json` (encrypted profile + password-hash storage)
- `auth-session.json` (active signed-in user session)
- `app-settings.json` (runtime settings such as selected movies folder and parental lock)

## Naming Convention

Expected movie filename format:

```text
Movie Name - 2024.mkv
Another Movie - 1999.mp4
```
