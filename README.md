# FlexFlix Local Movie Library

A Netflix-style interface for local movies on `D:\Movies`, enriched with OMDb (IMDb-linked) metadata.

## Features

- Scans your local movies folder recursively.
- Parses files named as `Movie Title - 2010.ext` into Title + Release Year.
- Fetches metadata using OMDb API with Title + Year:
  - Title
  - Release Year
  - Rated
  - Short Description
  - Genre
  - Language
  - Country of Origin
  - Poster
  - Trailer link (IMDb video gallery when IMDb id exists)
- Small edit controls for fixing missing poster/details manually, persisted locally.
- In-page trailer popup with embedded YouTube player (no new tab required), with server-side trailer ID resolution for IMDb links.
- `Play` opens the selected movie in your default system video player.
- Modern Netflix-style, responsive interface.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Confirm `.env` values:

```env
OMDB_API_KEY=b1663db
MOVIES_DIR=D:\Movies
PORT=3000
```

3. Start the app:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Naming Convention

Expected filename pattern:

```text
Movie Name - 2024.mkv
Another Movie - 1999.mp4
```

The app splits filename into two parts using the final `-` segment as the year.

## Manual Overrides

Manual edits are stored in:

```text
.cache/manual-overrides.json
```

OMDb response caching is stored in:

```text
.cache/omdb-cache.json
```


