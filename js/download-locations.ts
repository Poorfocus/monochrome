import type { DownloadDestination } from './download-manager';

/**
 * Finding saved downloads again. A web page cannot open the system file
 * explorer, but it can open the system file dialog already showing a folder
 * it has a handle to, which shows the files in place.
 */

export function canShowInFolder(destination: DownloadDestination | undefined): boolean {
    if (!destination?.handle || typeof window.showOpenFilePicker !== 'function') return false;
    return destination.method === 'folder' || destination.method === 'local' || destination.method === 'zip';
}

/** Human-readable location of a saved file. */
export function describeSavedPath(destination: DownloadDestination | undefined, path: string | undefined): string {
    if (!destination) return path || '';
    const fileName = path?.split('/').pop() || '';
    switch (destination.method) {
        case 'folder':
        case 'local':
            return path ? `${destination.label}/${path}` : destination.label;
        case 'zip':
            return path ? `${destination.label} › ${path}` : destination.label;
        default:
            return fileName ? `Browser downloads › ${fileName}` : 'Browser downloads';
    }
}

async function folderForPath(root: FileSystemDirectoryHandle, path: string | undefined) {
    let dir = root;
    const parts = (path || '').split('/').filter(Boolean);
    parts.pop();
    try {
        for (const part of parts) dir = await dir.getDirectoryHandle(part);
    } catch {
        // Moved or deleted since: fall back to the deepest folder that still exists.
    }
    return dir;
}

/**
 * Opens the system file dialog in the folder holding `path` (or the
 * destination root). Must be called from a click.
 */
export async function showInFolder(destination: DownloadDestination, path?: string): Promise<void> {
    const handle = destination.handle;
    if (!handle) return;

    let startIn: FileSystemHandle = handle;
    if (handle.kind === 'directory') {
        // Listing subfolders needs read access, which may have lapsed since the download.
        if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
            if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
        }
        startIn = await folderForPath(handle, path);
    }

    try {
        await window.showOpenFilePicker({ startIn, multiple: false });
    } catch (error) {
        if ((error as Error)?.name !== 'AbortError') throw error;
    }
}
