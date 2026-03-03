const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const pinoHttp = require("pino-http");

require("dotenv").config();

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".avi", ".mov", ".wmv", ".webm"]);
const EDITABLE_FIELDS = ["title", "releaseYear", "rated", "description", "genre", "language", "country", "poster", "trailerLink"];

function parsePort(value, fallback) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fallback;
  }
  return port;
}

function buildRuntimeConfig(overrides = {}) {
  const envPort = parsePort(process.env.PORT, 3000);
  const envApiRateLimit = Number(process.env.API_RATE_LIMIT_PER_MINUTE || 300);

  return {
    host: String(overrides.host || process.env.HOST || "127.0.0.1"),
    port: parsePort(overrides.port, envPort),
    moviesDir: overrides.moviesDir || process.env.MOVIES_DIR || "",
    omdbApiKey: overrides.omdbApiKey || process.env.OMDB_API_KEY || "",
    vlcPath: String(overrides.vlcPath || process.env.VLC_PATH || "").trim(),
    nodeEnv: String(overrides.nodeEnv || process.env.NODE_ENV || "production").trim(),
    logLevel: String(overrides.logLevel || process.env.LOG_LEVEL || "info").trim(),
    dataDir: path.resolve(overrides.dataDir || process.env.APP_DATA_DIR || path.join(__dirname, ".cache")),
    staticDir: path.resolve(overrides.staticDir || path.join(__dirname, "public")),
    apiRateLimitPerMinute:
      Number.isFinite(overrides.apiRateLimitPerMinute) && overrides.apiRateLimitPerMinute > 0
        ? Number(overrides.apiRateLimitPerMinute)
        : Number.isFinite(envApiRateLimit) && envApiRateLimit > 0
          ? envApiRateLimit
          : 300
  };
}

