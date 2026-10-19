//js/downloads.js
import {
    buildTrackFilename,
    sanitizeForFilename,
    RATE_LIMIT_ERROR_MESSAGE,
    getTrackArtists,
    getTrackTitle,
    formatPathTemplate,
    getCoverBlob,
    getExtensionFromBlob,
    escapeHtml,
    getTrackDiscNumber,
    buildErrorReportUrl,
} from './utils.js';
import { downloadQualitySettings, lyricsSettings, playlistSettings } from './storage.js';
import { generateM3U, generateM3U8, generateCUE, generateNFO, generateJSON } from './playlist-generator.js';
import {
    DesktopFolderWriter,
    FolderPickerWriter,
    SequentialFileWriter,
    ZipBlobWriter,
    ZipStreamWriter,
} from './bulk-download-writer.ts';
import { desktop, isDesktopApp } from './desktop-bridge.ts';
import { ensureFolderWritePermission, setFolderAccessPrompt } from './folder-permission.ts';
import { FfmpegProgress } from './ffmpeg.types.js';
import { DownloadProgress, ProgressMessage, SegmentedDownloadProgress } from './progressEvents.js';
import { db } from './db.js';
import { BulkDownloadMethod, modernSettings } from './ModernSettings.js';
import { SVG_CLOSE } from './icons.ts';
import { MusicAPI } from './music-api.js';
import { LyricsManager } from './lyrics.js';
import {
    addDownloadItems,
    enqueueDownloadJob,
    finishDownloadJob,
    getDownloadJobs,
    isDownloadQueueBusy,
    removeDownloadJob,
    setDownloadDestination,
    setJobAutoRetry,
    startDownloadJob,
    updateDownloadItem,
} from './download-manager.ts';

const downloadTasks = new Map();
const bulkDownloadTasks = new Map();
const ongoingDownloads = new Set();
/** jobId -> (alreadySaved) => Promise<void>, for jobs started this session. */
const retryHandlers = new Map();
let downloadNotificationContainer = null;

/**
 * Failed tracks are never abandoned. While an album runs they are retried in
 * rounds with a growing pause (3s, 6s, 12s, 24s). If some still fail, the
 * album finishes with what it has so the queue keeps moving, and the app
 * queues it again for the missing tracks after a longer pause (1, 2, 4, 8,
 * then every 10 minutes), until every track is saved or the job is cancelled
 * or removed.
 */
const retryTiming = {
    inlineRounds: 4,
    inlineBaseMs: 3000,
    autoBaseMs: 60 * 1000,
    autoMaxMs: 10 * 60 * 1000,
};

/** Overrides the retry pauses and round count; for tests. */
export function setRetryTiming(overrides) {
    Object.assign(retryTiming, overrides);
}

/** Pause between automatic re-queues of a job with missing tracks. */
export function autoRetryDelayMs(attempt) {
    return Math.min(retryTiming.autoBaseMs * 2 ** attempt, retryTiming.autoMaxMs);
}

/** Waits `ms`, calling `onTick(remainingMs)` each second; rejects with AbortError if `signal` aborts. */
function abortableDelay(ms, signal, onTick = null) {
    return new Promise((resolve, reject) => {
        const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
        if (signal?.aborted) return reject(abortError());
        const end = Date.now() + ms;
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const step = () => {
            const remaining = end - Date.now();
            if (remaining <= 0) {
                signal?.removeEventListener('abort', onAbort);
                return resolve();
            }
            onTick?.(remaining);
            timer = setTimeout(step, Math.min(1000, remaining));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        step();
    });
}

/**
 * Retries `indices` (tracks that failed) round after round, calling
 * `runTrack(index)` (a generator that yields the track's files and returns
 * true when it saved). Stops after `rounds` rounds, or never when `rounds` is
 * Infinity, and returns the indices still failing.
 */
async function* retryFailedTracks(
    indices,
    runTrack,
    { signal, jobId, itemOffset = 0, rounds = retryTiming.inlineRounds }
) {
    let pending = [...indices];
    for (let round = 1; pending.length > 0 && round <= rounds; round++) {
        const waitMs = retryTiming.inlineBaseMs * 2 ** (round - 1);
        const errors = new Map(
            pending.map((i) => [i, getDownloadJobs().find((j) => j.id === jobId)?.items[itemOffset + i]?.error])
        );
        await abortableDelay(waitMs, signal, (remaining) => {
            for (const i of pending) {
                updateDownloadItem(jobId, itemOffset + i, {
                    status: 'queued',
                    progress: 0,
                    statusText: `Retry ${round}/${rounds} in ${Math.ceil(remaining / 1000)}s${errors.get(i) ? ` · ${errors.get(i)}` : ''}`,
                });
            }
        });
        const still = [];
        for (const i of pending) {
            if (signal.aborted) return pending;
            if (!(yield* runTrack(i, true))) still.push(i);
        }
        pending = still;
    }
    return pending;
}

/** Queues a finished job's missing tracks again after a pause that grows with `attempt`. */
function scheduleAutoRetry(jobId, attempt) {
    const job = getDownloadJobs().find((j) => j.id === jobId);
    if (!job) return;
    const at = Date.now() + autoRetryDelayMs(attempt);
    setJobAutoRetry(jobId, at);
    console.log(`Will retry the missing tracks of "${job.title}" in ${Math.round((at - Date.now()) / 1000)}s`);
    setTimeout(() => {
        const current = getDownloadJobs().find((j) => j.id === jobId);
        // Removed, retried by hand, or cancelled in the meantime: nothing left to do.
        if (!current || current.autoRetryAt !== at) return;
        retryDownloadJob(jobId, undefined, { auto: true }).catch((error) => {
            console.error('Automatic retry failed:', error);
            scheduleAutoRetry(jobId, attempt + 1);
        });
    }, at - Date.now());
}

/** Finishes a job and, if tracks are still missing, queues it again after a pause. */
function settleJob(jobId, outcome = {}) {
    finishDownloadJob(jobId, outcome);
    const job = getDownloadJobs().find((j) => j.id === jobId);
    if (!job || job.status === 'cancelled' || job.status === 'done') return;
    if (!job.items.some((item) => item.status === 'failed')) return;
    scheduleAutoRetry(jobId, job.attempt || 0);
}

/** Fraction of the current file received, or null for progress events without one. */
function progressFraction(progress) {
    if (progress instanceof DownloadProgress && progress.totalBytes && progress.receivedBytes) {
        return progress.receivedBytes / progress.totalBytes;
    }
    if (progress instanceof SegmentedDownloadProgress && progress.currentSegment && progress.totalSegments) {
        return progress.currentSegment / progress.totalSegments;
    }
    return null;
}

/** Where a writer puts files, for the Downloads page. */
function describeDestination(writer, folderName = '') {
    if (writer instanceof DesktopFolderWriter) {
        return { method: 'desktop', label: writer.getDownloadDir() };
    }
    if (writer instanceof FolderPickerWriter) {
        const handle = writer.getDirHandle();
        const method = modernSettings.bulkDownloadMethod === BulkDownloadMethod.LocalMedia ? 'local' : 'folder';
        return { method, label: handle?.name || 'Download folder', handle };
    }
    if (writer instanceof ZipStreamWriter) {
        const handle = writer.getFileHandle();
        return { method: 'zip', label: handle?.name || `${folderName}.zip`, handle };
    }
    if (writer instanceof ZipBlobWriter) {
        return { method: 'browser', label: `${folderName}.zip` };
    }
    return { method: 'browser', label: 'Browser downloads' };
}

/**
 * Runs `pick` (a file or folder picker). Browsers only open pickers right
 * after a click, so when the click's activation has already run out (slow
 * album lookup), show a button and run `pick` from that click instead.
 */
async function pickWithUserGesture(pick, message, actionLabel) {
    try {
        return await pick();
    } catch (error) {
        if (error?.name !== 'SecurityError') throw error;
    }
    return new Promise((resolve, reject) => {
        const el = showActionPrompt(message, [
            {
                label: actionLabel,
                primary: true,
                onClick: () => {
                    el.remove();
                    pick().then(resolve, reject);
                },
            },
            {
                label: 'Cancel',
                onClick: () => {
                    el.remove();
                    reject(new DOMException('Download cancelled', 'AbortError'));
                },
            },
        ]);
    });
}

/** `path` with the job's `folder/` prefix removed, as playlist files reference it. */
function relativeToFolder(path, folder) {
    return folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path.split('/').pop();
}

/** Wraps a single {@link WriterEntry}-like object as an AsyncIterable for use with IBulkDownloadWriter.write(). */
async function* singleWriterEntry(entry) {
    yield entry;
}

async function createDiscLayoutContext(tracks, api) {
    if (!playlistSettings.shouldSeparateDiscsInZip()) {
        return { separateByDisc: false, resolveDiscNumber: () => 1 };
    }

    const explicitDiscNumbers = tracks.map((track) => getTrackDiscNumber(track));
    const explicitDistinct = new Set(explicitDiscNumbers.filter(Boolean));

    if (explicitDistinct.size > 1) {
        return {
            separateByDisc: true,
            resolveDiscNumber: (index) => explicitDiscNumbers[index] || 1,
        };
    }

    // Some providers omit disc fields in album payload but include them in full track metadata.
    const hydratedDiscNumbers = await Promise.all(
        tracks.map(async (track, index) => {
            if (explicitDiscNumbers[index]) return explicitDiscNumbers[index];
            try {
                const fullTrack = await api.getTrackMetadata(track.id);
                return getTrackDiscNumber(fullTrack);
            } catch {
                return null;
            }
        })
    );

    const hydratedDistinct = new Set(hydratedDiscNumbers.filter(Boolean));
    if (hydratedDistinct.size > 1) {
        return {
            separateByDisc: true,
            resolveDiscNumber: (index) => hydratedDiscNumbers[index] || explicitDiscNumbers[index] || 1,
        };
    }

    return { separateByDisc: false, resolveDiscNumber: () => 1 };
}

async function computeDiscInfo(tracks, api = null) {
    // First pass: collect explicit disc numbers from the raw track objects.
    const explicitDiscNumbers = tracks.map((track) => getTrackDiscNumber(track));
    const explicitDistinct = new Set(explicitDiscNumbers.filter(Boolean));

    let resolvedDiscNumbers = explicitDiscNumbers;

    // Some providers omit disc fields in the album payload. When we can't
    // distinguish discs from the raw data and an API instance is provided,
    // hydrate missing disc numbers via full-track metadata (mirrors the logic
    // in createDiscLayoutContext).
    if (explicitDistinct.size <= 1 && api) {
        const hydratedDiscNumbers = await Promise.all(
            tracks.map(async (track, index) => {
                if (explicitDiscNumbers[index]) return explicitDiscNumbers[index];
                try {
                    const fullTrack = await api.getTrackMetadata(track.id);
                    return getTrackDiscNumber(fullTrack);
                } catch {
                    return null;
                }
            })
        );
        const hydratedDistinct = new Set(hydratedDiscNumbers.filter(Boolean));
        if (hydratedDistinct.size > 1) {
            resolvedDiscNumbers = hydratedDiscNumbers;
        }
    }

    const tracksPerDisc = new Map();
    let maxDiscNumber = 0;
    for (let i = 0; i < tracks.length; i++) {
        const discNumber = resolvedDiscNumbers[i] || 1;
        tracksPerDisc.set(discNumber, (tracksPerDisc.get(discNumber) || 0) + 1);
        if (discNumber > maxDiscNumber) {
            maxDiscNumber = discNumber;
        }
    }

    return { totalDiscs: maxDiscNumber || 1, tracksPerDisc, resolvedDiscNumbers };
}

async function annotateTracksWithDiscInfo(tracks, api = null) {
    const { totalDiscs, tracksPerDisc, resolvedDiscNumbers } = await computeDiscInfo(tracks, api);
    return tracks.map((track, index) => {
        const discNumber = resolvedDiscNumbers[index] || 1;
        return {
            ...track,
            album: {
                ...(track.album || {}),
                totalDiscs,
                numberOfTracksOnDisc: tracksPerDisc.get(discNumber),
            },
        };
    });
}

function getDiscFolderName(discNumber) {
    return `Disc ${discNumber}`;
}

function buildZipTrackPath(rootFolder, filename, separateByDisc, discNumber = 1) {
    if (!separateByDisc) return `${rootFolder}/${filename}`;
    return `${rootFolder}/${getDiscFolderName(discNumber)}/${filename}`;
}

function createDownloadNotification() {
    if (!downloadNotificationContainer) {
        downloadNotificationContainer = document.createElement('div');
        downloadNotificationContainer.id = 'download-notifications';
        document.body.appendChild(downloadNotificationContainer);
    }
    // Progress pop-ups can be turned off; prompts and messages always show.
    downloadNotificationContainer.classList.toggle('hide-progress-popups', modernSettings.showDownloadPopups === false);
    return downloadNotificationContainer;
}

function friendlyEnrichError(error) {
    const msg = String(error?.message || error || '');
    if (msg.includes('Could not resolve audio stream')) return 'no audio stream is available for this track';
    if (msg.includes('DOLBY ATMOS') || msg.includes('Dolby Atmos')) return msg;
    if (msg.includes('status 404')) return 'this track was not found on the provider';
    if (msg.includes('status 422')) return 'this track cannot be downloaded';
    return msg || 'the track could not be prepared for download';
}

// Transient playback/download failures that are not actionable bugs.
// Never offer a GitHub "Report this issue" link for these — they flood the tracker.
const NO_ISSUE_REPORT_PATTERN =
    /could not find audio source|failed to play album|couldn'?t download|failed to download/i;

export function showNotification(message, options = {}) {
    if (typeof options === 'string') options = { type: options };
    const container = createDownloadNotification();

    const notifEl = document.createElement('div');
    notifEl.className = 'download-task';

    const innerDiv = document.createElement('div');
    innerDiv.className = 'notification-message';
    innerDiv.textContent = message;
    notifEl.appendChild(innerDiv);

    const isError =
        options.type === 'error' ||
        /\b(error|failed|failure|could not|couldn't|cannot|unable|unavailable|not found)\b/i.test(String(message));
    if (isError && options.reportIssue !== false && !NO_ISSUE_REPORT_PATTERN.test(String(message))) {
        const reportLink = document.createElement('a');
        reportLink.className = 'error-report-link';
        reportLink.href = buildErrorReportUrl(message, options.details || options.error || null);
        reportLink.target = '_blank';
        reportLink.rel = 'noopener noreferrer';
        reportLink.textContent = 'Report this issue';
        notifEl.appendChild(reportLink);
    }

    container.appendChild(notifEl);

    // Auto remove
    setTimeout(
        () => {
            notifEl.style.animation = 'slide-out 0.3s ease forwards';
            setTimeout(() => notifEl.remove(), 300);
        },
        isError ? 10000 : 1500
    );
}

/** Pop-up with buttons that stays until one is clicked. Returns the element. */
function showActionPrompt(text, actions) {
    const container = createDownloadNotification();
    const el = document.createElement('div');
    el.className = 'download-task download-prompt';

    const message = document.createElement('div');
    message.className = 'notification-message';
    message.textContent = text;

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;';
    for (const action of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = action.primary ? 'btn-primary' : 'btn-secondary';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
            btn.disabled = true;
            action.onClick();
        });
        row.appendChild(btn);
    }

    el.append(message, row);
    container.appendChild(el);
    return el;
}

