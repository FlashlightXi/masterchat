// https://www.electronjs.org/docs/api/session

const { app, BrowserWindow } = require("electron");

const isSingleInstance = app.requestSingleInstanceLock();

if (!isSingleInstance) {
  app.quit();
  process.exit(0);
}

// NOTE: why tho?
app.disableHardwareAcceleration();

const AUTH_COOKIE_NAMES = ["APISID", "HSID", "SAPISID", "SID", "SSID"];
const LONG_LIVED_SECURE_COOKIE_NAMES = [
  "__Secure-1PAPISID",
  "__Secure-1PSID",
  "__Secure-3PAPISID",
  "__Secure-3PSID",
];
const SHORT_LIVED_COOKIE_NAMES = [
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
];
const ALL_COOKIE_NAMES = new Set([
  ...AUTH_COOKIE_NAMES,
  ...LONG_LIVED_SECURE_COOKIE_NAMES,
  ...SHORT_LIVED_COOKIE_NAMES,
]);
const includeShortLived = process.argv.includes("--full");
const PACKED_COOKIE_NAMES = new Set([
  ...AUTH_COOKIE_NAMES,
  ...LONG_LIVED_SECURE_COOKIE_NAMES,
  ...(includeShortLived ? SHORT_LIVED_COOKIE_NAMES : []),
]);

const CONTINUE_URL =
  "https://www.youtube.com/signin?action_handle_signin=true&app=desktop&next=" +
  encodeURIComponent("https://www.youtube.com/");
const LOGIN_URL =
  "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&uilel=3&continue=" +
  encodeURIComponent(CONTINUE_URL);

function stripElectronFromUserAgent(ua) {
  return ua.replace(/\sElectron\/\S+/g, "");
}

let mainWindow = null;
let extracting = false;
let inflight = false;
let extractTimer = null;

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isYoutubeWatchableHost(hostname) {
  return (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com"
  );
}

function isAuthInterstitial(url) {
  const parsed = parseUrl(url);
  if (!parsed) return true;

  const host = parsed.hostname;
  if (
    host.includes("accounts.google.") ||
    host === "accounts.youtube.com" ||
    host === "consent.youtube.com"
  ) {
    return true;
  }

  const path = parsed.pathname;
  return (
    path.startsWith("/signin") ||
    path.startsWith("/accounts") ||
    path.startsWith("/supported_browsers") ||
    path.startsWith("/channel-switcher") ||
    path.startsWith("/channel_switcher")
  );
}

function pickCredentials(cookies) {
  return Object.fromEntries(
    cookies
      .filter((cookie) => PACKED_COOKIE_NAMES.has(cookie.name))
      .map((cookie) => [cookie.name, cookie.value])
  );
}

function hasAuthCookies(creds) {
  return Boolean(creds.SAPISID && creds.SID);
}

async function extractSessionState(webContents) {
  try {
    return await webContents.executeJavaScript(
      `(function () {
        const html = document.documentElement ? document.documentElement.innerHTML : "";
        const pageReady =
          Boolean(window.ytcfg) ||
          /ytcfg\\.set\\(/.test(html) ||
          /"INNERTUBE_CONTEXT"/.test(html);
        let sessionId;
        try {
          if (window.ytcfg && typeof ytcfg.get === "function") {
            sessionId = ytcfg.get("DELEGATED_SESSION_ID") || ytcfg.get("SESSION_ID") || undefined;
          } else {
            const data = window.ytcfg && window.ytcfg.data_;
            if (data) sessionId = data.DELEGATED_SESSION_ID || data.SESSION_ID;
          }
        } catch (e) {}
        if (!sessionId) {
          const delegated = html.match(/"DELEGATED_SESSION_ID"\\s*:\\s*"([^"]+)"/);
          if (delegated) sessionId = delegated[1];
          else {
            const legacy = html.match(/"SESSION_ID"\\s*:\\s*"([^"]+)"/);
            if (legacy) sessionId = legacy[1];
          }
        }
        return { pageReady: pageReady || Boolean(sessionId), sessionId };
      })()`,
      true
    );
  } catch {
    return { pageReady: false, sessionId: undefined };
  }
}

function scheduleExtract(webContents) {
  if (extracting) return;
  clearTimeout(extractTimer);
  extractTimer = setTimeout(() => {
    tryExtract(webContents);
  }, 250);
}

async function tryExtract(webContents, attempt = 0) {
  if (extracting || inflight || webContents.isDestroyed()) return;

  const url = webContents.getURL();
  if (isAuthInterstitial(url)) return;

  const parsed = parseUrl(url);
  if (!parsed || !isYoutubeWatchableHost(parsed.hostname)) return;

  inflight = true;
  try {
    const cookies = await webContents.session.cookies.get({
      url: "https://www.youtube.com/",
    });
    const creds = pickCredentials(cookies);
    if (!hasAuthCookies(creds)) return;

    const { pageReady, sessionId } = await extractSessionState(webContents);
    if (!pageReady && attempt < 8) {
      inflight = false;
      setTimeout(() => {
        tryExtract(webContents, attempt + 1);
      }, 400);
      return;
    }

    extracting = true;
    const payload = { ...creds, DELEGATED_SESSION_ID: sessionId };
    console.log(
      includeShortLived
        ? "Login succeeded (full cookie set). Use credential token below:"
        : "Login succeeded (short-lived cookies omitted). Use credential token below:"
    );
    console.log(Buffer.from(JSON.stringify(payload)).toString("base64"));
    app.quit();
  } finally {
    inflight = false;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    show: false, // Use 'ready-to-show' event to show window
    center: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  /**
   * If you install `show: true` then it can cause issues when trying to close the window.
   * Use `show: false` and listener events `ready-to-show` to fix these issues.
   *
   * @see https://github.com/electron/electron/issues/25012
   */
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  const contents = mainWindow.webContents;
  const userAgent = stripElectronFromUserAgent(
    app.userAgentFallback || contents.session.getUserAgent()
  );
  app.userAgentFallback = userAgent;
  contents.session.setUserAgent(userAgent);
  contents.setUserAgent(userAgent);

  const onMaybeLoggedIn = () => {
    scheduleExtract(contents);
  };

  contents.on("did-finish-load", onMaybeLoggedIn);
  contents.on("did-navigate", onMaybeLoggedIn);
  contents.on("did-navigate-in-page", onMaybeLoggedIn);
  contents.on("did-redirect-navigation", onMaybeLoggedIn);
  contents.session.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !ALL_COOKIE_NAMES.has(cookie.name)) return;
    onMaybeLoggedIn();
  });

  await mainWindow.loadURL(LOGIN_URL);
}

app.on("session-created", (session) => {
  session.clearStorageData();
});

app.on("second-instance", () => {
  // Someone tried to run a second instance, we should focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app
  .whenReady()
  .then(createWindow)
  .catch((e) => console.error("Failed create window:", e));
