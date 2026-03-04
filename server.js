const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const pinoHttp = require("pino-http");

require("dotenv").config();

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".avi", ".mov", ".wmv", ".webm"]);
const EDITABLE_FIELDS = ["title", "releaseYear", "rated", "description", "genre", "language", "country", "poster", "trailerLink"];
const MIN_PASSWORD_LENGTH = 8;

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
    trailerCache: path.join(config.dataDir, "trailer-cache.json"),
    usersEncrypted: path.join(config.dataDir, "users.secure.json"),
    session: path.join(config.dataDir, "auth-session.json"),
    settings: path.join(config.dataDir, "app-settings.json")
  };

  const state = {
    omdbCache: {},
    manualOverrides: {},
    trailerCache: {},
    usersById: {},
    usersVersion: 1,
    activeSession: null,
    authKey: null,
    settings: {
      moviesDir: String(config.moviesDir || "").trim()
    },
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

  function normalizeMoviesDir(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    return path.resolve(raw);
  }

  function getMoviesDir() {
    return normalizeMoviesDir(state.settings.moviesDir || config.moviesDir || "");
  }

  async function persistSettings() {
    await saveJsonFile(paths.settings, {
      moviesDir: getMoviesDir()
    });
  }

  async function setMoviesDir(nextDir) {
    const normalized = normalizeMoviesDir(nextDir);
    if (!normalized) {
      throw new Error("Movies folder path is required.");
    }

    let stats;
    try {
      stats = await fsp.stat(normalized);
    } catch {
      throw new Error("Movies folder not found: " + normalized);
    }

    if (!stats.isDirectory()) {
      throw new Error("Movies folder path must be a directory.");
    }

    const current = getMoviesDir();
    if (current.toLowerCase() === normalized.toLowerCase()) {
      return {
        changed: false,
        moviesDir: current
      };
    }

    state.settings.moviesDir = normalized;
    config.moviesDir = normalized;

    await persistSettings();

    state.baseMovies = [];
    state.moviesIndex = [];
    state.lastScan = null;

    await scanMovies();

    return {
      changed: true,
      moviesDir: normalized
    };
  }

  function normalizeEmail(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isValidEmail(value) {
    const email = normalizeEmail(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function sanitizeDisplayName(value) {
    const displayName = String(value || "").trim().replace(/\s+/g, " ");
    return displayName.slice(0, 64);
  }

  function sanitizeDisplayImage(value) {
    const image = String(value || "").trim();
    if (!image) {
      return null;
    }

    if (/^https?:\/\//i.test(image)) {
      return image.slice(0, 4096);
    }

    if (/^data:image\//i.test(image)) {
      return image.length <= 2_500_000 ? image : null;
    }

    return null;
  }

  function sanitizePublicUser(user) {
    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      displayImage: user.displayImage || null,
      createdAt: user.createdAt || null,
      lastLoginAt: user.lastLoginAt || null
    };
  }

  function getAuthSecretMaterial() {
    const configuredSecret = String(process.env.FLEXFLIX_AUTH_SECRET || "").trim();
    if (configuredSecret) {
      return configuredSecret;
    }

    let username = "unknown-user";
    try {
      username = os.userInfo().username || process.env.USERNAME || process.env.USER || username;
    } catch {
      username = process.env.USERNAME || process.env.USER || username;
    }

    const machineFingerprint = [
      os.hostname() || "unknown-host",
      username,
      process.platform,
      process.arch,
      config.dataDir
    ].join("|");

    return "flexflix-local-secret|" + machineFingerprint;
  }

  function getAuthKey() {
    if (!state.authKey) {
      state.authKey = crypto.scryptSync(getAuthSecretMaterial(), "flexflix-auth|" + config.dataDir, 32);
    }

    return state.authKey;
  }

  function encryptObject(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getAuthKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64")
    };
  }

  function decryptObject(payload) {
    if (!payload || payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) {
      throw new Error("Encrypted payload is invalid.");
    }

    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const data = Buffer.from(payload.data, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", getAuthKey(), iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(decrypted);
  }

  function normalizeUsersStore(payload) {
    const usersById = payload?.usersById && typeof payload.usersById === "object" ? payload.usersById : {};
    const cleanedUsersById = {};

    for (const [userId, user] of Object.entries(usersById)) {
      if (!user || typeof user !== "object") {
        continue;
      }

      const email = normalizeEmail(user.email);
      if (!email || !user.passwordHash || !user.passwordSalt) {
        continue;
      }

      cleanedUsersById[userId] = {
        id: user.id || userId,
        email,
        displayName: sanitizeDisplayName(user.displayName) || email,
        displayImage: sanitizeDisplayImage(user.displayImage),
        passwordHash: String(user.passwordHash),
        passwordSalt: String(user.passwordSalt),
        createdAt: user.createdAt || new Date().toISOString(),
        lastLoginAt: user.lastLoginAt || null
      };
    }

    return {
      version: Number(payload?.version) || 1,
      usersById: cleanedUsersById
    };
  }

  async function loadEncryptedUsersStore() {
    try {
      const content = await fsp.readFile(paths.usersEncrypted, "utf8");
      const parsed = JSON.parse(content);
      const decrypted = decryptObject(parsed);
      return normalizeUsersStore(decrypted);
    } catch {
      return {
        version: 1,
        usersById: {}
      };
    }
  }

  async function saveEncryptedUsersStore() {
    const payload = {
      version: state.usersVersion,
      usersById: state.usersById
    };

    const encrypted = encryptObject(payload);
    await fsp.mkdir(config.dataDir, { recursive: true });
    await fsp.writeFile(paths.usersEncrypted, JSON.stringify(encrypted, null, 2), "utf8");
  }

  function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 210000, 64, "sha512").toString("hex");
  }

  function verifyPassword(password, user) {
    const computed = hashPassword(password, user.passwordSalt);
    const stored = Buffer.from(user.passwordHash, "hex");
    const current = Buffer.from(computed, "hex");

    if (stored.length !== current.length) {
      return false;
    }

    return crypto.timingSafeEqual(stored, current);
  }

  function findUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return null;
    }

    for (const user of Object.values(state.usersById)) {
      if (user.email === normalizedEmail) {
        return user;
      }
    }

    return null;
  }

  async function saveActiveSession(userId) {
    state.activeSession = {
      userId,
      createdAt: new Date().toISOString()
    };

    await saveJsonFile(paths.session, state.activeSession);
  }

  async function clearActiveSession() {
    state.activeSession = null;

    try {
      await fsp.unlink(paths.session);
    } catch {
      // Ignore if already removed.
    }
  }

  async function loadActiveSession() {
    const session = await loadJsonFile(paths.session, null);
    if (!session || typeof session !== "object") {
      state.activeSession = null;
      return;
    }

    const userId = String(session.userId || "");
    if (!userId || !state.usersById[userId]) {
      state.activeSession = null;
      return;
    }

    state.activeSession = {
      userId,
      createdAt: session.createdAt || new Date().toISOString()
    };
  }

  function getActiveUser() {
    if (!state.activeSession?.userId) {
      return null;
    }

    return state.usersById[state.activeSession.userId] || null;
  }

  function ensureAuthenticated(req, res, next) {
    const user = getActiveUser();
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    req.activeUser = sanitizePublicUser(user);
    return next();
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
      const moviesDir = getMoviesDir();

      if (!moviesDir) {
        throw new Error("Movies folder is not configured. Set it in Settings.");
      }

      if (!fs.existsSync(moviesDir)) {
        throw new Error("Movies directory not found: " + moviesDir);
      }

      const movieFiles = await collectMovieFiles(moviesDir);

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

  app.get("/api/auth/session", (_req, res) => {
    const activeUser = getActiveUser();

    res.json({
      authenticated: Boolean(activeUser),
      user: sanitizePublicUser(activeUser),
      hasRegisteredUsers: Object.keys(state.usersById).length > 0
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const displayName = sanitizeDisplayName(body.displayName) || email;
    const displayImage = sanitizeDisplayImage(body.displayImage);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "Password must be at least " + MIN_PASSWORD_LENGTH + " characters." });
    }

    if (findUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const userId = crypto.randomUUID();
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, passwordSalt);
    const now = new Date().toISOString();

    state.usersById[userId] = {
      id: userId,
      email,
      displayName,
      displayImage,
      passwordHash,
      passwordSalt,
      createdAt: now,
      lastLoginAt: now
    };

    try {
      await saveEncryptedUsersStore();
      await saveActiveSession(userId);

      return res.status(201).json({
        ok: true,
        user: sanitizePublicUser(state.usersById[userId])
      });
    } catch (error) {
      logger.error({ err: error }, "Could not persist registered profile");
      return res.status(500).json({ error: "Could not save profile." });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    user.lastLoginAt = new Date().toISOString();

    try {
      await saveEncryptedUsersStore();
      await saveActiveSession(user.id);

      return res.json({
        ok: true,
        user: sanitizePublicUser(user)
      });
    } catch (error) {
      logger.error({ err: error }, "Could not persist login session");
      return res.status(500).json({ error: "Could not complete login." });
    }
  });

  app.post("/api/auth/logout", async (_req, res) => {
    try {
      await clearActiveSession();
      return res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Could not clear active session");
      return res.status(500).json({ error: "Could not sign out." });
    }
  });

  app.post("/api/auth/profile", ensureAuthenticated, async (req, res) => {
    const user = getActiveUser();
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const body = req.body || {};
    const displayName = sanitizeDisplayName(body.displayName) || user.email;
    const displayImage = sanitizeDisplayImage(body.displayImage);

    user.displayName = displayName;
    user.displayImage = displayImage;

    try {
      await saveEncryptedUsersStore();
      return res.json({
        ok: true,
        user: sanitizePublicUser(user)
      });
    } catch (error) {
      logger.error({ err: error }, "Could not save profile updates");
      return res.status(500).json({ error: "Could not update profile." });
    }
  });

  app.get("/api/settings", ensureAuthenticated, (_req, res) => {
    const moviesDir = getMoviesDir();

    res.json({
      moviesDir,
      lastScan: state.lastScan,
      movieCount: state.moviesIndex.length
    });
  });

  app.post("/api/settings/movies-dir", ensureAuthenticated, async (req, res) => {
    const body = req.body || {};
    const requestedPath = String(body.moviesDir || "").trim();

    try {
      const result = await setMoviesDir(requestedPath);

      return res.json({
        ok: true,
        changed: result.changed,
        moviesDir: result.moviesDir,
        lastScan: state.lastScan,
        movieCount: state.moviesIndex.length
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      sourceDir: getMoviesDir() || null,
      lastScan: state.lastScan,
      movieCount: state.moviesIndex.length,
      manualOverrideCount: Object.keys(state.manualOverrides).length,
      trailerCacheCount: Object.keys(state.trailerCache).length,
      vlcAvailable: Boolean(resolveVlcPath()),
      vlcPath: resolveVlcPath(),
      authenticated: Boolean(getActiveUser()),
      registeredUserCount: Object.keys(state.usersById).length,
      dataDir: config.dataDir
    });
  });

  app.get("/api/movies", ensureAuthenticated, async (_req, res) => {
    try {
      if (!state.lastScan) {
        await scanMovies();
      }

      res.json({
        sourceDir: getMoviesDir(),
        lastScan: state.lastScan,
        movieCount: state.moviesIndex.length,
        movies: state.moviesIndex.map((movie) => serializeMovie(movie))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/movies/:id/trailer", ensureAuthenticated, async (req, res) => {
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

  app.post("/api/rescan", ensureAuthenticated, async (_req, res) => {
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

  app.post("/api/movies/:id/override", ensureAuthenticated, async (req, res) => {
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

  app.post("/api/play", ensureAuthenticated, (req, res) => {
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

    const savedSettings = await loadJsonFile(paths.settings, {});
    const savedMoviesDir = normalizeMoviesDir(savedSettings.moviesDir);
    if (savedMoviesDir) {
      state.settings.moviesDir = savedMoviesDir;
      config.moviesDir = savedMoviesDir;
    } else {
      state.settings.moviesDir = normalizeMoviesDir(config.moviesDir);
    }

    await persistSettings();

    const usersStore = await loadEncryptedUsersStore();
    state.usersById = usersStore.usersById;
    state.usersVersion = usersStore.version;
    await loadActiveSession();

    if (state.activeSession?.userId) {
      logger.info({ userId: state.activeSession.userId }, "Restored active user session");
    }

    if (!getMoviesDir() || !config.omdbApiKey) {
      logger.warn("OMDB_API_KEY or Movies folder is missing. Update configuration in Settings.");
    }

    if (!resolveVlcPath()) {
      logger.warn("VLC executable not found. Set VLC_PATH in .env to enable Play in VLC.");
    }

    try {
      await scanMovies();
      logger.info({ movieCount: state.moviesIndex.length, sourceDir: getMoviesDir() }, "Initial movie scan complete");
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
      sourceDir: getMoviesDir(),
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