/**
 * In-app prompt shown when the browser has dropped write access to the
 * download folder. The browser only re-grants access from a click, so the
 * waiting download resumes when the user presses "Allow".
 */
function promptForFolderAccess(grant) {
    return new Promise((resolve) => {
        const el = showActionPrompt(
            'The browser paused access to your download location. Allow access to keep saving there.',
            [
                {
                    label: 'Allow',
                    primary: true,
                    onClick: async () => {
                        const granted = await grant();
                        el.remove();
                        resolve(granted);
                    },
                },
                {
                    label: 'Use browser downloads',
                    onClick: () => {
                        el.remove();
                        resolve(false);
                    },
                },
            ]
        );
    });
}

setFolderAccessPrompt(promptForFolderAccess);

export function addDownloadTask(trackId, track, _filename, api, abortController) {
    const container = createDownloadNotification();

    const taskEl = document.createElement('div');
    taskEl.className = 'download-task download-progress-popup';
    taskEl.dataset.trackId = trackId;
    const trackTitle = getTrackTitle(track);
    const trackArtists = getTrackArtists(track);
    taskEl.innerHTML = `
        <div style="display: flex; align-items: start; gap: 0.75rem;">
            <img crossorigin="anonymous" referrerpolicy="no-referrer" src="${api.getCoverUrl(track.album?.cover)}"
                 style="width: 40px; height: 40px; border-radius: 4px; flex-shrink: 0;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; font-size: 0.9rem; margin-bottom: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${trackTitle}</div>
                <div style="font-size: 0.8rem; color: var(--muted-foreground); margin-bottom: 0.5rem;">${trackArtists}</div>
                <div class="download-progress-bar" style="height: 4px; background: var(--secondary); border-radius: 2px; overflow: hidden;">
                    <div class="download-progress-fill" style="width: 0%; height: 100%; background: var(--highlight); transition: width 0.2s;"></div>
                </div>
                <div class="download-status" style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Starting...</div>
            </div>
            <button class="download-cancel" style="background: transparent; border: none; color: var(--muted-foreground); cursor: pointer; padding: 4px; border-radius: 4px; transition: all 0.2s;">
                ${SVG_CLOSE(20)}
            </button>
        </div>
    `;

    container.appendChild(taskEl);

    downloadTasks.set(trackId, { taskEl, abortController });

    taskEl.querySelector('.download-cancel').addEventListener('click', () => {
        abortController.abort();
        removeDownloadTask(trackId);
    });

    return { taskEl, abortController };
}

