import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteError } from "better-sqlite3";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  net,
  protocol,
  type Rectangle,
  safeStorage,
  screen,
  shell,
} from "electron";
import { chromium } from "playwright";
import { ZodError } from "zod";
import { AiError } from "../server/ai/errors.js";
import { ApplicationApi, ApplicationApiError, LOCAL_USER_ID } from "../server/application-api.js";
import { AppDatabase } from "../server/database.js";
import { InvalidRequestError, OperationForbiddenError } from "../server/errors.js";
import { ExtractionQueue } from "../server/extraction.js";
import { AiService } from "../server/features/ai/service.js";
import { FeedDiscoveryError } from "../server/feed-discovery.js";
import { closePublicNetwork } from "../server/public-network.js";
import { QuotaExceededError } from "../server/quota.js";
import { FeedRefreshService } from "../server/refresh.js";
import { TelegramMediaService } from "../server/telegram-media.js";
import { WebFeedError, WebFeedService } from "../server/web-feed.js";
import { XMediaService } from "../server/x-media.js";
import {
  DESKTOP_DATA_CHANGED_CHANNEL,
  DESKTOP_OPERATIONS,
  type DesktopRequest,
  type DesktopResponse,
} from "../shared/desktop.js";
import { DesktopCredentialCipher } from "./credential-cipher.js";
import { youtubeEmbedRequestHeaders } from "./youtube-player.js";

const PRODUCT_NAME = "feedfold";
const configuredUserDataPath = process.env.FEEDFOLD_DESKTOP_USER_DATA;
const userDataPath = resolve(configuredUserDataPath ?? join(app.getPath("appData"), PRODUCT_NAME));

// Safe Storage derives its macOS Keychain identity from Electron's internal application name.
app.setName(PRODUCT_NAME);
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "feedfold",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const DESKTOP_ORIGIN = "feedfold://app";
const APP_URL = `${DESKTOP_ORIGIN}/`;
const DEFAULT_WINDOW_BOUNDS = { width: 1440, height: 940 };
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 620;
const WINDOW_STATE_SAVE_DELAY_MS = 250;
const developmentUrl = process.env.FEEDFOLD_DESKTOP_DEV_URL;
const smokeTest = process.env.FEEDFOLD_DESKTOP_SMOKE === "1";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

type WindowState = {
  bounds: Rectangle;
  mode: "normal" | "maximized" | "fullscreen";
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function desktopBrowserExecutable(): string {
  const browserRoot = app.isPackaged
    ? join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "playwright-core",
        ".local-browsers",
      )
    : join(app.getAppPath(), "node_modules", "playwright-core", ".local-browsers");
  const revision = existsSync(browserRoot)
    ? readdirSync(browserRoot).find((entry) => entry.startsWith("chromium_headless_shell-"))
    : undefined;
  if (revision) {
    const platform =
      process.platform === "darwin"
        ? `mac-${process.arch}`
        : process.platform === "win32"
          ? "win64"
          : "linux";
    const executableName =
      process.platform === "win32" ? "headless_shell.exe" : "chrome-headless-shell";
    const executable = join(
      browserRoot,
      revision,
      `chrome-headless-shell-${platform}`,
      executableName,
    );
    if (existsSync(executable)) return executable;
  }
  if (!app.isPackaged) return chromium.executablePath();
  throw new Error("The packaged web-feed browser is missing.");
}

class DesktopRuntime {
  readonly database: AppDatabase;
  readonly extractionQueue: ExtractionQueue;
  readonly webFeedService: WebFeedService;
  readonly refreshService: FeedRefreshService;
  readonly application: ApplicationApi;
  private readonly unsubscribeFromRefresh: () => void;

