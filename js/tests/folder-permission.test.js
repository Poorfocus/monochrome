import { afterEach, describe, expect, test, vi } from 'vitest';
import { ensureFolderWritePermission, setFolderAccessPrompt } from '../folder-permission.ts';
import { FolderPickerWriter } from '../bulk-download-writer.ts';

function fakeDirectory({ state = 'granted', requestResult = 'granted', failFirstWrite = false } = {}) {
    const written = new Map();
    let writesRefused = failFirstWrite ? 1 : 0;
    const handle = {
        state,
        queryPermission: vi.fn(async () => handle.state),
        requestPermission: vi.fn(async () => {
            if (requestResult === 'throw') throw new DOMException('User activation is required', 'SecurityError');
            handle.state = requestResult;
            return requestResult;
        }),
        getDirectoryHandle: vi.fn(async () => handle),
        getFileHandle: vi.fn(async (name) => ({
            createWritable: async () => {
                if (handle.state !== 'granted' || writesRefused > 0) {
                    writesRefused--;
                    handle.state = 'prompt';
                    throw new DOMException('The request is not allowed', 'NotAllowedError');
                }
                return {
                    write: async (blob) => written.set(name, blob),
                    close: async () => {},
                    abort: async () => {},
                };
            },
        })),
    };
    return { handle, written };
}

async function* entries(...names) {
    for (const name of names) yield { name, lastModified: new Date(), input: new Blob(['x']) };
}

describe('folder-permission', () => {
    afterEach(() => setFolderAccessPrompt(null));

    test('granted access needs no prompt', async () => {
        const { handle } = fakeDirectory();
        expect(await ensureFolderWritePermission(handle)).toBe(true);
        expect(handle.requestPermission).not.toHaveBeenCalled();
    });

    test('lapsed access without user activation goes through the in-app prompt', async () => {
        const { handle } = fakeDirectory({ state: 'prompt', requestResult: 'throw' });
        const prompt = vi.fn(async (grant) => {
            handle.requestPermission.mockResolvedValueOnce('granted');
            return grant();
        });
        setFolderAccessPrompt(prompt);

        expect(await ensureFolderWritePermission(handle)).toBe(true);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test('concurrent waiters share one prompt', async () => {
        const { handle } = fakeDirectory({ state: 'prompt', requestResult: 'throw' });
        const prompt = vi.fn(async () => true);
        setFolderAccessPrompt(prompt);

        const results = await Promise.all([ensureFolderWritePermission(handle), ensureFolderWritePermission(handle)]);
        expect(results).toEqual([true, true]);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    test('writer recovers when createWritable is refused mid-download', async () => {
        const { handle, written } = fakeDirectory({ failFirstWrite: true });
        // The retry's requestPermission succeeds, as it would after the user clicks "Allow".
        await FolderPickerWriter.fromHandle(handle).write(entries('Album/01.flac', 'Album/02.flac'));
        expect([...written.keys()]).toEqual(['01.flac', '02.flac']);
    });

    test('writer keeps going with browser downloads when access is declined', async () => {
        const { handle, written } = fakeDirectory({ state: 'prompt', requestResult: 'throw' });
        setFolderAccessPrompt(async () => false);
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        await FolderPickerWriter.fromHandle(handle).write(entries('Album/01.flac'));
        expect(written.size).toBe(0);
        expect(click).toHaveBeenCalledTimes(1);
        click.mockRestore();
    });
});