export function updateDownloadProgress(trackId, progress) {
    const task = downloadTasks.get(trackId);
    if (!task) return;

    const { taskEl } = task;
    const progressFill = taskEl.querySelector('.download-progress-fill');
    const statusEl = taskEl.querySelector('.download-status');

    if (progress instanceof DownloadProgress && progress.receivedBytes && progress.totalBytes) {
        const percent = progress.totalBytes ? Math.round((progress.receivedBytes / progress.totalBytes) * 100) : 0;

        progressFill.style.width = `${percent}%`;
        progressFill.style.background = 'var(--highlight)';

        const receivedMB = (progress.receivedBytes / (1024 * 1024)).toFixed(1);
        const totalMB = progress.totalBytes ? (progress.totalBytes / (1024 * 1024)).toFixed(1) : '?';

        statusEl.textContent = `Downloading: ${receivedMB}MB / ${totalMB}MB (${percent}%)`;
    } else if (progress instanceof SegmentedDownloadProgress && progress.currentSegment && progress.totalSegments) {
        const percent = progress.totalBytes ? Math.round((progress.currentSegment / progress.totalSegments) * 100) : 0;

        progressFill.style.width = `${percent}%`;
        progressFill.style.background = 'var(--highlight)';

        const receivedMB = (progress.receivedBytes / (1024 * 1024)).toFixed(1);
        const totalMB = progress.totalBytes ? (progress.totalBytes / (1024 * 1024)).toFixed(1) : '?';

        statusEl.textContent = `Downloading: ${receivedMB}MB / ${totalMB}MB (${percent}%)`;
    } else if (progress instanceof FfmpegProgress && progress.stage == 'encoding') {
        const percent = progress.progress ? Math.round(progress.progress) : 0;
        progressFill.style.width = `${percent}%`;
        progressFill.style.background = '#3b82f6'; // Blue for encoding
        statusEl.textContent = `Converting: ${percent}%`;
    } else if (progress instanceof ProgressMessage || progress.message) {
        if (progress instanceof FfmpegProgress && (progress.stage == 'parsing' || progress.stage == 'stdout')) {
            return;
        }

        progressFill.style.width = '100%';
        progressFill.style.background = '#3b82f6';
        statusEl.textContent = progress.message;
    }
}

export function completeDownloadTask(trackId, success = true, message = null) {
    const task = downloadTasks.get(trackId);
    if (!task) return;

    const { taskEl } = task;
    const progressFill = taskEl.querySelector('.download-progress-fill');
    const statusEl = taskEl.querySelector('.download-status');
    const cancelBtn = taskEl.querySelector('.download-cancel');

    if (success) {
        progressFill.style.width = '100%';
        progressFill.style.background = '#10b981';
        statusEl.textContent = '✓ Downloaded';
        statusEl.style.color = '#10b981';
        cancelBtn.remove();

        setTimeout(() => removeDownloadTask(trackId), 3000);
    } else {
        progressFill.style.background = '#ef4444';
        statusEl.textContent = message || '✗ Download failed';
        statusEl.style.color = '#ef4444';
        cancelBtn.innerHTML = `
            ${SVG_CLOSE(20)}
        `;
        cancelBtn.onclick = () => removeDownloadTask(trackId);

        setTimeout(() => removeDownloadTask(trackId), 5000);
    }
}

function removeDownloadTask(trackId) {
    const task = downloadTasks.get(trackId);
    if (!task) return;

    const { taskEl } = task;
    taskEl.style.animation = 'slide-out 0.3s ease forwards';

    setTimeout(() => {
        taskEl.remove();
        downloadTasks.delete(trackId);

        if (downloadNotificationContainer && downloadNotificationContainer.children.length === 0) {
            downloadNotificationContainer.remove();
            downloadNotificationContainer = null;
        }
    }, 300);
}

function removeBulkDownloadTask(notifEl) {
    const task = bulkDownloadTasks.get(notifEl);
    if (!task) return;

    notifEl.style.animation = 'slide-out 0.3s ease forwards';

    setTimeout(() => {
        notifEl.remove();
        bulkDownloadTasks.delete(notifEl);

        if (downloadNotificationContainer && downloadNotificationContainer.children.length === 0) {
            downloadNotificationContainer.remove();
            downloadNotificationContainer = null;
        }
    }, 300);
}

async function downloadTrackBlob(track, quality, api, signal = null, onProgress = null) {
    const blob = await api.downloadTrack(track.id, quality, undefined, {
        track,
        signal,
        onProgress,
        triggerDownload: false,
        calculateDashBytes: false,
    });

    // Detect actual format from blob signature BEFORE adding metadata
    const extension = await getExtensionFromBlob(blob);

    return { blob, extension };
}

/**
 * Fetches one track's audio, reporting progress and speed to the download
 * manager item `itemIndex` of `jobId`. This is the slow part of a track and
 * can run for several tracks at once; writing happens in {@link emitTrackFiles}.
 */
async function fetchTrack({ track, itemIndex, quality, api, signal, jobId, onProgress = null }) {
    updateDownloadItem(jobId, itemIndex, {
        status: 'downloading',
        progress: 0,
        error: undefined,
        statusText: undefined,
        speed: undefined,
    });

    const startedAt = performance.now();
    let lastSpeedUpdate = 0;
    const { blob, extension } = await downloadTrackBlob(track, quality, api, signal, (p) => {
        const fraction = progressFraction(p);
        if (fraction !== null) {
            const patch = { progress: Math.min(fraction, 0.99) };
            // Speed of the stream so far, refreshed about twice a second.
            const now = performance.now();
            if (p?.receivedBytes && now - lastSpeedUpdate > 500) {
                lastSpeedUpdate = now;
                patch.speed = p.receivedBytes / ((now - startedAt) / 1000);
            }
            updateDownloadItem(jobId, itemIndex, patch);
        }
        onProgress?.(p, fraction);
    });
    return { blob, extension };
}

/**
 * Yields a fetched track's audio file plus lyrics files and marks its
 * manager item done once the writer has saved it. Returns the path used in
 * playlist files (disc folder + filename).
 */
async function* emitTrackFiles({
    track,
    index,
    itemIndex = index,
    fetched,
    quality,
    lyricsManager,
    folderPath,
    discLayout,
    sequenceNumber = null,
    jobId,
}) {
    const { blob, extension } = fetched;
    const filename = buildTrackFilename(track, quality, extension, sequenceNumber);
    const separateByDisc = discLayout.separateByDisc;
    const discNumber = discLayout.resolveDiscNumber(index);
    const discPath = separateByDisc ? `${getDiscFolderName(discNumber)}/${filename}` : filename;
    const entryName = buildZipTrackPath(folderPath, filename, separateByDisc, discNumber);

    yield { name: entryName, lastModified: new Date(), input: blob };
    updateDownloadItem(jobId, itemIndex, {
        status: 'done',
        progress: 1,
        bytes: blob.size,
        path: entryName,
        speed: undefined,
    });

    if (lyricsManager && lyricsSettings.shouldDownloadLyrics()) {
        try {
            const lyricsData = await lyricsManager.fetchLyrics(track.id, track);
            if (lyricsData) {
                const lrcContent = lyricsManager.generateLRCContent(lyricsData, track);
                if (lrcContent) {
                    const lrcFilename = filename.replace(/\.[^.]+$/, '.lrc');
                    yield {
                        name: buildZipTrackPath(folderPath, lrcFilename, separateByDisc, discNumber),
                        lastModified: new Date(),
                        input: lrcContent,
                    };
                }
                const ttmlContent = lyricsManager.generateTTMLContent(lyricsData, track);
                if (ttmlContent) {
                    const ttmlFilename = filename.replace(/\.[^.]+$/, '.ttml');
                    yield {
                        name: buildZipTrackPath(folderPath, ttmlFilename, separateByDisc, discNumber),
                        lastModified: new Date(),
                        input: ttmlContent,
                    };
                }
            }
        } catch {
            /* ignore */
        }
    }

    return discPath;
}

/** Fetches and emits one track, one after the other (used for retries). */
async function* downloadTrackFiles(args) {
    const withItem = { ...args, itemIndex: args.itemIndex ?? args.index };
    const fetched = await fetchTrack(withItem);
    return yield* emitTrackFiles({ ...withItem, fetched });
}

/**
 * Downloads `indices` with up to `concurrency()` fetches in flight at once,
 * but hands finished tracks to the writer in order, one at a time, so the
 * output is the same as a sequential run. At most `concurrency()` tracks are
 * fetched or waiting to be written at any moment, which bounds memory.
 *
 * `fetchOne(i)` fetches track i, `emitOne(i, fetched)` is a generator that
 * writes it, `isSaved(i)` says the track needs no download. Returns the
 * indices that failed (after calling `onFailure(i, error)`). After the first
 * failure the rest of the run is sequential: if the host is struggling,
 * piling more requests on it only makes things worse.
 */
async function* downloadTracksInOrder(indices, { concurrency, fetchOne, emitOne, isSaved, onFailure, signal }) {
    const failed = [];
    const started = new Map(); // index -> promise of { fetched } | { error } | { saved }
    let next = 0;
    let limit = Math.max(1, concurrency());

    const startMore = (consumed) => {
        while (next < indices.length && next - consumed < limit && !signal.aborted) {
            const i = indices[next++];
            started.set(
                i,
                isSaved(i)
                    ? Promise.resolve({ saved: true })
                    : fetchOne(i).then(
                          (fetched) => ({ fetched }),
                          (error) => ({ error })
                      )
            );
        }
    };

    startMore(0);
    for (let position = 0; position < indices.length; position++) {
        if (signal.aborted) break;
        const i = indices[position];
        const result = await started.get(i);
        started.delete(i);

        if (result.error) {
            if (result.error?.name === 'AbortError' || signal.aborted) throw result.error;
            onFailure(i, result.error);
            failed.push(i);
            limit = 1;
        } else {
            yield* emitOne(i, result.fetched, Boolean(result.saved));
        }
        startMore(position + 1);
    }
    return failed;
}

