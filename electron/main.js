const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { app, BrowserWindow, dialog, shell } = require("electron");
const { createFlexServer } = require("../server");

let mainWindow = null;
let flexServer = null;
let backendPort = null;
let isQuitting = false;

app.setName("FlexFlix");

const DEFAULT_DESKTOP_CONFIG = {
  moviesDir: "D:\\Movies",
  omdbApiKey: "b1663db",
  vlcPath: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
  logLevel: "info",
  apiRateLimitPerMinute: 300
};

function getDesktopConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

async function loadDesktopConfig() {
  const configPath = getDesktopConfigPath();
  let fileConfig = {};

  try {
    const content = await fsp.readFile(configPath, "utf8");
    fileConfig = JSON.parse(content);
  } catch {
    fileConfig = {};
  }

  const merged = {
    moviesDir: process.env.MOVIES_DIR || fileConfig.moviesDir || DEFAULT_DESKTOP_CONFIG.moviesDir,
    omdbApiKey: process.env.OMDB_API_KEY || fileConfig.omdbApiKey || DEFAULT_DESKTOP_CONFIG.omdbApiKey,
    vlcPath: process.env.VLC_PATH || fileConfig.vlcPath || DEFAULT_DESKTOP_CONFIG.vlcPath,
    logLevel: process.env.LOG_LEVEL || fileConfig.logLevel || DEFAULT_DESKTOP_CONFIG.logLevel,
    apiRateLimitPerMinute:
      Number(process.env.API_RATE_LIMIT_PER_MINUTE || fileConfig.apiRateLimitPerMinute || DEFAULT_DESKTOP_CONFIG.apiRateLimitPerMinute) ||
      DEFAULT_DESKTOP_CONFIG.apiRateLimitPerMinute
  };

  const fileNeedsWrite =
    !fs.existsSync(configPath) ||
    Object.keys(merged).some((key) => fileConfig[key] !== merged[key]);

  if (fileNeedsWrite) {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify(merged, null, 2), "utf8");
  }

  return {
    ...merged,
    configPath
  };
}

function createMainWindow(port) {
  const preloadPath = path.join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0a0a0a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const trustedPrefix = `http://127.0.0.1:${port}`;
    if (!url.startsWith(trustedPrefix)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const targetUrl = `http://127.0.0.1:${port}`;
  mainWindow.loadURL(targetUrl).catch((error) => {
    dialog.showErrorBox("FlexFlix", `Could not open app window: ${error.message}`);
  });
}

async function startBackend() {
  const dataDir = path.join(app.getPath("userData"), "data");
  const desktopConfig = await loadDesktopConfig();

  flexServer = createFlexServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    nodeEnv: app.isPackaged ? "production" : "development",
    moviesDir: desktopConfig.moviesDir,
    omdbApiKey: desktopConfig.omdbApiKey,
    vlcPath: desktopConfig.vlcPath,
    logLevel: desktopConfig.logLevel,
    apiRateLimitPerMinute: desktopConfig.apiRateLimitPerMinute
  });

  const started = await flexServer.start();
  backendPort = started.port;

  const health = await fetch(`http://127.0.0.1:${started.port}/api/health`).then((res) => res.json()).catch(() => null);
  if (!health || !health.sourceDir) {
    dialog.showErrorBox(
      "FlexFlix configuration",
      `Movie directory is not configured. Update:\n${desktopConfig.configPath}\n\nSet \"moviesDir\" to your local movies folder.`
    );
  }

  return started;
}

async function shutdownAndExit(exitCode = 0) {
  if (isQuitting) {
    return;
  }

  isQuitting = true;

  try {
    if (flexServer) {
      await flexServer.stop();
    }
  } catch {
    // Ignore shutdown errors while exiting.
  }

  app.exit(exitCode);
}

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  void shutdownAndExit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void shutdownAndExit(0);
  }
});

app.on("activate", () => {
  if (!mainWindow && backendPort) {
    createMainWindow(backendPort);
  }
});

app.whenReady().then(async () => {
  try {
    const started = await startBackend();
    createMainWindow(started.port);
  } catch (error) {
    dialog.showErrorBox("FlexFlix startup failed", error.message);
    await shutdownAndExit(1);
  }
});
