/**
 * The desktop app's bridge (desktop/preload.cjs), or null in a browser.
 * Paths are relative to the download folder chosen in the desktop app.
 */
export interface MonochromeDesktop {
    isDesktop: true;
    platform: string;
    getDownloadDir(): Promise<string>;
    chooseDownloadDir(): Promise<string | null>;
    resetDownloadDir(): Promise<string>;
    writeFile(relativePath: string, data: ArrayBuffer | Uint8Array | string): Promise<string>;
    fileExists(relativePath: string): Promise<boolean>;
    showInFolder(relativePath?: string): Promise<boolean>;
    onAutomationRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void;
}

export const desktop: MonochromeDesktop | null =
    (typeof window !== 'undefined' &&
        (window as unknown as { monochromeDesktop?: MonochromeDesktop }).monochromeDesktop) ||
    null;

export const isDesktopApp = desktop !== null;
