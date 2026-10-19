// Exposes the desktop bridge to the web app as `window.monochromeDesktop`.
// Paths are relative to the download folder chosen in Settings; the main
// process refuses anything outside it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monochromeDesktop', {
    isDesktop: true,
    platform: process.platform,
    getDownloadDir: () => ipcRenderer.invoke('desktop:get-download-dir'),
    chooseDownloadDir: () => ipcRenderer.invoke('desktop:choose-download-dir'),
    resetDownloadDir: () => ipcRenderer.invoke('desktop:reset-download-dir'),
    /** Writes text or bytes to `relativePath`; resolves to the absolute path. */
    writeFile: (relativePath, data) => ipcRenderer.invoke('desktop:write-file', relativePath, data),
    fileExists: (relativePath) => ipcRenderer.invoke('desktop:file-exists', relativePath),
    /** Opens the file explorer with the file selected (or the folder, for an empty path). */
    showInFolder: (relativePath = '') => ipcRenderer.invoke('desktop:show-in-folder', relativePath),
    /**
     * Lets the app answer automation requests (the bundled MCP server).
     * `handler(method, params)` returns a promise of the result.
     */
    onAutomationRequest: (handler) => {
        ipcRenderer.removeAllListeners('desktop:automation-request');
        ipcRenderer.on('desktop:automation-request', async (_event, { id, method, params }) => {
            try {
                const result = await handler(method, params);
                ipcRenderer.send('desktop:automation-response', { id, result });
            } catch (error) {
                ipcRenderer.send('desktop:automation-response', { id, error: error?.message || String(error) });
            }
        });
        ipcRenderer.send('desktop:automation-ready');
    },
});
