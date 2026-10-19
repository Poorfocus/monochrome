import { db } from './db';
import { modernSettings } from './ModernSettings';

/**
 * Shared record of every download the app runs: one job per user action
 * (a track, an album, a playlist...) with one item per track. downloads.js
 * reports progress here and the Downloads page renders it. Finished jobs are
 * kept in IndexedDB so the page can still find the files later.
 *
 * Jobs run one at a time, oldest first. Running several at once made them
 * compete for the same stream APIs and fail together.
 */

export type DownloadJobKind = 'track' | 'album' | 'playlist' | 'queue' | 'liked' | 'discography';
export type DownloadItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';
export type DownloadJobStatus = 'queued' | 'active' | 'done' | 'partial' | 'failed' | 'cancelled';
export type DownloadDestinationMethod = 'folder' | 'local' | 'zip' | 'browser' | 'desktop';

export interface DownloadDestination {
    method: DownloadDestinationMethod;
    /** Folder or file name shown to the user. */
    label: string;
    /** Root folder for folder/local, the archive for streamed ZIPs. */
    handle?: FileSystemDirectoryHandle | FileSystemFileHandle | null;
}

/** Loose shape of the track objects the app passes around. */
export interface TrackLike {
    id?: string | number;
    title?: string;
    name?: string;
    artists?: { name?: string }[];
    artist?: { name?: string };
    album?: { title?: string; cover?: string | null };
    cover?: string | null;
    type?: string;
    provider?: string;
}

/** Just enough of a track to show it and download it again. */
export interface DownloadTrackSnapshot {
    id: string | number;
    title: string;
    artist: string;
    albumTitle?: string;
    cover?: string | null;
    type?: string;
    provider?: string;
}

export interface DownloadItem {
    track: DownloadTrackSnapshot;
    /** Release the track belongs to, used to group discography items. */
    group?: string;
    status: DownloadItemStatus;
    /** 0..1 while downloading. */
    progress: number;
    statusText?: string;
    bytes?: number;
    /** Path of the saved file relative to the destination root. */
    path?: string;
    error?: string;
}

/** What a job downloaded, so it can be retried after a reload. */
export interface DownloadJobSource {
    kind: 'track' | 'album' | 'tracks' | 'discography';
    id?: string | number;
    /** Catalog the ID belongs to ('tracks' for the monochrome catalog); needed to look it up after a reload. */
    provider?: string;
    artist?: { id?: string | number; name: string };
    releases?: { id: string | number; title?: string; cover?: string | null }[];
}

export interface DownloadJob {
    id: string;
    kind: DownloadJobKind;
    title: string;
    subtitle?: string;
    cover?: string | null;
    quality?: string;
    /** Folder name the job writes into; reused when retrying. */
    folderName?: string;
    status: DownloadJobStatus;
    createdAt: number;
    finishedAt?: number;
    /** How many automatic retries came before this run (0 for a fresh download). */
    attempt?: number;
    /** When the app will retry the tracks this job is missing; cleared to stop it. */
    autoRetryAt?: number;
    destination?: DownloadDestination;
    source?: DownloadJobSource;
    items: DownloadItem[];
    error?: string;
}

const HISTORY_KEY = 'download_history';
const HISTORY_LIMIT = 200;

type Listener = (jobs: readonly DownloadJob[]) => void;

let jobs: DownloadJob[] = [];
const listeners = new Set<Listener>();
const cancelHandlers = new Map<string, () => void>();
const runners = new Map<string, () => Promise<void>>();
let runningJobId: string | null = null;
/** Pause between jobs so back-to-back albums don't trip rate limits. */
const JOB_GAP_MS = 1000;
let notifyScheduled = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let historyEnabled = true;

const loaded = (async () => {
    try {
        await modernSettings.waitPending();
        historyEnabled = modernSettings.keepDownloadHistory !== false;

        const stored = (await db.getSetting(HISTORY_KEY)) as DownloadJob[] | undefined;
        if (!Array.isArray(stored)) return;
        // A job still queued or running was cut off when the page closed.
        const restored = stored.map((job) =>
            job.status === 'active' || job.status === 'queued'
                ? {
                      ...job,
                      status: 'failed' as const,
                      error: 'Interrupted when the page was closed',
                      items: job.items.map((item) =>
                          item.status === 'queued' || item.status === 'downloading'
                              ? { ...item, status: 'cancelled' as const, progress: 0 }
                              : item
                      ),
                  }
                : job
        );
        jobs = [...jobs, ...restored.filter((job) => !jobs.some((j) => j.id === job.id))];
        notify();
    } catch (error) {
        console.warn('Could not load download history:', error);
    }
})();

