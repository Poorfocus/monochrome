// Monochrome desktop app (Electron).
//
// Serves the built web app (dist/) from a small local HTTP server and opens it
// in a window. The page gets `window.monochromeDesktop` (see preload.cjs), which
// lets downloads be written straight into the configured folder: no save
// dialogs, no browser permission prompts, and "Show in folder" opens the real
// file explorer.

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
// A fixed port keeps the page's origin, and with it IndexedDB and
// localStorage (library, settings, download history), the same every launch.
const BASE_PORT = 41968;
const PORT_ATTEMPTS = 10;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.txt': 'text/plain; charset=utf-8',
};

// A stable data folder ("Monochrome") whatever the package name; the bundled
// MCP server finds automation.json here.
app.setPath('userData', path.join(app.getPath('appData'), 'Monochrome'));

// ── Settings ─────────────────────────────────────────────────────────────────

const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');

function defaultDownloadDir() {
    return path.join(app.getPath('music'), 'Monochrome');
}

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
        return {};
    }
}

function saveSettings(settings) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function getDownloadDir() {
    return loadSettings().downloadDir || defaultDownloadDir();
}

// ── Download files ───────────────────────────────────────────────────────────

// Characters Windows does not allow in file names. The web app already
// sanitizes names; this is a last line of defence so a write never fails.
// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows rejects
const INVALID_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function cleanSegment(segment) {
    let clean = segment.replace(INVALID_NAME_CHARS, '_').replace(/[. ]+$/, '');
    if (!clean || clean === '.' || clean === '..') clean = '_';
    if (RESERVED_NAMES.test(clean.split('.')[0])) clean = `_${clean}`;
    return clean;
}

/** Absolute path for a download-relative path, refusing anything outside the download folder. */
function resolveInDownloadDir(relativePath) {
    const root = path.resolve(getDownloadDir());
    const segments = String(relativePath || '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .map(cleanSegment);
    const target = path.resolve(root, ...segments);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Refusing to write outside the download folder: ${relativePath}`);
    }
    return target;
}

async function writeDownload(relativePath, data) {
    const target = resolveInDownloadDir(relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Write to a temp file and rename, so an interrupted write never leaves a
    // truncated file under the real name.
    const temp = `${target}.part`;
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
    return target;
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc() {
    ipcMain.handle('desktop:get-download-dir', () => getDownloadDir());

    ipcMain.handle('desktop:choose-download-dir', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(window, {
            title: 'Choose where to save downloads',
            defaultPath: getDownloadDir(),
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        saveSettings({ ...loadSettings(), downloadDir: result.filePaths[0] });
        return result.filePaths[0];
    });

    ipcMain.handle('desktop:reset-download-dir', () => {
        const { downloadDir: _removed, ...rest } = loadSettings();
        saveSettings(rest);
        return getDownloadDir();
    });

    ipcMain.handle('desktop:write-file', (_event, relativePath, data) => writeDownload(relativePath, data));

    ipcMain.handle('desktop:file-exists', (_event, relativePath) => fs.existsSync(resolveInDownloadDir(relativePath)));

    ipcMain.handle('desktop:show-in-folder', async (_event, relativePath) => {
        const target = resolveInDownloadDir(relativePath);
        if (relativePath && fs.existsSync(target)) {
            shell.showItemInFolder(target);
            return true;
        }
        // File moved or deleted: open the nearest folder that still exists.
        let dir = relativePath ? path.dirname(target) : target;
        const root = path.resolve(getDownloadDir());
        while (dir.startsWith(root) && !fs.existsSync(dir)) dir = path.dirname(dir);
        await fsp.mkdir(root, { recursive: true });
        const error = await shell.openPath(fs.existsSync(dir) ? dir : root);
        return !error;
    });
}

// ── Automation (bundled MCP server) ──────────────────────────────────────────
//
// mcp/server.mjs sends POST /__automation {method, params} with the token from
// automation.json. Requests are answered by the page (js/automation.js), which
// has the search and download code.

const AUTOMATION_TIMEOUT_MS = 10 * 60 * 1000;
const automationToken = nodeCrypto.randomBytes(24).toString('hex');
const pendingAutomation = new Map();
let automationReady = false;
let automationReadyWaiters = [];

function writeAutomationInfo(port) {
    const file = path.join(app.getPath('userData'), 'automation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}/__automation`, token: automationToken }), {
        mode: 0o600,
    });
}