async function bulkDownload({
    tracks,
    folderName,
    api,
    quality,
    lyricsManager,
    notification,
    writer,
    coverBlob = null,
    type = 'playlist',
    metadata = null,
    jobId,
    alreadySaved = null,
}) {
    const { abortController } = bulkDownloadTasks.get(notification);
    const signal = abortController.signal;
    const stats = { failed: 0, total: tracks.length, firstError: null };

    async function* yieldFiles() {
        // Add cover if available and enabled
        if (coverBlob && playlistSettings.shouldIncludeCover()) {
            yield { name: `${folderName}/cover.jpg`, lastModified: new Date(), input: coverBlob };
        }

        const useRelativePaths = playlistSettings.shouldUseRelativePaths();
        const discLayout = await createDiscLayoutContext(tracks, api);

        // Download tracks, yielding each immediately and collecting actual paths for playlist generation.
        // Indexed by track so playlists/CUE stay aligned when a retry fills a gap.
        const trackPaths = new Array(tracks.length).fill(null);

        async function* runTrack(i, isRetry = false) {
            const track = tracks[i];
            const trackTitle = getTrackTitle(track);
            const savedPath = alreadySaved?.get(String(track.id));
            if (savedPath) {
                // Saved by an earlier run of this job: keep it, but list it in playlist files.
                trackPaths[i] = relativeToFolder(savedPath, folderName);
                updateDownloadItem(jobId, i, { status: 'done', progress: 1, path: savedPath });
                return true;
            }
            const label = isRetry ? `Retrying ${trackTitle}` : trackTitle;
            updateBulkDownloadProgress(notification, i, tracks.length, label);

            try {
                // Playlists/queues/liked lists mix tracks from many albums, so use
                // the list sequence; albums/discographies keep album numbers.
                const sequenceNumber = type === 'playlist' || type === 'queue' || type === 'liked' ? i + 1 : null;
                trackPaths[i] = yield* downloadTrackFiles({
                    track,
                    index: i,
                    quality,
                    api,
                    signal,
                    lyricsManager,
                    folderPath: folderName,
                    discLayout,
                    sequenceNumber,
                    jobId,
                    onProgress: (p, fraction) => {
                        // Cap at 99% to avoid showing 100% before finalization
                        const fileFraction = Math.min(fraction ?? 0, 0.99);
                        updateBulkDownloadProgress(notification, i + fileFraction, tracks.length, label, p);
                    },
                });
                return true;
            } catch (err) {
                if (err?.name === 'AbortError' || signal.aborted) throw err;
                if (!stats.firstError) stats.firstError = err?.message || String(err);
                console.error(`Failed to download track ${trackTitle}:`, err);
                updateDownloadItem(jobId, i, {
                    status: 'failed',
                    progress: 0,
                    error: err?.message || String(err),
                    statusText: undefined,
                });
                return false;
            }
        }

        // First pass: several tracks are fetched at once, written in order (see downloadTracksInOrder).
        const inFlight = new Map(); // track index -> fraction fetched
        let finished = 0;
        const showProgress = (p) => {
            const [first] = inFlight.keys();
            const partial = [...inFlight.values()].reduce((sum, fraction) => sum + Math.min(fraction, 0.99), 0);
            const title = first === undefined ? '' : getTrackTitle(tracks[first]);
            updateBulkDownloadProgress(notification, finished + partial, tracks.length, title, p);
        };

        const failedIndices = yield* downloadTracksInOrder(
            tracks.map((_, i) => i),
            {
                signal,
                concurrency: () => modernSettings.downloadConcurrency,
                isSaved: (i) => alreadySaved?.has(String(tracks[i].id)) ?? false,
                fetchOne: (i) => {
                    inFlight.set(i, 0);
                    return fetchTrack({
                        track: tracks[i],
                        itemIndex: i,
                        quality,
                        api,
                        signal,
                        jobId,
                        onProgress: (p, fraction) => {
                            if (inFlight.has(i)) inFlight.set(i, fraction ?? inFlight.get(i));
                            showProgress(p);
                        },
                    });
                },
                async *emitOne(i, fetched, saved) {
                    const track = tracks[i];
                    if (saved) {
                        // Saved by an earlier run of this job: keep it, but list it in playlist files.
                        const savedPath = alreadySaved.get(String(track.id));
                        trackPaths[i] = relativeToFolder(savedPath, folderName);
                        updateDownloadItem(jobId, i, { status: 'done', progress: 1, path: savedPath });
                    } else {
                        // Playlists/queues/liked lists mix tracks from many albums, so use
                        // the list sequence; albums/discographies keep album numbers.
                        const sequenceNumber =
                            type === 'playlist' || type === 'queue' || type === 'liked' ? i + 1 : null;
                        trackPaths[i] = yield* emitTrackFiles({
                            track,
                            index: i,
                            fetched,
                            quality,
                            lyricsManager,
                            folderPath: folderName,
                            discLayout,
                            sequenceNumber,
                            jobId,
                        });
                    }
                    inFlight.delete(i);
                    finished++;
                    showProgress();
                },
                onFailure: (i, err) => {
                    inFlight.delete(i);
                    if (!stats.firstError) stats.firstError = err?.message || String(err);
                    console.error(`Failed to download track ${getTrackTitle(tracks[i])}:`, err);
                    updateDownloadItem(jobId, i, {
                        status: 'failed',
                        progress: 0,
                        error: err?.message || String(err),
                        statusText: undefined,
                        speed: undefined,
                    });
                    const statusEl = notification.querySelector('.download-status');
                    if (statusEl) {
                        statusEl.textContent = `${tracks.length - finished - inFlight.size} left · a track failed, retrying`;
                        statusEl.style.color = '#f59e0b';
                    }
                },
            }
        );

        // Every source was already tried for these; retry them in rounds with growing pauses.
        // Whatever still fails is retried by a later run of this job (see settleJob).
        if (failedIndices.length > 0 && !signal.aborted) {
            yield* retryFailedTracks(failedIndices, runTrack, { signal, jobId });
        }
        stats.failed = trackPaths.filter((path) => path === null).length;

        if (playlistSettings.shouldGenerateNFO()) {
            const nfoContent = generateNFO(metadata || { title: folderName }, tracks, type);
            yield {
                name: `${folderName}/${sanitizeForFilename(folderName)}.nfo`,
                lastModified: new Date(),
                input: nfoContent,
            };
        }

        if (playlistSettings.shouldGenerateJSON()) {
            const jsonContent = generateJSON(metadata || { title: folderName }, tracks, type);
            yield {
                name: `${folderName}/${sanitizeForFilename(folderName)}.json`,
                lastModified: new Date(),
                input: jsonContent,
            };
        }

        // For albums, generate CUE file (one per disc if multi-disc)
        if (type === 'album' && playlistSettings.shouldGenerateCUE()) {
            const tracksByVolume = tracks.reduce((acc, track, index) => {
                const discNumber = String(getTrackDiscNumber(track) || 1);
                if (!acc[discNumber]) acc[discNumber] = [];
                acc[discNumber].push({ ...track, trackPath: trackPaths[index] });
                return acc;
            }, {});

            const multiDisc = Object.keys(tracksByVolume).length > 1;

            for (const [volumeNumber, volumeTracks] of Object.entries(tracksByVolume)) {
                const volumeTrackPaths = volumeTracks.map((track) => track.trackPath);
                const cueContent = generateCUE(
                    metadata,
                    volumeTracks,
                    sanitizeForFilename(folderName),
                    volumeTrackPaths
                );
                yield {
                    name: `${folderName}/${sanitizeForFilename(folderName)}${multiDisc ? ` - Disc ${volumeNumber}` : ''}.cue`,
                    lastModified: new Date(),
                    input: cueContent,
                };
            }
        }

        // Generate m3u/m3u8 last, using actual track paths collected during download
        if (playlistSettings.shouldGenerateM3U()) {
            const m3uContent = generateM3U(
                metadata || { title: folderName },
                tracks,
                useRelativePaths,
                null,
                'flac',
                trackPaths
            );
            yield {
                name: `${folderName}/${sanitizeForFilename(folderName)}.m3u`,
                lastModified: new Date(),
                input: m3uContent,
            };
        }

        if (playlistSettings.shouldGenerateM3U8()) {
            const m3u8Content = generateM3U8(
                metadata || { title: folderName },
                tracks,
                useRelativePaths,
                null,
                'flac',
                trackPaths
            );
            yield {
                name: `${folderName}/${sanitizeForFilename(folderName)}.m3u8`,
                lastModified: new Date(),
                input: m3u8Content,
            };
        }
    }

    await writer.write(yieldFiles());
    return stats;
}

/** The remembered Folder Picker folder, or null. */
async function getSavedDownloadFolder() {
    if (!modernSettings.rememberBulkDownloadFolder) return null;
    await modernSettings.waitPending();
    return modernSettings.bulkDownloadFolder || null;
}

/**
 * Returns a writer that can be used to save a single-track download directly
 * to the configured folder (Local Media Folder or saved Folder Picker handle),
 * or `null` if the feature is not active / no folder is configured.
 *
 * Without a saved folder this opens the folder picker; cancelling it falls
 * back to a normal browser download.
 */