/** Resolves once saved history has been read. */
export function whenDownloadHistoryLoaded(): Promise<void> {
    return loaded;
}

function notify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    // Progress callbacks fire many times a second; render at most once a frame.
    const flush = () => {
        notifyScheduled = false;
        const snapshot = jobs.slice();
        for (const listener of listeners) listener(snapshot);
    };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(flush);
    else setTimeout(flush, 100);
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        const toStore = historyEnabled ? jobs.slice(0, HISTORY_LIMIT) : jobs.filter((j) => isPending(j));
        db.saveSetting(HISTORY_KEY, toStore).catch((error: unknown) => {
            console.warn('Could not save download history:', error);
        });
    }, 1000);
}

function changed(persist = false) {
    notify();
    if (persist) scheduleSave();
}

function findJob(jobId: string) {
    return jobs.find((job) => job.id === jobId);
}

export function subscribeDownloads(listener: Listener): () => void {
    listeners.add(listener);
    listener(jobs.slice());
    return () => listeners.delete(listener);
}

export function getDownloadJobs(): readonly DownloadJob[] {
    return jobs;
}

export function snapshotTrack(track: TrackLike): DownloadTrackSnapshot {
    const artists = Array.isArray(track?.artists) ? track.artists : [];
    return {
        id: track?.id,
        title: track?.title || track?.name || 'Unknown track',
        artist:
            artists
                .map((a) => a?.name)
                .filter(Boolean)
                .join(', ') ||
            track?.artist?.name ||
            '',
        albumTitle: track?.album?.title,
        cover: track?.album?.cover || track?.cover || null,
        type: track?.type,
        provider: track?.provider,
    };
}

export function startDownloadJob(init: {
    kind: DownloadJobKind;
    title: string;
    subtitle?: string;
    cover?: string | null;
    quality?: string;
    folderName?: string;
    tracks?: TrackLike[];
    source?: DownloadJobSource;
    attempt?: number;
    onCancel?: () => void;
}): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    jobs = [
        {
            id,
            kind: init.kind,
            title: init.title,
            subtitle: init.subtitle,
            cover: init.cover ?? null,
            quality: init.quality,
            folderName: init.folderName,
            source: init.source,
            attempt: init.attempt,
            status: 'queued',
            createdAt: Date.now(),
            items: (init.tracks || []).map((track) => newItem(track)),
        },
        ...jobs,
    ];
    if (init.onCancel) cancelHandlers.set(id, init.onCancel);
    changed(true);
    return id;
}

function newItem(track: TrackLike, group?: string): DownloadItem {
    return { track: snapshotTrack(track), group, status: 'queued', progress: 0 };
}

/** Adds items to a job whose tracks are only known as it runs (discographies). */
export function addDownloadItems(jobId: string, tracks: TrackLike[], group?: string): number {
    const job = findJob(jobId);
    if (!job) return -1;
    const start = job.items.length;
    job.items = [...job.items, ...tracks.map((track) => newItem(track, group))];
    changed(true);
    return start;
}

export function setDownloadDestination(jobId: string, destination: DownloadDestination) {
    const job = findJob(jobId);
    if (!job) return;
    job.destination = destination;
    changed(true);
}

export function updateDownloadItem(jobId: string, index: number, patch: Partial<DownloadItem>) {
    const job = findJob(jobId);
    const item = job?.items[index];
    if (!item) return;
    const settled = patch.status && patch.status !== item.status && patch.status !== 'downloading';
    job.items[index] = { ...item, ...patch };
    changed(Boolean(settled));
}

export function finishDownloadJob(jobId: string, outcome: { cancelled?: boolean; error?: string } = {}) {
    const job = findJob(jobId);
    if (!job) return;
    cancelHandlers.delete(jobId);

    job.items = job.items.map((item) =>
        item.status === 'queued' || item.status === 'downloading'
            ? { ...item, status: outcome.error && !outcome.cancelled ? 'failed' : 'cancelled', progress: 0 }
            : item
    );
    const done = job.items.filter((item) => item.status === 'done').length;
    const failed = job.items.filter((item) => item.status === 'failed').length;

    if (outcome.cancelled) job.status = 'cancelled';
    else if (outcome.error && done === 0) job.status = 'failed';
    else if (failed > 0 || outcome.error) job.status = done > 0 ? 'partial' : 'failed';
    else job.status = 'done';

    job.error = outcome.error;
    job.finishedAt = Date.now();
    changed(true);
}

