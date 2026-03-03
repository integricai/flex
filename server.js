const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");

require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MOVIES_DIR = process.env.MOVIES_DIR;
const OMDB_API_KEY = process.env.OMDB_API_KEY;

const CACHE_DIR = path.join(__dirname, ".cache");
const OMDB_CACHE_FILE = path.join(CACHE_DIR, "omdb-cache.json");
const OVERRIDES_FILE = path.join(CACHE_DIR, "manual-overrides.json");
const TRAILER_CACHE_FILE = path.join(CACHE_DIR, "trailer-cache.json");

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".webm"
]);

const EDITABLE_FIELDS = ["title", "releaseYear", "rated", "description", "genre", "language", "country", "poster", "trailerLink"];

let omdbCache = {};
let manualOverrides = {};
let trailerCache = {};
let baseMovies = [];
let moviesIndex = [];
let lastScan = null;
let scanPromise = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function createMovieId(filePath) {
  return crypto.createHash("sha1").update(filePath).digest("hex");
}

function normalizeTitle(text) {
  return text
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMovieFromFilename(filePath) {
  const rawName = path.parse(filePath).name;
  const normalized = normalizeTitle(rawName);
  const parts = normalized.split("-");

  if (parts.length < 2) {
    return null;
  }

  const yearPart = parts.pop().trim();
  const yearMatch = yearPart.match(/(19\d{2}|20\d{2})/);
  if (!yearMatch) {
    return null;
  }

  const title = parts.join("-").trim();
  if (!title) {
    return null;
  }

  return {
    title,
    year: yearMatch[1]
  };
}

async function loadJsonFile(filePath, defaultValue) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function saveJsonFile(filePath, value) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function hasMissingMovieInfo(movie) {
  const description = String(movie.description || "").trim();
  const genre = String(movie.genre || "").trim();
  const language = String(movie.language || "").trim();
  const country = String(movie.country || "").trim();
  const rated = String(movie.rated || "").trim();

  return (
    !movie.poster ||
    !description ||
    description === "No description found." ||
    !genre ||
    genre === "N/A" ||
    !language ||
    language === "N/A" ||
    !country ||
    country === "N/A" ||
    !rated ||
    rated === "N/A"
  );
}

function applyManualOverridesToMovie(movie) {
  const overrides = manualOverrides[movie.id] || null;
  const mergedMovie = { ...movie };

  if (overrides) {
    for (const field of EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(overrides, field)) {
        continue;
      }

      const value = String(overrides[field] || "").trim();
      if (value) {
        mergedMovie[field] = value;
      }
    }
  }

  mergedMovie.missingInfo = hasMissingMovieInfo(mergedMovie);
  mergedMovie.isManuallyEdited = Boolean(overrides && Object.keys(overrides).length);
  return mergedMovie;
}

function rebuildMoviesIndex() {
  moviesIndex = baseMovies
    .map((movie) => applyManualOverridesToMovie(movie))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

function serializeMovie(movie) {
  return {
    id: movie.id,
    fileName: movie.fileName,
    title: movie.title,
    releaseYear: movie.releaseYear,
    rated: movie.rated,
    description: movie.description,
    genre: movie.genre,
    language: movie.language,
    country: movie.country,
    poster: movie.poster,
    trailerLink: movie.trailerLink,
    imdbId: movie.imdbId,
    missingInfo: movie.missingInfo,
    isManuallyEdited: movie.isManuallyEdited
  };
}

function sanitizeOverridePayload(payload) {
  const sanitized = {};
  let hasEditableField = false;

  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      continue;
    }

    hasEditableField = true;
    const rawValue = payload[field];

    if (rawValue === null || rawValue === undefined) {
      sanitized[field] = null;
      continue;
    }

    const value = String(rawValue).trim();
    sanitized[field] = value ? value : null;
  }

  if (!hasEditableField) {
    return null;
  }

  return sanitized;
}

function extractYouTubeVideoIdFromUrl(link) {
  if (!link) {
    return null;
  }

  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      if (url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/").filter(Boolean)[1] || null;
      }

      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/").filter(Boolean)[1] || null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function extractYouTubeSearchQueryFromUrl(link) {
  if (!link) {
    return null;
  }

  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host.endsWith("youtube.com") && url.pathname === "/results") {
      return url.searchParams.get("search_query");
    }
  } catch {
    return null;
  }

  return null;
}

function buildTrailerCacheKey(movie) {
  return crypto
    .createHash("sha1")
    .update(`${movie.id}|${movie.title}|${movie.releaseYear}|${movie.trailerLink || ""}`)
    .digest("hex");
}

function buildTrailerSearchQuery(movie) {
  return `${movie.title || "Movie"} ${movie.releaseYear || ""} official trailer`.replace(/\s+/g, " ").trim();
}