async function createSingleTrackFolderWriter() {
    // The desktop app always saves straight to its download folder.
    if (isDesktopApp) return new DesktopFolderWriter(await desktop.getDownloadDir());
    if (!modernSettings.downloadSinglesToFolder) return null;

    const method = modernSettings.bulkDownloadMethod;
    const hasFolderPicker = 'showDirectoryPicker' in window;

    if (method === BulkDownloadMethod.LocalMedia) {
        const localHandle = await db.getSetting('local_folder_handle');
        if (hasFolderPicker && localHandle && typeof localHandle.requestPermission === 'function') {
            if (await ensureFolderWritePermission(localHandle)) return FolderPickerWriter.fromHandle(localHandle);
        }
        return null;
    }

    if (method === BulkDownloadMethod.Folder && hasFolderPicker) {
        const savedHandle = await getSavedDownloadFolder();
        // Try to reuse the saved handle first.
        if (savedHandle && typeof savedHandle.requestPermission === 'function') {
            if (await ensureFolderWritePermission(savedHandle)) return FolderPickerWriter.fromHandle(savedHandle);
        }
        // No usable saved handle - open the picker so the user can choose a folder.
        try {
            const writer = await pickWithUserGesture(
                () => FolderPickerWriter.create(),
                'Choose the folder to save downloads in.',
                'Choose folder'
            );
            if (modernSettings.rememberBulkDownloadFolder) {
                modernSettings.bulkDownloadFolder = writer.getDirHandle();
            }
            return writer;
        } catch {
            // User cancelled the picker - return null so we fall back to the
            // normal browser download instead of erroring out.
            return null;
        }
    }

    return null;
}

/**
 * Returns the appropriate bulk download writer for the current settings and environment,
 * or null when individual sequential downloads should be used.
 *
 * Any picker opens here, while the click that started the download is fresh,
 * not when the job reaches the front of the queue.
 */
async function createBulkWriter(folderName, displayName = folderName) {
    if (isDesktopApp) return new DesktopFolderWriter(await desktop.getDownloadDir());

    const method = modernSettings.bulkDownloadMethod;
    const forceZipBlob = modernSettings.forceZipBlob;
    const hasFileSystemAccess = 'showSaveFilePicker' in window && 'createWritable' in FileSystemFileHandle.prototype;
    const hasFolderPicker = 'showDirectoryPicker' in window;
    const pickMessage = `Choose where to save "${displayName}".`;

    // ── Local Media Folder method ────────────────────────────────────────────
    if (method === BulkDownloadMethod.LocalMedia) {
        const localHandle = await db.getSetting('local_folder_handle');
        if (hasFolderPicker) {
            // Browser mode: try to reuse the stored handle with write permission
            if (localHandle && typeof localHandle.requestPermission === 'function') {
                if (await ensureFolderWritePermission(localHandle)) {
                    return FolderPickerWriter.fromHandle(localHandle);
                }
            }
            // No usable handle - prompt and persist
            try {
                const writer = await pickWithUserGesture(
                    () => FolderPickerWriter.create(),
                    pickMessage,
                    'Choose folder'
                );
                await db.saveSetting('local_folder_handle', writer.getDirHandle());
                return writer;
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    throw error;
                }
                return null;
            }
        }
        // Browser without File System Access API - fall through to ZIP
    }

    // ── Folder Picker method ─────────────────────────────────────────────────
    if (method === BulkDownloadMethod.Folder && hasFolderPicker) {
        const rememberFolder = modernSettings.rememberBulkDownloadFolder;
        const savedHandle = await getSavedDownloadFolder();
        try {
            const writer = await pickWithUserGesture(
                () => FolderPickerWriter.create(savedHandle),
                pickMessage,
                'Choose folder'
            );
            modernSettings.bulkDownloadFolder = rememberFolder ? writer.getDirHandle() : null;

            return writer;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw error;
            }
            return null;
        }
    }

    if (method === BulkDownloadMethod.Individual) {
        return SequentialFileWriter;
    }
    // method === 'zip' (or folder picker unavailable as fallback)
    if (!forceZipBlob && hasFileSystemAccess) {
        const writer = new ZipStreamWriter(`${folderName}.zip`);
        await pickWithUserGesture(() => writer.pickFile(), pickMessage, 'Choose location');
        return writer;
    }
    return new ZipBlobWriter(`${folderName}.zip`);
}

/**
 * Puts a multi-track download in the download queue. Resolves once it is
 * queued (after any folder/save prompt), not when it finishes, so several
 * albums can be lined up back to back.
 *
 * `prepare` runs when the job starts and may return `{ tracks, coverBlob }`
 * for lookups that should not delay queueing (cover art, disc info).
 */
async function startBulkDownload({
    tracks,
    folderName = '',
    api,
    quality,
    lyricsManager = LyricsManager.instance,
    type,
    name,
    subtitle = '',
    cover = null,
    coverBlob = null,
    metadata = null,
    single = false,
    prepare = null,
    alreadySaved = null,
    attempt = 0,
    source = { kind: 'tracks' },
    retry = null,
}) {
    const abortController = new AbortController();
    const queueWasBusy = isDownloadQueueBusy();
    const jobId = startDownloadJob({
        kind: type,
        title: name,
        subtitle,
        cover,
        quality,
        folderName,
        tracks,
        source,
        attempt,
        onCancel: () => abortController.abort(),
    });
    if (retry) retryHandlers.set(jobId, retry);

    let writer;
    try {
        writer = single ? await createSingleTrackFolderWriter() : await createBulkWriter(folderName, name);
    } catch (error) {
        if (error?.name === 'AbortError') {
            finishDownloadJob(jobId, { cancelled: true });
            return;
        }
        console.error('Could not open the download location:', error);
        finishDownloadJob(jobId, { error: error?.message || String(error) });
        showNotification(`Couldn't start the download of "${name}": ${error?.message || error}`);
        return;
    }
    if (!writer) {
        finishDownloadJob(jobId, { error: 'No download location is available' });
        return;
    }

    setDownloadDestination(jobId, describeDestination(writer, folderName));
    if (queueWasBusy) showNotification(`Added "${name}" to the download queue`);

    enqueueDownloadJob(jobId, async () => {
        const notification = createBulkDownloadNotification(type, name, tracks.length, abortController);
        try {
            const prepared = prepare ? await prepare() : null;
            const stats = await bulkDownload({
                tracks: prepared?.tracks || tracks,
                folderName,
                api,
                quality,
                lyricsManager,
                notification,
                writer,
                coverBlob: prepared?.coverBlob ?? coverBlob,
                type,
                metadata,
                jobId,
                alreadySaved,
            });
            if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

            completeBulkDownload(notification, true, null, {
                failedTracks: stats?.failed || 0,
                totalTracks: stats?.total || 0,
            });
            settleJob(jobId, { error: stats?.failed ? stats.firstError || undefined : undefined });

            // If the download went to the local media folder, refresh the local library.
            if (modernSettings.bulkDownloadMethod === BulkDownloadMethod.LocalMedia) {
                window.refreshLocalMediaFolder?.();
            }
        } catch (error) {
            if (error?.name === 'AbortError' || abortController.signal.aborted) {
                removeBulkDownloadTask(notification);
                finishDownloadJob(jobId, { cancelled: true });
                return;
            }
            console.error('Bulk download failed:', error);
            completeBulkDownload(notification, false, error?.message);
            settleJob(jobId, { error: error?.message || String(error) });
        }
    });
}

export async function downloadTracks(
    tracks,
    api,
    quality,
    _lyricsManager = null,
    { alreadySaved = null, attempt = 0 } = {}
) {
    const folderName = `Queue - ${new Date().toISOString().slice(0, 10)}`;
    await startBulkDownload({
        tracks,
        folderName,
        quality,
        type: 'queue',
        name: 'Queue',
        subtitle: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
        metadata: {
            title: 'Queue',
        },
        api,
        alreadySaved,
        attempt,
        retry: (saved, next) => downloadTracks(tracks, api, quality, null, { alreadySaved: saved, attempt: next }),
    });
}

export async function downloadAlbum(
    album,
    tracks,
    api,
    quality,
    _lyricsManager = null,
    { alreadySaved = null, attempt = 0 } = {}
) {
    const releaseDateStr =
        album.releaseDate || (tracks[0]?.streamStartDate ? tracks[0].streamStartDate.split('T')[0] : '');
    const releaseDate = releaseDateStr ? new Date(releaseDateStr) : null;
    const year = releaseDate && !isNaN(releaseDate.getTime()) ? releaseDate.getFullYear() : '';

    const folderName = formatPathTemplate(modernSettings.folderTemplate, {
        albumTitle: album.title,
        albumArtist: album.artist?.name,
        year: year,
    });

    const coverId = album.cover || album.album?.cover || album.coverId;
    await startBulkDownload({
        tracks,
        folderName,
        quality,
        type: 'album',
        name: album.title,
        subtitle: album.artist?.name || '',
        cover: coverId,
        metadata: album,
        api,
        // Looked up when the album's turn comes, so queueing stays instant.
        prepare: async () => ({
            tracks: await annotateTracksWithDiscInfo(tracks, api),
            coverBlob: await getCoverBlob(api, coverId),
        }),
        alreadySaved,
        attempt,
        source: { kind: 'album', id: album.id, provider: album.provider },
        retry: (saved, next) =>
            downloadAlbum(album, tracks, api, quality, null, { alreadySaved: saved, attempt: next }),
    });
}