/**
 * Puts a job created with {@link startDownloadJob} in line. `run` starts when
 * every earlier job has finished; the job is finished for it if `run` throws
 * or returns without calling {@link finishDownloadJob}.
 */
export function enqueueDownloadJob(jobId: string, run: () => Promise<void>) {
    runners.set(jobId, run);
    void pumpQueue();
}

async function pumpQueue() {
    if (runningJobId) return;
    // jobs is newest first, so the oldest queued job is the last one.
    const next = [...jobs].reverse().find((job) => job.status === 'queued' && runners.has(job.id));
    if (!next) return;

    const run = runners.get(next.id);
    runners.delete(next.id);
    runningJobId = next.id;
    next.status = 'active';
    changed(true);

    try {
        await run();
    } catch (error) {
        console.error('Download job failed:', error);
        if (findJob(next.id)?.status === 'active') {
            finishDownloadJob(next.id, { error: (error as Error)?.message || String(error) });
        }
    } finally {
        if (findJob(next.id)?.status === 'active') finishDownloadJob(next.id);
        runningJobId = null;
        setTimeout(() => void pumpQueue(), JOB_GAP_MS);
    }
}

/** Position in line (1 = next up), or 0 when the job is not waiting. */
export function queuePosition(jobId: string, list: readonly DownloadJob[] = jobs) {
    const waiting = list.filter((job) => job.status === 'queued').reverse();
    return waiting.findIndex((job) => job.id === jobId) + 1;
}

/** Sets or clears (undefined) the time the app will retry a finished job's missing tracks. */
export function setJobAutoRetry(jobId: string, at: number | undefined) {
    const job = findJob(jobId);
    if (!job) return;
    job.autoRetryAt = at;
    changed(true);
}

export function cancelDownloadJob(jobId: string) {
    const job = findJob(jobId);
    if (!job) return;
    if (!isPending(job)) {
        // Already finished: this stops any automatic retry.
        setJobAutoRetry(jobId, undefined);
        return;
    }
    const cancel = cancelHandlers.get(jobId);
    if (job.status === 'queued') {
        runners.delete(jobId);
        cancel?.();
        finishDownloadJob(jobId, { cancelled: true });
        return;
    }
    if (cancel) cancel();
    else finishDownloadJob(jobId, { cancelled: true });
}

/** Cancels the running job and everything waiting behind it. */
export function cancelAllDownloads() {
    for (const job of jobs.filter((j) => isPending(j))) cancelDownloadJob(job.id);
}

function isPending(job: DownloadJob) {
    return job.status === 'active' || job.status === 'queued';
}

export function removeDownloadJob(jobId: string) {
    const job = findJob(jobId);
    if (!job || isPending(job)) return;
    jobs = jobs.filter((j) => j !== job);
    changed(true);
}

export function clearFinishedDownloads() {
    jobs = jobs.filter((job) => isPending(job));
    changed(true);
}

/** When off, finished jobs stay visible this session but are not saved. */
export function setDownloadHistoryEnabled(enabled: boolean) {
    historyEnabled = enabled;
    scheduleSave();
}

/** Jobs running or waiting in line. */
export function countActiveDownloads(list: readonly DownloadJob[] = jobs) {
    return list.filter((job) => isPending(job)).length;
}

/** Whether a job is running or waiting, i.e. a new one would have to queue. */
export function isDownloadQueueBusy() {
    return jobs.some((job) => isPending(job));
}

export function summarizeJob(job: DownloadJob) {
    let done = 0;
    let failed = 0;
    let progress = 0;
    let bytes = 0;
    for (const item of job.items) {
        if (item.status === 'done') done++;
        if (item.status === 'failed') failed++;
        progress += item.status === 'done' ? 1 : item.status === 'downloading' ? item.progress : 0;
        bytes += item.bytes || 0;
    }
    const total = job.items.length;
    return { done, failed, total, bytes, fraction: total ? progress / total : 0 };
}