  constructor() {
    const databasePath = resolve(join(app.getPath("userData"), "feedfold.db"));
    const pollIntervalMinutes = positiveInteger(
      process.env.POLL_INTERVAL_MINUTES,
      20,
      "POLL_INTERVAL_MINUTES",
    );
    const feedFetchTimeoutMs = positiveInteger(
      process.env.FEED_FETCH_TIMEOUT_MS,
      15_000,
      "FEED_FETCH_TIMEOUT_MS",
    );
    const webFeedLoadTimeoutMs = positiveInteger(
      process.env.WEB_FEED_LOAD_TIMEOUT_MS,
      30_000,
      "WEB_FEED_LOAD_TIMEOUT_MS",
    );
    const articleFetchTimeoutMs = positiveInteger(
      process.env.ARTICLE_FETCH_TIMEOUT_MS,
      20_000,
      "ARTICLE_FETCH_TIMEOUT_MS",
    );
    const aiRequestTimeoutMs = positiveInteger(
      process.env.AI_REQUEST_TIMEOUT_MS,
      60_000,
      "AI_REQUEST_TIMEOUT_MS",
    );

    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new AppDatabase(databasePath, pollIntervalMinutes);
    this.extractionQueue = new ExtractionQueue(this.database.extractions, 2, articleFetchTimeoutMs);
    this.webFeedService = new WebFeedService({
      timeoutMs: webFeedLoadTimeoutMs,
      allowPrivateNetworks:
        smokeTest && process.env.FEEDFOLD_DESKTOP_SMOKE_ALLOW_PRIVATE_NETWORKS === "1",
      browserFactory: () =>
        chromium.launch({
          executablePath: desktopBrowserExecutable(),
          args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
          headless: true,
          chromiumSandbox: process.platform === "linux",
        }),
    });
    this.refreshService = new FeedRefreshService(
      this.database.feeds,
      3,
      feedFetchTimeoutMs,
      this.webFeedService,
    );
    this.unsubscribeFromRefresh = this.refreshService.subscribe(
      LOCAL_USER_ID,
      notifyRendererDataChanged,
    );
    const aiService = new AiService(this.database, {
      credentialCipher:
        !smokeTest && safeStorage.isEncryptionAvailable() ? new DesktopCredentialCipher() : null,
      requestTimeoutMs: aiRequestTimeoutMs,
    });
    this.application = new ApplicationApi({
      database: this.database,
      extractionQueue: this.extractionQueue,
      refreshService: this.refreshService,
      webFeedService: this.webFeedService,
      aiService,
      telegramMediaService: new TelegramMediaService(feedFetchTimeoutMs),
      xMediaService: new XMediaService(feedFetchTimeoutMs),
      feedDiscoveryTimeoutMs: feedFetchTimeoutMs,
    });
  }

  start(): void {
    this.extractionQueue.start();
    this.refreshService.start();
  }

  async close(): Promise<void> {
    this.unsubscribeFromRefresh();
    await Promise.all([this.refreshService.stop(), this.extractionQueue.stop()]);
    await this.webFeedService.close();
    await closePublicNetwork();
    this.database.close();
  }
}

let runtime: DesktopRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let flushWindowState: (() => Promise<void>) | null = null;
let shuttingDown = false;

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

async function readWindowState(): Promise<WindowState | null> {
  try {
    return JSON.parse(await readFile(windowStatePath(), "utf8")) as WindowState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function restoreWindowBounds(bounds: Rectangle): Rectangle {
  const { workArea } = screen.getDisplayMatching(bounds);
  const width = Math.min(Math.max(bounds.width, MIN_WINDOW_WIDTH), workArea.width);
  const height = Math.min(Math.max(bounds.height, MIN_WINDOW_HEIGHT), workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function trackWindowState(window: BrowserWindow, initialState: WindowState): () => Promise<void> {
  let latestState = initialState;
  let saveTimer: NodeJS.Timeout | null = null;
  let pendingWrite = Promise.resolve();

  const capture = () => {
    const mode = window.isFullScreen()
      ? "fullscreen"
      : window.isMaximized()
        ? "maximized"
        : "normal";
    latestState = {
      bounds: mode === "normal" ? window.getBounds() : latestState.bounds,
      mode,
    };
  };
  const persist = () => {
    const path = windowStatePath();
    const temporaryPath = `${path}.tmp`;
    const contents = `${JSON.stringify(latestState, null, 2)}\n`;
    pendingWrite = pendingWrite.then(async () => {
      await writeFile(temporaryPath, contents, "utf8");
      await rename(temporaryPath, path);
    });
    return pendingWrite;
  };
  const scheduleSave = () => {
    capture();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist().catch(() => console.error("feedfold could not save its window state"));
    }, WINDOW_STATE_SAVE_DELAY_MS);
  };

  window.on("move", scheduleSave);
  window.on("resize", scheduleSave);
  window.on("maximize", scheduleSave);
  window.on("unmaximize", scheduleSave);
  window.on("enter-full-screen", scheduleSave);
  window.on("leave-full-screen", scheduleSave);
  window.on("close", scheduleSave);

  return async () => {
    if (!window.isDestroyed()) capture();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await persist();
  };
}

function errorResponse(error: unknown): DesktopResponse {
  if (error instanceof ApplicationApiError) {
    return {
      ok: false,
      error: { message: error.message, status: error.status, code: error.code },
    };
  }
  if (error instanceof AiError) {
    return {
      ok: false,
      error: { message: error.message, status: error.statusCode, code: error.code },
    };
  }
  if (error instanceof WebFeedError) {
    return {
      ok: false,
      error: { message: error.message, status: 422, code: error.kind },
    };
  }
  if (error instanceof FeedDiscoveryError) {
    return {
      ok: false,
      error: { message: error.message, status: 422, code: error.kind },
    };
  }
  if (error instanceof ZodError) {
    return {
      ok: false,
      error: {
        message: error.issues[0]?.message ?? "The request is invalid.",
        status: 400,
        code: null,
      },
    };
  }
  if (error instanceof InvalidRequestError) {
    return { ok: false, error: { message: error.message, status: 400, code: null } };
  }
  if (error instanceof OperationForbiddenError) {
    return { ok: false, error: { message: error.message, status: 403, code: null } };
  }
  if (error instanceof QuotaExceededError) {
    return {
      ok: false,
      error: { message: error.message, status: error.statusCode, code: error.code },
    };
  }
  if (error instanceof SqliteError) {
    if (error.code === "SQLITE_FULL") {
      return {
        ok: false,
        error: {
          message: "This feedfold server has reached its storage limit.",
          status: 507,
          code: "quota_exceeded",
        },
      };
    }
    if (
      error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      return {
        ok: false,
        error: { message: "This item already exists.", status: 409, code: null },
      };
    }
    if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return {
        ok: false,
        error: {
          message: "That feed or folder no longer exists. Reload and try again.",
          status: 400,
          code: null,
        },
      };
    }
  }
  console.error("feedfold desktop request failed");
  return {
    ok: false,
    error: {
      message: "feedfold could not complete the request. Try again.",
      status: 500,
      code: null,
    },
  };
}

function trustedRenderer(url: string): boolean {
  if (url.startsWith(`${DESKTOP_ORIGIN}/`)) return true;
  if (!developmentUrl) return false;
  try {
    return new URL(url).origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
}

function trustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame === event.sender.mainFrame &&
    trustedRenderer(frame?.url ?? "")
  );
}