export async function downloadPlaylist(
    playlist,
    tracks,
    api,
    quality,
    _lyricsManager = null,
    { alreadySaved = null, attempt = 0 } = {}
) {
    const folderName = formatPathTemplate(modernSettings.folderTemplate, {
        albumTitle: playlist.title,
        albumArtist: 'Playlist',
        year: new Date().getFullYear(),
    });

    const representativeTrack = tracks.find((t) => t.album?.cover);
    await startBulkDownload({
        tracks,
        folderName,
        quality,
        type: 'playlist',
        name: playlist.title,
        subtitle: 'Playlist',
        cover: representativeTrack?.album?.cover || null,
        metadata: playlist,
        api,
        prepare: async () => ({ coverBlob: await getCoverBlob(api, representativeTrack?.album?.cover) }),
        alreadySaved,
        attempt,
        retry: (saved, next) =>
            downloadPlaylist(playlist, tracks, api, quality, null, { alreadySaved: saved, attempt: next }),
    });
}

export async function downloadDiscography(
    artist,
    selectedReleases,
    api,
    quality,
    lyricsManager = null,
    { alreadySaved = null, attempt = 0 } = {}
) {
    const rootFolder = `${sanitizeForFilename(artist.name)} discography`;
    const abortController = new AbortController();
    const signal = abortController.signal;
    const stats = { failed: 0, total: 0, firstError: null };
    // Created when the job reaches the front of the queue.
    let notification = null;
    const queueWasBusy = isDownloadQueueBusy();
    // Tracks are only known per release, so items are added as each album loads.
    const jobId = startDownloadJob({
        kind: 'discography',
        title: artist.name,
        subtitle: `${selectedReleases.length} release${selectedReleases.length === 1 ? '' : 's'}`,
        cover: selectedReleases[0]?.cover || null,
        quality,
        folderName: rootFolder,
        source: {
            kind: 'discography',
            artist: { id: artist.id, name: artist.name },
            releases: selectedReleases.map((r) => ({ id: r.id, title: r.title, cover: r.cover || null })),
        },
        attempt,
        onCancel: () => abortController.abort(),
    });
    retryHandlers.set(jobId, (saved, next) =>
        downloadDiscography(artist, selectedReleases, api, quality, lyricsManager, {
            alreadySaved: saved,
            attempt: next,
        })
    );

    // Different versions of the same album (standard/deluxe) otherwise produce
    // identical folder paths and entry names. Disambiguate folders per
    // release and skip exact-duplicate entries (e.g. repeated cover.jpg).
    const seenFolders = new Set();
    const seenEntries = new Set();
    async function* dedupeEntries(generator) {
        for await (const entry of generator) {
            if (seenEntries.has(entry.name)) continue;
            seenEntries.add(entry.name);
            yield entry;
        }
    }

    async function* yieldDiscography() {
        for (let albumIndex = 0; albumIndex < selectedReleases.length; albumIndex++) {
            if (signal.aborted) break;
            const album = selectedReleases[albumIndex];
            let releaseListed = false;
            updateBulkDownloadProgress(notification, albumIndex, selectedReleases.length, album.title);

            try {
                const { album: fullAlbum, tracks: rawTracks } = await api.getAlbum(album.id);
                const tracks = await annotateTracksWithDiscInfo(rawTracks, api);
                const coverBlob = await getCoverBlob(api, fullAlbum.cover || album.cover);
                const releaseDateStr =
                    fullAlbum.releaseDate ||
                    (tracks[0]?.streamStartDate ? tracks[0].streamStartDate.split('T')[0] : '');
                const releaseDate = releaseDateStr ? new Date(releaseDateStr) : null;
                const year = releaseDate && !isNaN(releaseDate.getTime()) ? releaseDate.getFullYear() : '';

                const albumFolder = formatPathTemplate(modernSettings.folderTemplate, {
                    albumTitle: fullAlbum.title,
                    albumArtist: fullAlbum.artist?.name,
                    year: year,
                });

                let fullFolderPath = `${rootFolder}/${albumFolder}`;
                const versionSuffix = fullAlbum.version || String(fullAlbum.id ?? album.id ?? '');
                if (seenFolders.has(fullFolderPath) && versionSuffix) {
                    fullFolderPath = `${fullFolderPath} [${sanitizeForFilename(versionSuffix)}]`;
                }
                seenFolders.add(fullFolderPath);
                if (coverBlob && playlistSettings.shouldIncludeCover())
                    yield { name: `${fullFolderPath}/cover.jpg`, lastModified: new Date(), input: coverBlob };

                // Generate playlist files for each album
                const useRelativePaths = playlistSettings.shouldUseRelativePaths();
                const discLayout = await createDiscLayoutContext(tracks, api);

                // Download tracks, yielding each immediately and collecting actual paths for playlist generation.
                // Indexed by track so playlists/CUE stay aligned when a retry fills a gap.
                const trackPaths = new Array(tracks.length).fill(null);
                stats.total += tracks.length;
                const firstItem = addDownloadItems(jobId, tracks, fullAlbum.title);
                releaseListed = true;

                async function* runTrack(i) {
                    const track = tracks[i];
                    const savedPath = alreadySaved?.get(String(track.id));
                    if (savedPath) {
                        trackPaths[i] = relativeToFolder(savedPath, fullFolderPath);
                        updateDownloadItem(jobId, firstItem + i, { status: 'done', progress: 1, path: savedPath });
                        return true;
                    }
                    try {
                        trackPaths[i] = yield* downloadTrackFiles({
                            track,
                            index: i,
                            itemIndex: firstItem + i,
                            quality,
                            api,
                            signal,
                            lyricsManager,
                            folderPath: fullFolderPath,
                            discLayout,
                            jobId,
                        });
                        return true;
                    } catch (err) {
                        if (err?.name === 'AbortError' || signal.aborted) throw err;
                        if (!stats.firstError) stats.firstError = err?.message || String(err);
                        console.error(`Failed to download track ${track.title}:`, err);
                        updateDownloadItem(jobId, firstItem + i, {
                            status: 'failed',
                            progress: 0,
                            error: err?.message || String(err),
                            statusText: undefined,
                        });
                        return false;
                    }
                }

                // First pass: several tracks are fetched at once, written in order (see downloadTracksInOrder).
                const failedIndices = yield* downloadTracksInOrder(
                    tracks.map((_, i) => i),
                    {
                        signal,
                        concurrency: () => modernSettings.downloadConcurrency,
                        isSaved: (i) => alreadySaved?.has(String(tracks[i].id)) ?? false,
                        fetchOne: (i) =>
                            fetchTrack({
                                track: tracks[i],
                                itemIndex: firstItem + i,
                                quality,
                                api,
                                signal,
                                jobId,
                            }),
                        async *emitOne(i, fetched, saved) {
                            const track = tracks[i];
                            if (saved) {
                                const savedPath = alreadySaved.get(String(track.id));
                                trackPaths[i] = relativeToFolder(savedPath, fullFolderPath);
                                updateDownloadItem(jobId, firstItem + i, {
                                    status: 'done',
                                    progress: 1,
                                    path: savedPath,
                                });
                            } else {
                                trackPaths[i] = yield* emitTrackFiles({
                                    track,
                                    index: i,
                                    itemIndex: firstItem + i,
                                    fetched,
                                    quality,
                                    lyricsManager,
                                    folderPath: fullFolderPath,
                                    discLayout,
                                    jobId,
                                });
                            }
                        },
                        onFailure: (i, err) => {
                            if (!stats.firstError) stats.firstError = err?.message || String(err);
                            console.error(`Failed to download track ${tracks[i].title}:`, err);
                            updateDownloadItem(jobId, firstItem + i, {
                                status: 'failed',
                                progress: 0,
                                error: err?.message || String(err),
                                statusText: undefined,
                                speed: undefined,
                            });
                            const statusEl = notification.querySelector('.download-status');
                            if (statusEl) {
                                statusEl.textContent = `${album.title} · a track failed, retrying`;
                                statusEl.style.color = '#f59e0b';
                            }
                        },
                    }
                );
                if (failedIndices.length > 0 && !signal.aborted) {
                    yield* retryFailedTracks(failedIndices, runTrack, { signal, jobId, itemOffset: firstItem });
                }
                stats.failed += trackPaths.filter((path) => path === null).length;

                if (playlistSettings.shouldGenerateNFO()) {
                    const nfoContent = generateNFO(fullAlbum, tracks, 'album');
                    yield {
                        name: `${fullFolderPath}/${sanitizeForFilename(fullAlbum.title)}.nfo`,
                        lastModified: new Date(),
                        input: nfoContent,
                    };
                }

                if (playlistSettings.shouldGenerateJSON()) {
                    const jsonContent = generateJSON(fullAlbum, tracks, 'album');
                    yield {
                        name: `${fullFolderPath}/${sanitizeForFilename(fullAlbum.title)}.json`,
                        lastModified: new Date(),
                        input: jsonContent,
                    };
                }

                if (playlistSettings.shouldGenerateCUE()) {
                    const cueContent = generateCUE(fullAlbum, tracks, sanitizeForFilename(fullAlbum.title), trackPaths);
                    yield {
                        name: `${fullFolderPath}/${sanitizeForFilename(fullAlbum.title)}.cue`,
                        lastModified: new Date(),
                        input: cueContent,
                    };
                }

                // Generate m3u/m3u8 last, using actual track paths collected during download
                if (playlistSettings.shouldGenerateM3U()) {
                    const m3uContent = generateM3U(fullAlbum, tracks, useRelativePaths, null, 'flac', trackPaths);
                    yield {
                        name: `${fullFolderPath}/${sanitizeForFilename(fullAlbum.title)}.m3u`,
                        lastModified: new Date(),
                        input: m3uContent,
                    };
                }

                if (playlistSettings.shouldGenerateM3U8()) {
                    const m3u8Content = generateM3U8(fullAlbum, tracks, useRelativePaths, null, 'flac', trackPaths);
                    yield {
                        name: `${fullFolderPath}/${sanitizeForFilename(fullAlbum.title)}.m3u8`,
                        lastModified: new Date(),
                        input: m3u8Content,
                    };
                }
            } catch (error) {
                if (error?.name === 'AbortError' || signal.aborted) throw error;
                console.error(`Failed to download album ${album.title}:`, error);
                if (!stats.firstError) stats.firstError = error?.message || String(error);
                if (!releaseListed) {
                    // The release never loaded; list it so the failure shows on the Downloads page.
                    const placeholder = { id: album.id, title: album.title, artist: { name: artist.name } };
                    const index = addDownloadItems(jobId, [placeholder], album.title);
                    updateDownloadItem(jobId, index, { status: 'failed', error: error?.message || String(error) });
                    stats.failed += 1;
                }
            }
        }
    }

    let writer;
    try {
        writer = await createBulkWriter(rootFolder, `${artist.name} discography`);
    } catch (error) {
        finishDownloadJob(jobId, error?.name === 'AbortError' ? { cancelled: true } : { error: error?.message });
        if (error?.name !== 'AbortError')
            showNotification(`Couldn't start the discography download: ${error?.message}`);
        return;
    }
    if (!writer) {
        finishDownloadJob(jobId, { error: 'No download location is available' });
        return;
    }
    setDownloadDestination(jobId, describeDestination(writer, rootFolder));
    if (queueWasBusy) showNotification(`Added "${artist.name}" discography to the download queue`);

    enqueueDownloadJob(jobId, async () => {
        notification = createBulkDownloadNotification(
            'discography',
            artist.name,
            selectedReleases.length,
            abortController
        );
        try {
            await writer.write(dedupeEntries(yieldDiscography()));
            if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

            completeBulkDownload(notification, true, null, {
                failedTracks: stats.failed,
                totalTracks: stats.total,
            });
            settleJob(jobId, { error: stats.failed ? stats.firstError || undefined : undefined });
        } catch (error) {
            if (error?.name === 'AbortError' || signal.aborted) {
                removeBulkDownloadTask(notification);
                finishDownloadJob(jobId, { cancelled: true });
                return;
            }
            completeBulkDownload(notification, false, error?.message);
            settleJob(jobId, { error: error?.message || String(error) });
        }
    });
}