async function searchYouTubeVideoId(query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return null;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const url = new URL("https://www.youtube.com/results");
      url.searchParams.set("search_query", cleanQuery);

      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      if (!response.ok) {
        throw new Error(`YouTube search failed (${response.status})`);
      }

      const html = await response.text();
      const ids = [...new Set(Array.from(html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g), (match) => match[1]))];
      if (ids.length) {
        return ids[0];
      }
    } catch (error) {
      if (attempt === 3) {
        return null;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 350));
  }

  return null;
}

async function resolveTrailerEmbed(movie) {
  const cacheKey = buildTrailerCacheKey(movie);
  if (Object.prototype.hasOwnProperty.call(trailerCache, cacheKey)) {
    return trailerCache[cacheKey];
  }

  const trailerLink = String(movie.trailerLink || "").trim();
  let videoId = extractYouTubeVideoIdFromUrl(trailerLink);
  let query = null;
  let source = "trailer_link";

  if (!videoId) {
    const preferredQuery = extractYouTubeSearchQueryFromUrl(trailerLink);
    const fallbackQuery = buildTrailerSearchQuery(movie);
    const looseQuery = `${movie.title || "Movie"} trailer`.replace(/\s+/g, " ").trim();

    const queryCandidates = [...new Set([preferredQuery, fallbackQuery, looseQuery].filter(Boolean))];
    source = "youtube_search";

    for (const candidate of queryCandidates) {
      const found = await searchYouTubeVideoId(candidate);
      if (found) {
        videoId = found;
        query = candidate;
        break;
      }
    }

    if (!query) {
      query = queryCandidates[0] || null;
    }
  }

  const result = {
    source,
    query,
    videoId: videoId || null,
    embedUrl: videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&modestbranding=1` : null,
    externalUrl: trailerLink || (query ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` : null)
  };

  trailerCache[cacheKey] = result;
  saveJsonFile(TRAILER_CACHE_FILE, trailerCache).catch(() => {});

  return result;
}

async function collectMovieFiles(directory, list = []) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectMovieFiles(fullPath, list);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (VIDEO_EXTENSIONS.has(extension)) {
      list.push(fullPath);
    }
  }

  return list;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchOmdbMovie(title, year) {
  if (!OMDB_API_KEY) {
    return null;
  }

  const cacheKey = `${title.toLowerCase()}|${year}`;
  if (Object.prototype.hasOwnProperty.call(omdbCache, cacheKey)) {
    return omdbCache[cacheKey];
  }

  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("t", title);
  url.searchParams.set("y", year);
  url.searchParams.set("plot", "short");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`OMDb request failed (${response.status})`);
    }

    const payload = await response.json();
    if (payload.Response === "False") {
      omdbCache[cacheKey] = null;
      return null;
    }

    const trailerLink = payload.imdbID
      ? `https://www.imdb.com/title/${payload.imdbID}/videogallery/`
      : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${year} official trailer`)}`;

    const movie = {
      title: payload.Title || title,
      releaseYear: payload.Year || String(year),
      rated: payload.Rated || "N/A",
      description: payload.Plot && payload.Plot !== "N/A" ? payload.Plot : "No description found.",
      genre: payload.Genre || "N/A",
      language: payload.Language || "N/A",
      country: payload.Country || "N/A",
      poster: payload.Poster && payload.Poster !== "N/A" ? payload.Poster : null,
      trailerLink,
      imdbId: payload.imdbID || null
    };

    omdbCache[cacheKey] = movie;
    return movie;
  } catch (error) {
    console.error(`OMDb lookup failed for ${title} (${year}):`, error.message);
    return null;
  }
}

function buildMovieRecord(filePath, parsedMovie, omdbMovie) {
  const fallbackTitle = parsedMovie?.title || normalizeTitle(path.parse(filePath).name);
  const fallbackYear = parsedMovie?.year || "Unknown";

  return {
    id: createMovieId(filePath),
    fileName: path.basename(filePath),
    sourcePath: filePath,
    title: omdbMovie?.title || fallbackTitle,
    releaseYear: omdbMovie?.releaseYear || fallbackYear,
    rated: omdbMovie?.rated || "N/A",
    description: omdbMovie?.description || "No description found.",
    genre: omdbMovie?.genre || "N/A",
    language: omdbMovie?.language || "N/A",
    country: omdbMovie?.country || "N/A",
    poster: omdbMovie?.poster || null,
    trailerLink:
      omdbMovie?.trailerLink ||
      `https://www.youtube.com/results?search_query=${encodeURIComponent(`${fallbackTitle} ${fallbackYear} official trailer`)}`,
    imdbId: omdbMovie?.imdbId || null
  };
}

