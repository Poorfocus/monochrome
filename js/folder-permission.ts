/**
 * Write access to a folder chosen with showDirectoryPicker does not last.
 * Chromium revokes it a few seconds after every tab of the site goes to the
 * background (unless the user picked "Allow on every visit"), and getting it
 * back needs a user gesture. A download that started in the foreground can
 * therefore finish after access is gone, and createWritable then fails with
 * "The request is not allowed by the user agent or the platform in the
 * current context".
 */

/**
 * Asks the user to restore access. `grant` must be called from a click
 * handler so the browser accepts the request; resolves to whether access
 * was restored.
 */
export type FolderAccessPrompt = (grant: () => Promise<boolean>) => Promise<boolean>;

let showPrompt: FolderAccessPrompt | null = null;
const pendingPrompts = new WeakMap<FileSystemHandle, Promise<boolean>>();

export function setFolderAccessPrompt(prompt: FolderAccessPrompt | null): void {
    showPrompt = prompt;
}

export function isFolderPermissionError(error: unknown): boolean {
    const name = (error as { name?: string } | null)?.name;
    return name === 'NotAllowedError' || name === 'SecurityError';
}

async function requestWrite(handle: FileSystemHandle): Promise<boolean> {
    try {
        return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
        // SecurityError: no user activation left to show the browser prompt.
        return false;
    }
}

/**
 * Resolves to true once `handle` can be written to. When access has lapsed it
 * first tries the browser prompt directly (works right after a click), then
 * falls back to the in-app prompt. Writers waiting on the same handle share
 * one prompt.
 */
export async function ensureFolderWritePermission(handle: FileSystemHandle): Promise<boolean> {
    if (typeof handle?.queryPermission !== 'function') return true;

    let state: PermissionState;
    try {
        state = await handle.queryPermission({ mode: 'readwrite' });
    } catch {
        state = 'prompt';
    }
    if (state === 'granted') return true;
    if (state === 'denied') return false;

    if (await requestWrite(handle)) return true;
    if (!showPrompt) return false;

    let pending = pendingPrompts.get(handle);
    if (!pending) {
        pending = showPrompt(() => requestWrite(handle))
            .catch(() => false)
            .finally(() => pendingPrompts.delete(handle));
        pendingPrompts.set(handle, pending);
    }
    return pending;
}