function createFlexServer(overrides = {}) {
  const config = buildRuntimeConfig(overrides);

  const logger = pino({
    name: "flexflix",
    level: config.logLevel,
    base: {
      pid: process.pid,
      service: "flexflix"
    }
  });

  const app = express();

  const paths = {
    omdbCache: path.join(config.dataDir, "omdb-cache.json"),
    overrides: path.join(config.dataDir, "manual-overrides.json"),
    trailerCache: path.join(config.dataDir, "trailer-cache.json")
  };

  const state = {
    omdbCache: {},
    manualOverrides: {},
    trailerCache: {},
    baseMovies: [],
    moviesIndex: [],
    lastScan: null,
    scanPromise: null,
    resolvedVlcPath: null,
    server: null
  };

  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      // YouTube embed may fail with error 153 when referrer is stripped entirely.
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin"
      }
    })
  );

  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: config.nodeEnv !== "test"
    })
  );

  app.use(
    "/api",
    rateLimit({
      windowMs: 60 * 1000,
      max: config.apiRateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.use(express.static(config.staticDir));

  function createMovieId(filePath) {
    return crypto.createHash("sha1").update(filePath).digest("hex");
  }

  function normalizeTitle(text) {
    return String(text || "")
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
    await fsp.mkdir(config.dataDir, { recursive: true });
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
    const overrides = state.manualOverrides[movie.id] || null;
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
    state.moviesIndex = state.baseMovies
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
      } catch {
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
    if (Object.prototype.hasOwnProperty.call(state.trailerCache, cacheKey)) {
      return state.trailerCache[cacheKey];
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

    state.trailerCache[cacheKey] = result;
    saveJsonFile(paths.trailerCache, state.trailerCache).catch(() => {});

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
    if (!config.omdbApiKey) {
      return null;
    }

    const cacheKey = `${title.toLowerCase()}|${year}`;
    if (Object.prototype.hasOwnProperty.call(state.omdbCache, cacheKey)) {
      return state.omdbCache[cacheKey];
    }

    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", config.omdbApiKey);
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
        state.omdbCache[cacheKey] = null;
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

      state.omdbCache[cacheKey] = movie;
      return movie;
    } catch (error) {
      logger.warn({ title, year, err: error }, "OMDb lookup failed");
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

  function resolveVlcPath() {
    if (state.resolvedVlcPath && fs.existsSync(state.resolvedVlcPath)) {
      return state.resolvedVlcPath;
    }

    const candidates = [
      config.vlcPath,
      "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
      "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "VideoLAN", "VLC", "vlc.exe") : null
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        state.resolvedVlcPath = candidate;
        return candidate;
      }
    }

    return null;
  }

  function openInVlc(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error("Movie file is no longer available on disk.");
    }

    const vlcExecutable = resolveVlcPath();
    if (!vlcExecutable) {
      throw new Error(
        "VLC executable not found. Install VLC or set VLC_PATH in .env (example: C:\\Program Files\\VideoLAN\\VLC\\vlc.exe)."
      );
    }

    const child = spawn(vlcExecutable, [filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    child.unref();
  }

  async function scanMovies() {
    if (state.scanPromise) {
      return state.scanPromise;
    }

    state.scanPromise = (async () => {
      if (!config.moviesDir) {
        throw new Error("MOVIES_DIR is not configured. Add it to your .env file.");
      }

      if (!fs.existsSync(config.moviesDir)) {
        throw new Error(`Movies directory not found: ${config.moviesDir}`);
      }

      const movieFiles = await collectMovieFiles(config.moviesDir);

      state.baseMovies = await mapWithConcurrency(movieFiles, 6, async (filePath) => {
        const parsedMovie = parseMovieFromFilename(filePath);
        const omdbMovie = parsedMovie ? await fetchOmdbMovie(parsedMovie.title, parsedMovie.year) : null;
        return buildMovieRecord(filePath, parsedMovie, omdbMovie);
      });

      rebuildMoviesIndex();
      state.lastScan = new Date().toISOString();
      await saveJsonFile(paths.omdbCache, state.omdbCache);
      return state.moviesIndex;
    })().finally(() => {
      state.scanPromise = null;
    });

    return state.scanPromise;
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      sourceDir: config.moviesDir || null,
      lastScan: state.lastScan,
      movieCount: state.moviesIndex.length,
      manualOverrideCount: Object.keys(state.manualOverrides).length,
      trailerCacheCount: Object.keys(state.trailerCache).length,
      vlcAvailable: Boolean(resolveVlcPath()),
      vlcPath: resolveVlcPath(),
      dataDir: config.dataDir
    });
  });

  app.get("/api/movies", async (_req, res) => {
    try {
      if (!state.lastScan) {
        await scanMovies();
      }

      res.json({
        sourceDir: config.moviesDir,
        lastScan: state.lastScan,
        movieCount: state.moviesIndex.length,
        movies: state.moviesIndex.map((movie) => serializeMovie(movie))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/movies/:id/trailer", async (req, res) => {
    const { id } = req.params;
    const match = state.moviesIndex.find((movie) => movie.id === id);

    if (!match) {
      return res.status(404).json({ error: "Movie not found." });
    }

    try {
      const resolvedTrailer = await resolveTrailerEmbed(match);
      return res.json(resolvedTrailer);
    } catch (error) {
      logger.warn({ movieId: id, title: match.title, err: error }, "Trailer resolution failed");
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
        lastScan: state.lastScan,
        movieCount: state.moviesIndex.length
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

    const movieExists = state.baseMovies.some((movie) => movie.id === id);
    if (!movieExists) {
      return res.status(404).json({ error: "Movie not found." });
    }

    const updates = sanitizeOverridePayload(req.body || {});
    if (!updates) {
      return res.status(400).json({ error: "No editable fields provided." });
    }

    const nextOverrides = { ...(state.manualOverrides[id] || {}) };

    for (const [field, value] of Object.entries(updates)) {
      if (value === null) {
        delete nextOverrides[field];
      } else {
        nextOverrides[field] = value;
      }
    }

    if (Object.keys(nextOverrides).length) {
      state.manualOverrides[id] = nextOverrides;
    } else {
      delete state.manualOverrides[id];
    }

    try {
      await saveJsonFile(paths.overrides, state.manualOverrides);
      rebuildMoviesIndex();

      const movie = state.moviesIndex.find((item) => item.id === id);
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

    const match = state.moviesIndex.find((movie) => movie.id === id);
    if (!match) {
      return res.status(404).json({ error: "Movie not found." });
    }

    try {
      openInVlc(match.sourcePath);
      return res.json({ ok: true, player: "vlc" });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(config.staticDir, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    logger.error({ err: error }, "Unhandled request error");
    if (res.headersSent) {
      return;
    }

    res.status(500).json({ error: "Internal server error." });
  });

  async function start() {
    state.omdbCache = await loadJsonFile(paths.omdbCache, {});
    state.manualOverrides = await loadJsonFile(paths.overrides, {});
    state.trailerCache = await loadJsonFile(paths.trailerCache, {});

    if (!config.moviesDir || !config.omdbApiKey) {
      logger.warn("OMDB_API_KEY or MOVIES_DIR is missing. Update your .env file.");
    }

    if (!resolveVlcPath()) {
      logger.warn("VLC executable not found. Set VLC_PATH in .env to enable Play in VLC.");
    }

    try {
      await scanMovies();
      logger.info({ movieCount: state.moviesIndex.length, sourceDir: config.moviesDir }, "Initial movie scan complete");
    } catch (error) {
      logger.warn({ err: error }, "Initial movie scan failed");
    }

    await new Promise((resolve, reject) => {
      state.server = app.listen(config.port, config.host, () => {
        resolve();
      });
      state.server.once("error", reject);
    });

    const address = state.server.address();
    const boundPort = typeof address === "object" && address ? address.port : config.port;

    logger.info({ host: config.host, port: boundPort, dataDir: config.dataDir }, "FlexFlix server started");

    return {
      host: config.host,
      port: boundPort
    };
  }

  async function stop() {
    if (!state.server) {
      return;
    }

    await new Promise((resolve, reject) => {
      state.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    state.server = null;
    logger.info("FlexFlix server stopped");
  }

  return {
    app,
    config,
    logger,
    start,
    stop,
    scanMovies,
    getState: () => ({
      movieCount: state.moviesIndex.length,
      lastScan: state.lastScan,
      dataDir: config.dataDir
    })
  };
}

async function runStandalone() {
  const flexServer = createFlexServer();

  const shutdown = async (signal) => {
    try {
      flexServer.logger.info({ signal }, "Shutting down");
      await flexServer.stop();
      process.exit(0);
    } catch (error) {
      flexServer.logger.error({ err: error }, "Shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("uncaughtException", (error) => {
    flexServer.logger.error({ err: error }, "Uncaught exception");
  });

  process.on("unhandledRejection", (reason) => {
    flexServer.logger.error({ err: reason }, "Unhandled promise rejection");
  });

  await flexServer.start();
}

if (require.main === module) {
  runStandalone().catch((error) => {
    console.error("Server failed to start:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createFlexServer
};