function waitForAutomationReady(timeoutMs) {
    if (automationReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The Monochrome window is not ready yet')), timeoutMs);
        automationReadyWaiters.push(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function callPage(method, params) {
    await waitForAutomationReady(30000);
    if (!mainWindow) throw new Error('The Monochrome window is closed');
    const id = nodeCrypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingAutomation.delete(id);
            reject(new Error(`Timed out waiting for ${method}`));
        }, AUTOMATION_TIMEOUT_MS);
        pendingAutomation.set(id, { resolve, reject, timer });
        mainWindow.webContents.send('desktop:automation-request', { id, method, params });
    });
}

function registerAutomationIpc() {
    ipcMain.on('desktop:automation-ready', () => {
        automationReady = true;
        for (const wake of automationReadyWaiters) wake();
        automationReadyWaiters = [];
    });
    ipcMain.on('desktop:automation-response', (_event, { id, result, error }) => {
        const pending = pendingAutomation.get(id);
        if (!pending) return;
        pendingAutomation.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
    });
}

function tokenMatches(header) {
    const expected = Buffer.from(`Bearer ${automationToken}`);
    const actual = Buffer.from(String(header || ''));
    return actual.length === expected.length && nodeCrypto.timingSafeEqual(actual, expected);
}

function handleAutomation(req, res) {
    const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    // The token header also keeps web pages out: browsers can't send it cross-origin without a preflight we never answer.
    if (req.method !== 'POST' || !tokenMatches(req.headers.authorization)) {
        reply(401, { error: 'Unauthorized' });
        return;
    }
    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
        try {
            const { method, params } = JSON.parse(body || '{}');
            if (typeof method !== 'string') throw new Error('Missing method');
            if (method === 'ping') {
                reply(200, { result: { ok: true, downloadDir: getDownloadDir() } });
                return;
            }
            reply(200, { result: await callPage(method, params || {}) });
        } catch (error) {
            reply(200, { error: error?.message || String(error) });
        }
    });
}

// ── Local web server ─────────────────────────────────────────────────────────

function serveFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        // Hashed assets can be cached; the HTML shell must pick up app updates.
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(res);
}

function handleRequest(req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400).end();
        return;
    }

    if (pathname === '/__automation') {
        handleAutomation(req, res);
        return;
    }

    // The desktop app updates by reinstalling; a service worker would keep serving the old version.
    if (pathname === '/sw.js' || pathname.startsWith('/workbox-')) {
        res.writeHead(404).end();
        return;
    }

    const filePath = path.join(DIST_DIR, path.normalize(pathname));
    if (filePath.startsWith(DIST_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveFile(res, filePath);
        return;
    }
    // Single-page app: every other route renders index.html, like _redirects on the website.
    if (!path.extname(pathname) || pathname.endsWith('.html')) {
        serveFile(res, path.join(DIST_DIR, 'index.html'));
        return;
    }
    res.writeHead(404).end();
}

function startServer() {
    return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryListen = () => {
            const server = http.createServer(handleRequest);
            server.once('error', (error) => {
                if (error.code === 'EADDRINUSE' && ++attempt < PORT_ATTEMPTS) tryListen();
                else reject(error);
            });
            server.listen(BASE_PORT + attempt, '127.0.0.1', () => resolve(server.address().port));
        };
        tryListen();
    });
}

// ── CORS ─────────────────────────────────────────────────────────────────────