function createBulkDownloadNotification(type, name, _totalItems, abortController = new AbortController()) {
    const container = createDownloadNotification();

    const notifEl = document.createElement('div');
    notifEl.className = 'download-task bulk-download download-progress-popup';
    notifEl.dataset.bulkType = type;
    notifEl.dataset.bulkName = name;

    const typeLabel = (() => {
        switch (type) {
            case 'album':
                return 'Album';
            case 'playlist':
                return 'Playlist';
            case 'liked':
                return 'Liked Tracks';
            case 'queue':
                return 'Queue';
            case 'discography':
                return 'Discography';
            default:
                return '';
        }
    })();

    notifEl.innerHTML = `
        <div style="display: flex; align-items: start; gap: 0.75rem;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25rem;">
                    Downloading ${typeLabel}
                </div>
                <div style="font-size: 0.85rem; color: var(--muted-foreground); margin-bottom: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</div>
                <div class="download-progress-bar" style="height: 4px; background: var(--secondary); border-radius: 2px; overflow: hidden;">
                    <div class="download-progress-fill" style="width: 0%; height: 100%; background: var(--highlight); transition: width 0.2s;"></div>
                </div>
                <div class="download-status" style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Starting...</div>
            </div>
            <button class="download-cancel" style="background: transparent; border: none; color: var(--muted-foreground); cursor: pointer; padding: 4px; border-radius: 4px; transition: all 0.2s;">
                ${SVG_CLOSE(20)}
            </button>
        </div>
    `;

    container.appendChild(notifEl);

    bulkDownloadTasks.set(notifEl, { abortController });

    notifEl.querySelector('.download-cancel').addEventListener('click', () => {
        abortController.abort();
        removeBulkDownloadTask(notifEl);
    });

    return notifEl;
}

/**
 *
 * @param {HTMLElement} notifEl
 * @param {number} current
 * @param {number} total
 * @param {string} currentItem
 * @param {FfmpegProgress | ProgressMessage | null} progress
 * @returns
 */
function updateBulkDownloadProgress(notifEl, current, total, currentItem, progress = null) {
    /** @type {HTMLElement | null} */
    const progressFill = notifEl.querySelector('.download-progress-fill');

    /** @type {HTMLElement | null} */
    const statusEl = notifEl.querySelector('.download-status');

    if (!progressFill || !statusEl) {
        console.log('Progress elements not found in notification');
        return;
    }

    if (progress instanceof FfmpegProgress) {
        if (progress.stage == 'stdout' || progress.stage == 'parsing') {
            return;
        }

        const percent = progress.progress || 0;
        progressFill.style.width = `${percent}%`;
        progressFill.style.background = '#3b82f6'; // Blue for encoding
        statusEl.textContent = `Converting ${Math.floor(current + 1)}/${total}: ${Math.round(percent)}%`;
        return;
    }

    if (progress instanceof ProgressMessage) {
        statusEl.textContent = progress.message;
    }

    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    progressFill.style.background = 'var(--highlight)';
    statusEl.textContent = `${Math.floor(current + 1)}/${total} - ${currentItem}`;
}

function completeBulkDownload(notifEl, success = true, message = null, { failedTracks = 0, totalTracks = 0 } = {}) {
    const progressFill = notifEl.querySelector('.download-progress-fill');
    const statusEl = notifEl.querySelector('.download-status');

    const partial = success && failedTracks > 0;

    if (partial) {
        const succeeded = Math.max(0, totalTracks - failedTracks);
        progressFill.style.width = '100%';
        progressFill.style.background = '#f59e0b';
        statusEl.textContent = `warning: ${succeeded}/${totalTracks} downloaded - ${failedTracks} failed`;
        statusEl.style.color = '#f59e0b';

        setTimeout(() => {
            notifEl.style.animation = 'slide-out 0.3s ease forwards';
            setTimeout(() => notifEl.remove(), 300);
        }, 8000);
    } else if (success) {
        progressFill.style.width = '100%';
        progressFill.style.background = '#10b981';
        statusEl.textContent = '✓ Download complete';
        statusEl.style.color = '#10b981';

        setTimeout(() => {
            notifEl.style.animation = 'slide-out 0.3s ease forwards';
            setTimeout(() => notifEl.remove(), 300);
        }, 3000);
    } else {
        progressFill.style.background = '#ef4444';
        statusEl.textContent = message || '✗ Download failed';
        statusEl.style.color = '#ef4444';

        setTimeout(() => {
            notifEl.style.animation = 'slide-out 0.3s ease forwards';
            setTimeout(() => notifEl.remove(), 300);
        }, 5000);
    }
}

/**
 * Downloads a track with metadata and optionally lyrics.
 * @async
 * @param {Object} track - The track object to download
 * @param {string} quality - The desired audio quality for download
 * @param {MusicAPI | LosslessAPI} [api=MusicAPI.instance] - The API instance to use for downloading
 * @param {Object} [lyricsManager=null] - Optional manager for fetching and processing lyrics
 * @param {AbortController} [abortController=null] - Optional abort controller for cancelling the download
 * @returns {Promise<void>}
 * @throws {Error} If the download fails (except for AbortError)
 * @description
 * This function:
 * - Validates that a track is provided
 * - Prevents duplicate downloads of the same track
 * - Enriches track metadata via the API
 * - Downloads the audio blob with progress tracking
 * - Organizes the file into subfolders based on the folder template
 * - Optionally downloads and saves lyrics in LRC format
 * - Updates the local media folder cache if using LocalMedia download method
 * - Handles errors gracefully and updates download task status
 */
export async function downloadTrackWithMetadata(
    track,
    quality,
    api = MusicAPI.instance,
    lyricsManager = null,
    abortController = null,
    { attempt = 0 } = {}
) {
    if (!track) {
        alert('No track is currently playing');
        return;
    }

    /** @type {LosslessAPI} */
    const tidalAPI = api.tidalAPI || api;

    const downloadKey = `track-${track.id}`;
    if (ongoingDownloads.has(downloadKey)) {
        showNotification('This track is already being downloaded');
        return;
    }

    const controller = abortController || new AbortController();
    // Claim the operation before its first async lookup so rapid repeated clicks
    // cannot start multiple enrichments for the same track.
    ongoingDownloads.add(downloadKey);

    const queueWasBusy = isDownloadQueueBusy();
    const jobId = startDownloadJob({
        kind: 'track',
        title: getTrackTitle(track),
        subtitle: getTrackArtists(track),
        cover: track.album?.cover || null,
        quality,
        tracks: [track],
        source: { kind: 'track', id: track.id, provider: track.provider },
        attempt,
        onCancel: () => {
            controller.abort();
            ongoingDownloads.delete(downloadKey);
        },
    });
    retryHandlers.set(jobId, (_saved, next) =>
        downloadTrackWithMetadata(track, quality, api, lyricsManager, null, { attempt: next })
    );

    // Resolve the folder writer first, while the click that started the download
    // still counts as user activation for the permission prompt.
    let folderWriter;
    try {
        folderWriter = (await createSingleTrackFolderWriter()) || SequentialFileWriter;
    } catch (error) {
        console.warn('Could not open the download folder, using browser downloads:', error);
        folderWriter = SequentialFileWriter;
    }
    setDownloadDestination(jobId, describeDestination(folderWriter));
    if (queueWasBusy) showNotification(`Added "${getTrackTitle(track)}" to the download queue`);

    enqueueDownloadJob(jobId, () =>
        runTrackDownload({ track, quality, api, tidalAPI, lyricsManager, controller, downloadKey, jobId, folderWriter })
    );
}

