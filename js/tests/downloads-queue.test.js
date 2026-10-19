import { beforeAll, describe, expect, test, vi } from 'vitest';

// Keep the real download pipeline but stub out network-backed singletons.
vi.mock('../music-api.js', () => ({ MusicAPI: { instance: null } }));
vi.mock('../lyrics.js', () => ({ LyricsManager: { instance: null } }));

const { downloadAlbum } = await import('../downloads.js');
const { modernSettings, BulkDownloadMethod } = await import('../ModernSettings.ts');
const { getDownloadJobs } = await import('../download-manager.ts');

const FLAC = new Uint8Array(4096);
FLAC.set([0x66, 0x4c, 0x61, 0x43]); // "fLaC"

async function makeCoverUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 16, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
    return URL.createObjectURL(blob);
}

function fakeApi(coverUrl) {
    const state = { running: 0, maxRunning: 0, order: [] };
    return {
        state,
        getCoverUrl: () => coverUrl,
        getTrackMetadata: async (id) => ({ id }),
        async downloadTrack(id) {
            state.running++;
            state.maxRunning = Math.max(state.maxRunning, state.running);
            state.order.push(id);
            await new Promise((r) => setTimeout(r, 40));
            state.running--;
            return new Blob([FLAC], { type: 'audio/flac' });
        },
    };
}

function album(id, title, artist, count) {
    const meta = { id, title, artist: { name: artist }, cover: `cover-${id}` };
    const tracks = Array.from({ length: count }, (_, i) => ({
        id: `${id}-${i + 1}`,
        title: `Song ${i + 1}`,
        trackNumber: i + 1,
        volumeNumber: 1,
        artist: { name: artist },
        artists: [{ name: artist }],
        album: { id, title, artist: { name: artist }, cover: meta.cover },
    }));
    return { meta, tracks };
}

async function listFiles(dir, prefix = '') {
    const out = [];
    for await (const [name, handle] of dir.entries()) {
        const path = `${prefix}${name}`;
        if (handle.kind === 'directory') out.push(...(await listFiles(handle, `${path}/`)));
        else out.push(path);
    }
    return out.sort();
}

describe('queued album downloads', () => {
    let root;

    beforeAll(async () => {
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry('queue-test', { recursive: true }).catch(() => {});
        root = await opfs.getDirectoryHandle('queue-test', { create: true });

        await modernSettings.waitPending();
        modernSettings.bulkDownloadMethod = BulkDownloadMethod.Folder;
        modernSettings.rememberBulkDownloadFolder = true;
        modernSettings.bulkDownloadFolder = root;
        modernSettings.folderTemplate = '{albumTitle} - {albumArtist}';
        modernSettings.filenameTemplate = '{trackNumber} - {artist} - {title}';
        await modernSettings.waitPending();
    });

    test('back-to-back albums run one at a time and keep the folder layout', async () => {
        const api = fakeApi(await makeCoverUrl());
        const first = album('a1', 'First Album', 'Artist One', 3);
        const second = album('a2', 'Second Album', 'Artist Two', 2);

        // Both calls return once queued, like clicking two album download buttons.
        await downloadAlbum(first.meta, first.tracks, api, 'LOSSLESS');
        await downloadAlbum(second.meta, second.tracks, api, 'LOSSLESS');

        await vi.waitFor(
            () => {
                const jobs = getDownloadJobs().filter((j) => j.kind === 'album');
                expect(jobs.length).toBeGreaterThanOrEqual(2);
                expect(jobs.slice(0, 2).every((j) => j.status === 'done')).toBe(true);
            },
            { timeout: 20000, interval: 100 }
        );

        expect(api.state.maxRunning).toBe(1);
        expect(api.state.order).toEqual(['a1-1', 'a1-2', 'a1-3', 'a2-1', 'a2-2']);

        const files = await listFiles(root);
        expect(files).toEqual(
            expect.arrayContaining([
                'First Album - Artist One/cover.jpg',
                'First Album - Artist One/01 - Artist One - Song 1.flac',
                'First Album - Artist One/02 - Artist One - Song 2.flac',
                'First Album - Artist One/03 - Artist One - Song 3.flac',
                'Second Album - Artist Two/cover.jpg',
                'Second Album - Artist Two/01 - Artist Two - Song 1.flac',
                'Second Album - Artist Two/02 - Artist Two - Song 2.flac',
            ])
        );

        const [secondJob, firstJob] = getDownloadJobs().filter((j) => j.kind === 'album');
        expect(firstJob.items.map((i) => i.path)).toEqual([
            'First Album - Artist One/01 - Artist One - Song 1.flac',
            'First Album - Artist One/02 - Artist One - Song 2.flac',
            'First Album - Artist One/03 - Artist One - Song 3.flac',
        ]);
        expect(secondJob.destination).toMatchObject({ method: 'folder', label: 'queue-test' });
    }, 30000);
});