function openInDefaultPlayer(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error("Movie file is no longer available on disk.");
  }

  const escapedPath = filePath.replace(/"/g, '""');
  const command = `start "" "${escapedPath}"`;

  const child = spawn("cmd.exe", ["/c", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  child.unref();
}

async function scanMovies() {
  if (scanPromise) {
    return scanPromise;
  }

  scanPromise = (async () => {
    if (!MOVIES_DIR) {
      throw new Error("MOVIES_DIR is not configured. Add it to your .env file.");
    }

    if (!fs.existsSync(MOVIES_DIR)) {
      throw new Error(`Movies directory not found: ${MOVIES_DIR}`);
    }

    const movieFiles = await collectMovieFiles(MOVIES_DIR);

    baseMovies = await mapWithConcurrency(movieFiles, 6, async (filePath) => {
      const parsedMovie = parseMovieFromFilename(filePath);
      const omdbMovie = parsedMovie ? await fetchOmdbMovie(parsedMovie.title, parsedMovie.year) : null;
      return buildMovieRecord(filePath, parsedMovie, omdbMovie);
    });

    rebuildMoviesIndex();
    lastScan = new Date().toISOString();
    await saveJsonFile(OMDB_CACHE_FILE, omdbCache);
    return moviesIndex;
  })().finally(() => {
    scanPromise = null;
  });

  return scanPromise;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    sourceDir: MOVIES_DIR || null,
    lastScan,
    movieCount: moviesIndex.length,
    manualOverrideCount: Object.keys(manualOverrides).length,
    trailerCacheCount: Object.keys(trailerCache).length
  });
});

app.get("/api/movies", async (_req, res) => {
  try {
    if (!lastScan) {
      await scanMovies();
    }

    res.json({
      sourceDir: MOVIES_DIR,
      lastScan,
      movieCount: moviesIndex.length,
      movies: moviesIndex.map((movie) => serializeMovie(movie))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/movies/:id/trailer", async (req, res) => {
  const { id } = req.params;
  const match = moviesIndex.find((movie) => movie.id === id);

  if (!match) {
    return res.status(404).json({ error: "Movie not found." });
  }

  try {
    const resolvedTrailer = await resolveTrailerEmbed(match);
    return res.json(resolvedTrailer);
  } catch (error) {
    console.error(`Trailer resolution failed for ${match.title}:`, error.message);
    return res.json({
      source: "error",
      query: null,
      videoId: null,
      embedUrl: null,
      externalUrl: match.trailerLink || null,
      error: error.message
    });
  }
});

app.post("/api/rescan", async (_req, res) => {
  try {
    await scanMovies();
    res.json({
      ok: true,
      lastScan,
      movieCount: moviesIndex.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/movies/:id/override", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: "Movie id is required." });
  }

  const movieExists = baseMovies.some((movie) => movie.id === id);
  if (!movieExists) {
    return res.status(404).json({ error: "Movie not found." });
  }

  const updates = sanitizeOverridePayload(req.body || {});
  if (!updates) {
    return res.status(400).json({ error: "No editable fields provided." });
  }

  const nextOverrides = { ...(manualOverrides[id] || {}) };

  for (const [field, value] of Object.entries(updates)) {
    if (value === null) {
      delete nextOverrides[field];
    } else {
      nextOverrides[field] = value;
    }
  }

  if (Object.keys(nextOverrides).length) {
    manualOverrides[id] = nextOverrides;
  } else {
    delete manualOverrides[id];
  }

  try {
    await saveJsonFile(OVERRIDES_FILE, manualOverrides);
    rebuildMoviesIndex();

    const movie = moviesIndex.find((item) => item.id === id);
    return res.json({
      ok: true,
      movie: movie ? serializeMovie(movie) : null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/play", (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "Movie id is required." });
  }

  const match = moviesIndex.find((movie) => movie.id === id);
  if (!match) {
    return res.status(404).json({ error: "Movie not found." });
  }

  try {
    openInDefaultPlayer(match.sourcePath);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function boot() {
  omdbCache = await loadJsonFile(OMDB_CACHE_FILE, {});
  manualOverrides = await loadJsonFile(OVERRIDES_FILE, {});
  trailerCache = await loadJsonFile(TRAILER_CACHE_FILE, {});

  if (!MOVIES_DIR || !OMDB_API_KEY) {
    console.warn("OMDB_API_KEY or MOVIES_DIR is missing. Update your .env file.");
  }

  try {
    await scanMovies();
    console.log(`Indexed ${moviesIndex.length} movie(s) from ${MOVIES_DIR}`);
  } catch (error) {
    console.error("Initial movie scan failed:", error.message);
  }

  app.listen(PORT, () => {
    console.log(`FlexFlix running on http://localhost:${PORT}`);
  });
}

boot().catch((error) => {
  console.error("Server failed to start:", error);
  process.exitCode = 1;
});