/** The queued part of {@link downloadTrackWithMetadata}. */
async function runTrackDownload({
    track,
    quality,
    api,
    tidalAPI,
    lyricsManager,
    controller,
    downloadKey,
    jobId,
    folderWriter,
}) {
    if (controller.signal.aborted) {
        ongoingDownloads.delete(downloadKey);
        finishDownloadJob(jobId, { cancelled: true });
        return;
    }
    updateDownloadItem(jobId, 0, { status: 'downloading', progress: 0 });

    let enriched = null;
    try {
        enriched = await tidalAPI.enrichTrack(track, { downloadQuality: quality });
    } catch (error) {
        console.warn(`Enrichment failed before download (${friendlyEnrichError(error)}). Trying alternate sources.`);
    }
    const enrichedTrack = enriched?.enrichedTrack || track;
    const filename = buildTrackFilename(enrichedTrack, quality);

    try {
        addDownloadTask(track.id, enrichedTrack, filename, api, controller);

        // Download the blob (metadata already applied inside downloadTrack)
        const blob = await api.downloadTrack(track.id, quality, filename, {
            signal: controller.signal,
            track: enrichedTrack,
            enriched,
            onProgress: (progress) => {
                updateDownloadProgress(track.id, progress);
                const fraction = progressFraction(progress);
                if (fraction !== null) updateDownloadItem(jobId, 0, { progress: Math.min(fraction, 0.99) });
            },
            calculateDashBytes: true,
            triggerDownload: false,
        });

        const finalFilename = buildTrackFilename(track, quality, await getExtensionFromBlob(blob))
            .split('/')
            .pop();

        // Compute a subfolder path using the same template as bulk downloads so
        // the track lands in e.g. "Album Title - Artist/" instead of the folder root.
        const releaseDateStr =
            enrichedTrack.album?.releaseDate ||
            (enrichedTrack.streamStartDate ? enrichedTrack.streamStartDate.split('T')[0] : '');
        const releaseDate = releaseDateStr ? new Date(releaseDateStr) : null;
        const releaseYear = releaseDate && !isNaN(releaseDate.getTime()) ? releaseDate.getFullYear() : '';
        const subFolder = formatPathTemplate(modernSettings.folderTemplate, {
            albumTitle: enrichedTrack.album?.title,
            albumArtist: enrichedTrack.album?.artist?.name || enrichedTrack.artist?.name,
            year: releaseYear,
        });
        const entryName = subFolder ? `${subFolder}/${finalFilename}` : finalFilename;

        // Write to folder using IBulkDownloadWriter.write() via singleWriterEntry().
        await folderWriter.write(singleWriterEntry({ name: entryName, lastModified: new Date(), input: blob }));
        updateDownloadItem(jobId, 0, { status: 'done', progress: 1, bytes: blob.size, path: entryName });

        // Album art next to the track, like album downloads do.
        const savesToFolder = folderWriter instanceof FolderPickerWriter || folderWriter instanceof DesktopFolderWriter;
        if (savesToFolder && subFolder && playlistSettings.shouldIncludeCover()) {
            try {
                const coverBlob = await getCoverBlob(api, enrichedTrack.album?.cover);
                if (coverBlob) {
                    await folderWriter.write(
                        singleWriterEntry({
                            name: `${subFolder}/cover.jpg`,
                            lastModified: new Date(),
                            input: coverBlob,
                        })
                    );
                }
            } catch (error) {
                console.warn('Could not save album art for track:', error);
            }
        }

        if (lyricsManager && lyricsSettings.shouldDownloadLyrics()) {
            try {
                const lyricsData = await lyricsManager.fetchLyrics(track.id, track);
                if (lyricsData) {
                    await folderWriter.write(
                        singleWriterEntry({
                            name: [...entryName.split('.').slice(0, -1), 'lrc'].join('.'),
                            lastModified: new Date(),
                            input: lyricsManager.getLRC(lyricsData, track),
                        })
                    );
                    const ttmlFile = lyricsManager.getTTML(lyricsData, track);
                    if (ttmlFile) {
                        await folderWriter.write(
                            singleWriterEntry({
                                name: [...entryName.split('.').slice(0, -1), 'ttml'].join('.'),
                                lastModified: new Date(),
                                input: ttmlFile,
                            })
                        );
                    }
                }
            } catch {
                console.log('Could not download lyrics for track');
            }
        }

        // If the target is the local media folder, do a cheap partial update:
        // pass the downloaded blob and base filename so only this one track's metadata
        // is read and inserted into localFilesCache instead of re-walking the whole folder.
        if (modernSettings.bulkDownloadMethod === BulkDownloadMethod.LocalMedia) {
            window.refreshLocalMediaFolder?.(blob, finalFilename);
        }

        completeDownloadTask(track.id, true);
        finishDownloadJob(jobId);
    } catch (error) {
        if (error.name !== 'AbortError') {
            const errorMsg =
                error.message === RATE_LIMIT_ERROR_MESSAGE ? error.message : 'Download failed. Please try again.';
            completeDownloadTask(track.id, false, errorMsg);
            updateDownloadItem(jobId, 0, { status: 'failed', progress: 0, error: error?.message || String(error) });
            settleJob(jobId, { error: error?.message || String(error) });
        } else {
            finishDownloadJob(jobId, { cancelled: true });
        }
    } finally {
        ongoingDownloads.delete(downloadKey);
    }
}

export async function downloadLikedTracks(
    tracks,
    api,
    quality,
    _lyricsManager = null,
    { alreadySaved = null, attempt = 0 } = {}
) {
    const folderName = `Liked Tracks - ${new Date().toISOString().slice(0, 10)}`;
    await startBulkDownload({
        tracks,
        folderName,
        quality,
        type: 'liked',
        name: 'Liked Tracks',
        subtitle: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
        api,
        alreadySaved,
        attempt,
        retry: (saved, next) => downloadLikedTracks(tracks, api, quality, null, { alreadySaved: saved, attempt: next }),
    });
}

/**
 * Downloads again whatever a finished job did not save, into the same
 * folder. Tracks it already saved are skipped but kept in playlist files.
 * Works for jobs from earlier sessions too, by looking the tracks up again.
 * The old job is only replaced once the new one is queued, so a failed
 * lookup (offline, say) leaves it in place to be retried again.
 */
export async function retryDownloadJob(jobId, api = MusicAPI.instance, { auto = false } = {}) {
    const job = getDownloadJobs().find((j) => j.id === jobId);
    if (!job || job.status === 'active' || job.status === 'queued') return;

    const alreadySaved = new Map(
        job.items
            .filter((item) => item.status === 'done' && item.path)
            .map((item) => [String(item.track.id), item.path])
    );
    const quality = job.quality || downloadQualitySettings.getQuality();
    const lyricsManager = LyricsManager.instance;
    const source = job.source || { kind: 'tracks' };
    // Automatic retries count up so the pauses between them grow; a manual retry starts over.
    const attempt = auto ? (job.attempt || 0) + 1 : 0;

    // IDs from the monochrome catalog only resolve with their prefix once the in-memory catalog cache is gone.
    const qualify = (id, type, provider) =>
        provider === 'tracks' && !String(id).startsWith('tracks:') ? `tracks:${type}:${id}` : id;
    const replaceJob = () => {
        removeDownloadJob(jobId);
        retryHandlers.delete(jobId);
    };

    const retry = retryHandlers.get(jobId);
    if (retry) {
        replaceJob();
        return retry(alreadySaved, attempt);
    }

    if (source.kind === 'track') {
        const item = job.items[0];
        const track = await api.getTrackMetadata(
            qualify(source.id ?? item?.track.id, 'track', source.provider ?? item?.track.provider)
        );
        replaceJob();
        return downloadTrackWithMetadata(track, quality, api, lyricsManager, null, { attempt });
    }
    if (source.kind === 'album' && source.id != null) {
        const { album, tracks } = await api.getAlbum(qualify(source.id, 'album', source.provider));
        replaceJob();
        return downloadAlbum(album, tracks, api, quality, null, { alreadySaved, attempt });
    }
    if (source.kind === 'discography' && source.artist && source.releases?.length) {
        replaceJob();
        return downloadDiscography(source.artist, source.releases, api, quality, lyricsManager, {
            alreadySaved,
            attempt,
        });
    }

    const tracks = [];
    for (const item of job.items) {
        // A failed lookup throws: the job stays, and the caller retries later.
        tracks.push(await api.getTrackMetadata(qualify(item.track.id, 'track', item.track.provider)));
    }
    if (tracks.length === 0) return;
    replaceJob();
    await startBulkDownload({
        tracks,
        folderName: job.folderName || sanitizeForFilename(job.title),
        quality,
        type: job.kind === 'track' ? 'queue' : job.kind,
        name: job.title,
        subtitle: job.subtitle,
        cover: job.cover,
        metadata: { title: job.title },
        api,
        alreadySaved,
        attempt,
    });
}
