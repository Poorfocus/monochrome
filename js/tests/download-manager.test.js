import { describe, expect, test, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: { getSetting: vi.fn(async () => undefined), saveSetting: vi.fn(async () => {}) } }));
vi.mock('../ModernSettings.ts', () => ({
    modernSettings: { waitPending: async () => {}, keepDownloadHistory: true },
}));

const manager = await import('../download-manager.ts');

function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
}

const waitFor = (check) => vi.waitFor(check, { timeout: 5000, interval: 20 });
const statusOf = (id) => manager.getDownloadJobs().find((j) => j.id === id)?.status;

describe('download-manager queue', () => {
    test('runs one job at a time, oldest first', async () => {
        const order = [];
        const first = deferred();
        const a = manager.startDownloadJob({ kind: 'album', title: 'A', tracks: [{ id: 1, title: 'a1' }] });
        const b = manager.startDownloadJob({ kind: 'album', title: 'B', tracks: [{ id: 2, title: 'b1' }] });

        manager.enqueueDownloadJob(a, async () => {
            order.push('a:start');
            await first.promise;
            manager.updateDownloadItem(a, 0, { status: 'done', progress: 1 });
            order.push('a:end');
        });
        manager.enqueueDownloadJob(b, async () => {
            order.push('b:start');
            manager.updateDownloadItem(b, 0, { status: 'done', progress: 1 });
        });

        await waitFor(() => expect(order).toEqual(['a:start']));
        expect(statusOf(a)).toBe('active');
        expect(statusOf(b)).toBe('queued');
        expect(manager.queuePosition(b)).toBe(1);

        first.resolve();
        await waitFor(() => expect(statusOf(b)).toBe('done'));
        expect(order).toEqual(['a:start', 'a:end', 'b:start']);
        expect(statusOf(a)).toBe('done');
    });

    test('cancelling a queued job skips it without running it', async () => {
        const gate = deferred();
        const onCancel = vi.fn();
        const running = manager.startDownloadJob({ kind: 'track', title: 'running', tracks: [{ id: 3 }] });
        const waiting = manager.startDownloadJob({ kind: 'track', title: 'waiting', tracks: [{ id: 4 }], onCancel });
        const neverRun = vi.fn();

        manager.enqueueDownloadJob(running, () => gate.promise);
        manager.enqueueDownloadJob(waiting, neverRun);
        await waitFor(() => expect(statusOf(running)).toBe('active'));

        manager.cancelDownloadJob(waiting);
        expect(statusOf(waiting)).toBe('cancelled');
        expect(onCancel).toHaveBeenCalled();

        gate.resolve();
        await waitFor(() => expect(statusOf(running)).not.toBe('active'));
        await new Promise((r) => setTimeout(r, 1200));
        expect(neverRun).not.toHaveBeenCalled();
    });

    test('a job that throws is marked failed and the queue moves on', async () => {
        const bad = manager.startDownloadJob({ kind: 'album', title: 'bad', tracks: [{ id: 5 }, { id: 6 }] });
        const good = manager.startDownloadJob({ kind: 'track', title: 'good', tracks: [{ id: 7 }] });
        manager.enqueueDownloadJob(bad, async () => {
            manager.updateDownloadItem(bad, 0, { status: 'done', progress: 1 });
            throw new Error('network down');
        });
        manager.enqueueDownloadJob(good, async () => manager.updateDownloadItem(good, 0, { status: 'done' }));

        await waitFor(() => expect(statusOf(good)).toBe('done'));
        const job = manager.getDownloadJobs().find((j) => j.id === bad);
        expect(job.status).toBe('partial');
        expect(job.items[1].status).toBe('failed');
    });

    test('snapshots keep only what the page needs', () => {
        const snapshot = manager.snapshotTrack({
            id: 9,
            title: 'Song',
            artists: [{ name: 'A' }, { name: 'B' }],
            album: { title: 'Record', cover: 'ab-cd' },
            extra: { big: true },
        });
        expect(snapshot).toEqual({ id: 9, title: 'Song', artist: 'A, B', albumTitle: 'Record', cover: 'ab-cd' });
    });

    test('flags tracks saved in 16-bit when hi-res was asked for', () => {
        const hiRes = { quality: 'HI_RES_LOSSLESS' };
        const done16 = { status: 'done', quality: 'LOSSLESS' };
        expect(manager.fellBackTo16Bit(hiRes, done16)).toBe(true);
        expect(manager.fellBackTo16Bit(hiRes, { status: 'done', quality: 'HI_RES_LOSSLESS' })).toBe(false);
        expect(manager.fellBackTo16Bit(hiRes, { status: 'failed', quality: 'LOSSLESS' })).toBe(false);
        // Asking for 16-bit and getting 16-bit is not a fallback.
        expect(manager.fellBackTo16Bit({ quality: 'LOSSLESS' }, done16)).toBe(false);
        expect(manager.fellBackTo16Bit({ quality: 'DOLBY_ATMOS_EAC3_HIGH' }, done16)).toBe(true);
    });
});