/**
 * Stream, artwork and account hosts only send CORS headers for the website's
 * own origins (or none at all), so the browser would refuse their responses
 * to the desktop app. For cross-origin requests made by the app window,
 * answer CORS on the server's behalf. Other pages never load in the window
 * (navigation is restricted below), so this only affects the app itself.
 */
function relaxCors(appOrigin) {
    const requestedHeaders = new Map();
    const fromAppWindow = (details) =>
        mainWindow != null && details.webContentsId === mainWindow.webContents.id && !details.url.startsWith(appOrigin);

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (fromAppWindow(details)) {
            const entry = Object.entries(details.requestHeaders).find(
                ([key]) => key.toLowerCase() === 'access-control-request-headers'
            );
            requestedHeaders.set(details.id, entry ? entry[1] : '');
        }
        callback({ requestHeaders: details.requestHeaders });
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (!requestedHeaders.has(details.id)) {
            callback({});
            return;
        }
        const requested = requestedHeaders.get(details.id);
        requestedHeaders.delete(details.id);

        const headers = {};
        for (const [key, value] of Object.entries(details.responseHeaders || {})) {
            if (!key.toLowerCase().startsWith('access-control-')) headers[key] = value;
        }
        headers['Access-Control-Allow-Origin'] = [appOrigin];
        headers['Access-Control-Allow-Credentials'] = ['true'];
        headers['Access-Control-Expose-Headers'] = [
            'Content-Length, Content-Type, Content-Range, Content-Disposition, ETag',
        ];

        if (details.method === 'OPTIONS') {
            headers['Access-Control-Allow-Methods'] = ['GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'];
            headers['Access-Control-Allow-Headers'] = [requested || 'Content-Type, Authorization, Range'];
            headers['Access-Control-Max-Age'] = ['600'];
            callback({ responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' });
            return;
        }
        callback({ responseHeaders: headers });
    });

    const forget = (details) => requestedHeaders.delete(details.id);
    session.defaultSession.webRequest.onCompleted(forget);
    session.defaultSession.webRequest.onErrorOccurred(forget);
}

// ── Window ───────────────────────────────────────────────────────────────────

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Keeps the page's warnings and errors in <data folder>/logs/app.log, for troubleshooting downloads. */
function logPageConsole(webContents) {
    const logFile = path.join(app.getPath('userData'), 'logs', 'app.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
        // Start over when the log gets big.
        if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.old`);
    } catch {
        // No log yet.
    }
    webContents.on('console-message', (event) => {
        const level = event.level;
        // Warnings, errors, and the per-track "[timing]" lines from downloads.
        if (level !== 'warning' && level !== 'error' && !event.message.startsWith('[timing]')) return;
        const line = `${new Date().toISOString()} [${level}] ${event.message}${event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''}\n`;
        fs.appendFile(logFile, line, () => {});
    });
}

let mainWindow = null;

function createWindow(appUrl) {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 400,
        minHeight: 500,
        title: 'Monochrome',
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        icon: path.join(DIST_DIR, 'assets', 'appicon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    // Links to other sites open in the default browser, not in the app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url) && !url.startsWith(appUrl)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(appUrl)) {
            event.preventDefault();
            if (/^https?:/i.test(url)) void shell.openExternal(url);
        }
    });

    logPageConsole(mainWindow.webContents);

    // A reload or crash re-registers the automation handler.
    mainWindow.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) automationReady = false;
    });
    void mainWindow.loadURL(appUrl);
    mainWindow.on('closed', () => {
        mainWindow = null;
        automationReady = false;
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    void app.whenReady().then(async () => {
        if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
            dialog.showErrorBox(
                'Monochrome',
                `The web app has not been built (${DIST_DIR} is missing). Run "npm run build" first.`
            );
            app.quit();
            return;
        }
        registerIpc();
        registerAutomationIpc();
        const port = await startServer();
        writeAutomationInfo(port);
        const appUrl = `http://127.0.0.1:${port}/`;
        relaxCors(appUrl.slice(0, -1));
        createWindow(appUrl);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow(appUrl);
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