function notifyRendererDataChanged(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  const frame = window.webContents.mainFrame;
  if (frame.isDestroyed() || frame.detached || !trustedRenderer(frame.url)) return;
  frame.send(DESKTOP_DATA_CHANGED_CHANNEL);
}

function validDesktopRequest(value: unknown): value is DesktopRequest {
  if (!value || typeof value !== "object") return false;
  const operation = (value as { operation?: unknown }).operation;
  return (
    typeof operation === "string" && (DESKTOP_OPERATIONS as readonly string[]).includes(operation)
  );
}

async function invoke(request: DesktopRequest): Promise<DesktopResponse> {
  if (!runtime) {
    return {
      ok: false,
      error: { message: "feedfold is still starting.", status: 503, code: null },
    };
  }
  try {
    return { ok: true, value: await runtime.application.invoke(request) };
  } catch (error) {
    return errorResponse(error);
  }
}

function registerIpc(): void {
  ipcMain.handle("feedfold:invoke", async (event, request: unknown) => {
    if (!trustedIpcSender(event)) {
      return errorResponse(new ApplicationApiError(403, "This request is not allowed."));
    }
    if (!validDesktopRequest(request)) {
      return errorResponse(new ApplicationApiError(400, "The desktop request is invalid."));
    }
    return invoke(request);
  });

  ipcMain.handle("feedfold:export-opml", async (event) => {
    if (!trustedIpcSender(event)) {
      return errorResponse(new ApplicationApiError(403, "This request is not allowed."));
    }
    const response = await invoke({ operation: "exportOpml" });
    if (!response.ok || typeof response.value !== "string") return response;
    const options = {
      title: "Export subscriptions",
      defaultPath: "feedfold-subscriptions.opml",
      filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (!result.canceled && result.filePath) {
      await writeFile(result.filePath, response.value, "utf8");
    }
    return { ok: true, value: undefined } satisfies DesktopResponse;
  });
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const appCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https://www.youtube.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const snapshotCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function htmlResponse(body: string, csp: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function applicationResource(pathname: string, request: Request): Promise<Response | null> {
  if (!runtime) return new Response("feedfold is still starting", { status: 503 });
  const snapshotMatch = pathname.match(/^\/api\/web-feed-snapshots\/([^/]+)$/);
  if (snapshotMatch) {
    try {
      return htmlResponse(
        runtime.application.snapshot(decodeURIComponent(snapshotMatch[1])),
        snapshotCsp,
      );
    } catch {
      return new Response("This page preview has expired.", { status: 404 });
    }
  }
  const telegramPreviewMatch = pathname.match(/^\/api\/articles\/(\d+)\/telegram-media-preview$/);
  if (telegramPreviewMatch) {
    try {
      const url = await runtime.application.telegramPreviewUrl(Number(telegramPreviewMatch[1]));
      return net.fetch(url, { headers: request.headers });
    } catch {
      return new Response("Telegram media was not found.", { status: 404 });
    }
  }
  return null;
}

function safeClientPath(clientRoot: string, pathname: string): string | null {
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const candidate = join(clientRoot, relativePath);
  const outside = relative(clientRoot, candidate);
  if (outside.startsWith("..") || outside.includes(`..${sep}`)) return null;
  return candidate;
}

async function registerApplicationProtocol(): Promise<void> {
  const clientRoot = join(app.getAppPath(), "dist", "client");
  await protocol.handle("feedfold", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const resource = await applicationResource(url.pathname, request);
      if (resource) return resource;

      const requestedPath = safeClientPath(clientRoot, decodeURIComponent(url.pathname));
      if (!requestedPath) return new Response("Not found", { status: 404 });
      let path = requestedPath;
      try {
        const body = await readFile(path);
        return new Response(body, {
          headers: {
            "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
            "Content-Security-Policy": appCsp,
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        if (extname(path)) return new Response("Not found", { status: 404 });
        path = join(clientRoot, "index.html");
        return htmlResponse(await readFile(path, "utf8"), appCsp);
      }
    } catch {
      console.error("feedfold desktop resource request failed");
      return new Response("Could not load feedfold", { status: 500 });
    }
  });
}

function installMenu(): void {
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: PRODUCT_NAME,
        submenu: [
          { label: `About ${PRODUCT_NAME}`, role: "about" },
          { type: "separator" },
          { label: `Hide ${PRODUCT_NAME}`, role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: `Quit ${PRODUCT_NAME}`, role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

async function createWindow(): Promise<void> {
  await flushWindowState?.();
  const savedState = await readWindowState();
  const window = new BrowserWindow({
    ...(savedState ? restoreWindowBounds(savedState.bounds) : DEFAULT_WINDOW_BOUNDS),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: "#0f1211",
    title: "feedfold",
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  flushWindowState = trackWindowState(window, {
    bounds: window.getBounds(),
    mode: savedState?.mode ?? "normal",
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube.com/embed/*"] },
    (details, callback) => {
      callback({
        requestHeaders: youtubeEmbedRequestHeaders(details, window.webContents.id),
      });
    },
  );
  window.webContents.on("will-navigate", (event, url) => {
    if (trustedRenderer(url)) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
  });
  window.once("ready-to-show", () => {
    if (savedState?.mode === "maximized") window.maximize();
    if (savedState?.mode === "fullscreen") window.setFullScreen(true);
    if (!smokeTest) window.show();
  });
  await window.loadURL(developmentUrl ?? APP_URL);

  if (smokeTest) {
    const result = (await window.webContents.executeJavaScript(
      `window.feedfoldDesktop.invoke({ operation: "bootstrap" })`,
      true,
    )) as DesktopResponse;
    if (!result.ok) throw new Error(result.error.message);
    const webFeedUrl = process.env.FEEDFOLD_DESKTOP_SMOKE_WEB_FEED_URL;
    if (webFeedUrl) {
      const analysis = (await window.webContents.executeJavaScript(
        `window.feedfoldDesktop.invoke({ operation: "analyzeWebPage", payload: { url: ${JSON.stringify(webFeedUrl)} } })`,
        true,
      )) as DesktopResponse;
      if (!analysis.ok) throw new Error(analysis.error.message);
      const candidates = (analysis.value as { candidates?: unknown[] }).candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error("The packaged web-feed browser did not find the rendered entries.");
      }
      console.log("FEEDFOLD_DESKTOP_WEB_FEED_SMOKE_OK");
    }
    console.log("FEEDFOLD_DESKTOP_SMOKE_OK");
    app.quit();
  }
}

async function start(): Promise<void> {
  runtime = new DesktopRuntime();
  runtime.start();
  registerIpc();
  await registerApplicationProtocol();
  installMenu();
  await createWindow();
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("activate", () => {
    if (!mainWindow) void createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (shuttingDown || !runtime) return;
    event.preventDefault();
    shuttingDown = true;
    const closing = runtime;
    runtime = null;
    void Promise.all([closing.close(), flushWindowState?.() ?? Promise.resolve()])
      .catch(() => console.error("feedfold desktop shutdown failed"))
      .finally(() => app.quit());
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error("feedfold desktop startup failed");
      dialog.showErrorBox(
        "feedfold could not start",
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
}
