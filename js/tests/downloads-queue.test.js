import { beforeAll, describe, expect, test, vi } from 'vitest';

// Keep the real download pipeline but stub out network-backed singletons.
vi.mock('../music-api.js', () => ({ MusicAPI: { instance: null } }));
vi.mock('../lyrics.js', () => ({ LyricsManager: { instance: null } }));

const { downloadAlbum, setRetryTiming } = await import('../downloads.js');
const { modernSettings, BulkDownloadMethod } = await import('../ModernSettings.ts');
const { getDownloadJobs, cancelDownloadJob, removeDownloadJob } = await import('../download-manager.ts');

const FLAC = new Uint8Array(4096);
FLAC.set([0x66, 0x4c, 0x61, 0x43]); // "fLaC"

async function makeCoverUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 16, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
    return URL.createObjectURL(blob);
}

function fakeApi(coverUrl, { failures = {}, trackMs = 40 } = {}) {
    // failures: { trackId: number of times downloadTrack should fail before it works }
    const state = { running: 0, maxRunning: 0, order: [], attempts: {}, runningAtStart: {} };
    return {
        state,
        getCoverUrl: () => coverUrl,
        getTrackMetadata: async (id) => ({ id }),
        async downloadTrack(id) {
            state.attempts[id] = (state.attempts[id] || 0) + 1;
            if (state.attempts[id] <= (failures[id] || 0)) throw new Error('Download failed: Fetch failed: 502');
            state.running++;
            state.maxRunning = Math.max(state.maxRunning, state.running);
            state.runningAtStart[id] = state.running;
            state.order.push(id);
            await new Promise((r) => setTimeout(r, trackMs));
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
        modernSettings.downloadConcurrency = 1;
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

    describe('retrying failed tracks', () => {
        const jobFor = (title) => getDownloadJobs().find((j) => j.title === title);
        const filesIn = async (folder) => {
            const dir = await root.getDirectoryHandle(folder);
            return (await listFiles(dir)).filter((f) => f.endsWith('.flac'));
        };

        test('a track that fails is retried until it downloads', async () => {
            setRetryTiming({ inlineBaseMs: 50, inlineRounds: 4, autoBaseMs: 100, autoMaxMs: 400 });
            const api = fakeApi(await makeCoverUrl(), { failures: { 'r1-2': 3 } });
            const rec = album('r1', 'Flaky Album', 'Flaky Artist', 3);
            await downloadAlbum(rec.meta, rec.tracks, api, 'LOSSLESS');

            await vi.waitFor(() => expect(jobFor('Flaky Album')?.status).toBe('done'), {
                timeout: 20000,
                interval: 50,
            });
            expect(api.state.attempts['r1-2']).toBe(4);
            expect(await filesIn('Flaky Album - Flaky Artist')).toHaveLength(3);
            // Playlist files list every track, including the one that needed retries.
            const dir = await root.getDirectoryHandle('Flaky Album - Flaky Artist');
            const files = await listFiles(dir);
            expect(files.some((f) => f.endsWith('.m3u'))).toBe(true);
        }, 30000);

        test('a track that outlasts the album is retried by a later run until it downloads', async () => {
            setRetryTiming({ inlineBaseMs: 20, inlineRounds: 2, autoBaseMs: 100, autoMaxMs: 300 });
            // 1 first attempt + 2 inline rounds fail, then the re-queued run's first attempt fails, then it works.
            const api = fakeApi(await makeCoverUrl(), { failures: { 'r2-1': 4 } });
            const rec = album('r2', 'Stubborn Album', 'Stubborn Artist', 2);
            await downloadAlbum(rec.meta, rec.tracks, api, 'LOSSLESS');

            await vi.waitFor(() => expect(jobFor('Stubborn Album')?.status).toBe('partial'), {
                timeout: 20000,
                interval: 20,
            });
            expect(jobFor('Stubborn Album').autoRetryAt).toBeGreaterThan(Date.now() - 1000);

            await vi.waitFor(
                () => {
                    const jobs = getDownloadJobs().filter((j) => j.title === 'Stubborn Album');
                    expect(jobs).toHaveLength(1);
                    expect(jobs[0].status).toBe('done');
                },
                { timeout: 30000, interval: 50 }
            );
            expect(await filesIn('Stubborn Album - Stubborn Artist')).toHaveLength(2);
            // The track that already downloaded was not fetched again.
            expect(api.state.attempts['r2-2']).toBe(1);
        }, 45000);

        test('stopping the retry keeps the job as it is', async () => {
            setRetryTiming({ inlineBaseMs: 20, inlineRounds: 1, autoBaseMs: 400, autoMaxMs: 400 });
            const api = fakeApi(await makeCoverUrl(), { failures: { 'r3-1': 99 } });
            const rec = album('r3', 'Broken Album', 'Broken Artist', 1);
            await downloadAlbum(rec.meta, rec.tracks, api, 'LOSSLESS');

            await vi.waitFor(() => expect(jobFor('Broken Album')?.autoRetryAt).toBeTruthy(), {
                timeout: 20000,
                interval: 20,
            });
            const job = jobFor('Broken Album');
            cancelDownloadJob(job.id);
            expect(jobFor('Broken Album').autoRetryAt).toBeUndefined();

            const attemptsBefore = api.state.attempts['r3-1'];
            await new Promise((resolve) => setTimeout(resolve, 1200));
            expect(api.state.attempts['r3-1']).toBe(attemptsBefore);
            expect(jobFor('Broken Album').status).toBe('failed');
            removeDownloadJob(job.id);
        }, 30000);
    });

    describe('downloading several tracks at once', () => {
        const jobFor = (title) => getDownloadJobs().find((j) => j.title === title);

        test('tracks overlap but the saved files and playlist order match a sequential run', async () => {
            modernSettings.downloadConcurrency = 3;
            await modernSettings.waitPending();
            const api = fakeApi(await makeCoverUrl(), { trackMs: 150 });
            const rec = album('p1', 'Parallel Album', 'Parallel Artist', 6);
            await downloadAlbum(rec.meta, rec.tracks, api, 'LOSSLESS');

            await vi.waitFor(() => expect(jobFor('Parallel Album')?.status).toBe('done'), {
                timeout: 20000,
                interval: 50,
            });
            expect(api.state.maxRunning).toBe(3);

            const dir = await root.getDirectoryHandle('Parallel Album - Parallel Artist');
            const files = await listFiles(dir);
            expect(files.filter((f) => f.endsWith('.flac'))).toEqual(
                [1, 2, 3, 4, 5, 6].map((n) => `0${n} - Parallel Artist - Song ${n}.flac`)
            );
            const m3u = await (await (await dir.getFileHandle(files.find((f) => f.endsWith('.m3u')))).getFile()).text();
            const listed = m3u.split('\n').filter((l) => l.endsWith('.flac'));
            expect(listed).toEqual([1, 2, 3, 4, 5, 6].map((n) => `0${n} - Parallel Artist - Song ${n}.flac`));
            expect(jobFor('Parallel Album').items.map((i) => i.path)).toEqual(
                [1, 2, 3, 4, 5, 6].map(
                    (n) => `Parallel Album - Parallel Artist/0${n} - Parallel Artist - Song ${n}.flac`
                )
            );
        }, 30000);

        test('after a failure the rest of the album downloads one at a time and still completes', async () => {
            setRetryTiming({ inlineBaseMs: 20, inlineRounds: 3, autoBaseMs: 100, autoMaxMs: 300 });
            modernSettings.downloadConcurrency = 3;
            await modernSettings.waitPending();
            const api = fakeApi(await makeCoverUrl(), { failures: { 'p2-2': 1 }, trackMs: 100 });
            const rec = album('p2', 'Careful Album', 'Careful Artist', 6);
            await downloadAlbum(rec.meta, rec.tracks, api, 'LOSSLESS');

            await vi.waitFor(() => expect(jobFor('Careful Album')?.status).toBe('done'), {
                timeout: 20000,
                interval: 50,
            });
            // Tracks 5 and 6 started after the failure was seen, so ran alone.
            expect(api.state.runningAtStart['p2-5']).toBe(1);
            expect(api.state.runningAtStart['p2-6']).toBe(1);
            const dir = await root.getDirectoryHandle('Careful Album - Careful Artist');
            expect((await listFiles(dir)).filter((f) => f.endsWith('.flac'))).toHaveLength(6);
        }, 30000);
    });
});
