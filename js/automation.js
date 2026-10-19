//js/automation.js
import { MusicAPI } from './music-api.js';
import { LyricsManager } from './lyrics.js';
import { downloadQualitySettings } from './storage.js';
import {
    fellBackTo16Bit,
    getDownloadJobs,
    cancelDownloadJob,
    clearFinishedDownloads,
    queuePosition,
    summarizeJob,
} from './download-manager.ts';
import { desktop } from './desktop-bridge.ts';

/**
 * Commands for the bundled MCP server (mcp/server.mjs), answered inside the
 * desktop app so they use the app's own search, queue, retries and folder
 * layout. Only registered in the desktop app.
 */

// ── Matching ─────────────────────────────────────────────────────────────────

/** Separators people use between artist and album: "Artist - Album", "Artist – Album", "Artist: Album". */
const ARTIST_ALBUM_SEPARATOR = /\s+[-–—]\s+|\s*:\s+/;

/**
 * Turns one line of a user's list into { artist, title }. Accepts
 * "Artist - Album", "Album by Artist", or just "Album".
 */
export function parseAlbumRequest(input) {
    if (input && typeof input === 'object') {
        return { artist: String(input.artist || '').trim(), title: String(input.title || input.album || '').trim() };
    }
    const text = String(input || '')
        .replace(/^\s*(?:\d+[.)]\s+|[-*•]\s+)/, '') // list markers: "1. ", "- ", "• "
        .trim();
    const parts = text.split(ARTIST_ALBUM_SEPARATOR);
    if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    const by = text.match(/^(.+?)\s+by\s+(.+)$/i);
    if (by) return { artist: by[2].trim(), title: by[1].trim() };
    return { artist: '', title: text };
}

/** Edition and remaster tags that should not stop a match. */
const EDITION_WORDS =
    /\b(deluxe|expanded|anniversary|remaster(?:ed)?|edition|version|bonus|tracks?|special|collector'?s|super|reissue|\d{4})\b/g;

export function normalizeName(value, { dropEditions = false } = {}) {
    let text = String(value || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ');
    if (dropEditions) text = text.replace(/[([][^)\]]*[)\]]/g, ' ').replace(EDITION_WORDS, ' ');
    return text
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(the|a|an)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const left = new Set(a.split(' '));
    const right = new Set(b.split(' '));
    let shared = 0;
    for (const token of left) if (right.has(token)) shared++;
    return (2 * shared) / (left.size + right.size);
}

function albumArtistName(album) {
    return album?.artist?.name || album?.artists?.map((a) => a?.name).join(', ') || '';
}

/** 0..1 confidence that `album` is what the request asked for. */
export function scoreAlbum(request, album) {
    const wantedTitle = normalizeName(request.title);
    const title = normalizeName(album?.title);
    let titleScore = tokenSimilarity(wantedTitle, title);
    // "OK Computer" should still match "OK Computer (Remastered)" or "OK Computer OKNOTOK 1997 2017".
    const looseScore = tokenSimilarity(
        normalizeName(request.title, { dropEditions: true }),
        normalizeName(album?.title, { dropEditions: true })
    );
    titleScore = Math.max(titleScore, looseScore * 0.95);

    if (!request.artist) return titleScore;
    const wantedArtist = normalizeName(request.artist);
    const artists = [album?.artist, ...(album?.artists || [])].filter(Boolean).map((a) => normalizeName(a.name));
    const artistScore = Math.max(0, ...artists.map((name) => tokenSimilarity(wantedArtist, name)));
    return 0.6 * titleScore + 0.4 * artistScore;
}

function describeAlbum(album, score) {
    const year = (album?.releaseDate || '').slice(0, 4);
    return {
        id: album?.id,
        title: album?.version ? `${album.title} (${album.version})` : album?.title,
        artist: albumArtistName(album),
        year: year || undefined,
        tracks: album?.numberOfTracks || undefined,
        type: album?.type,
        quality: album?.audioQuality || album?.mediaMetadata?.tags?.join(', '),
        explicit: album?.explicit || undefined,
        provider: album?.provider || undefined,
        ...(score !== undefined ? { confidence: Math.round(score * 100) / 100 } : {}),
    };
}

/**
 * Best candidate for a request, or null when nothing is close enough or two
 * different releases are too close to call.
 */
export function pickBestMatch(request, albums, minConfidence = 0.75) {
    const ranked = albums
        .map((album) => ({ album, score: scoreAlbum(request, album) }))
        .sort((a, b) => b.score - a.score || (b.album?.numberOfTracks || 0) - (a.album?.numberOfTracks || 0));
    const [best] = ranked;
    if (!best || best.score < minConfidence) return { match: null, ranked };

    const contenders = ranked.filter((entry) => best.score - entry.score < 0.05);
    if (contenders.length === 1) return { match: best, ranked };
    // Editions of the same album (remaster, deluxe, explicit/clean) are not a real
    // choice: take the one closest to what was asked, standard edition first.
    if (contenders.every((entry) => sameAlbum(entry.album, best.album))) {
        return { match: contenders.sort((a, b) => compareEditions(request, a.album, b.album))[0], ranked };
    }
    return { match: null, ranked, ambiguous: true };
}

function sameAlbum(a, b) {
    return (
        normalizeName(a?.title, { dropEditions: true }) === normalizeName(b?.title, { dropEditions: true }) &&
        normalizeName(albumArtistName(a)) === normalizeName(albumArtistName(b))
    );
}

const EXTRA_EDITION = /\b(deluxe|super|expanded|anniversary|bonus|collector|special|live|demos?)\b/g;

function compareEditions(request, a, b) {
    const wanted = normalizeName(request.title);
    const closeness = (album) => tokenSimilarity(wanted, normalizeName(album?.title));
    const extras = (album) =>
        (normalizeName(`${album?.title} ${album?.version || ''}`).match(EXTRA_EDITION) || []).length;
    const year = (album) => Number((album?.releaseDate || '').slice(0, 4)) || 9999;
    return closeness(b) - closeness(a) || extras(a) - extras(b) || year(a) - year(b);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function api() {
    return MusicAPI.instance;
}

async function searchAlbums(query, limit = 10) {
    const result = await api().searchAlbums(query, { limit });
    return (result?.items || result || []).slice(0, limit);
}

function jobSummary(job, jobs) {
    const { done, failed, total } = summarizeJob(job);
    const fellBack = job.items.filter((item) => fellBackTo16Bit(job, item)).length;
    return {
        jobId: job.id,
        kind: job.kind,
        title: job.title,
        artist: job.subtitle || undefined,
        status: job.status,
        tracksDone: done,
        tracksFailed: failed,
        ...(fellBack ? { tracksSavedIn16BitBecauseNoHiRes: fellBack } : {}),
        tracksTotal: total,
        ...(job.status === 'queued' ? { queuePosition: queuePosition(job.id, jobs) } : {}),
        ...(failed
            ? {
                  failures: job.items
                      .filter((item) => item.status === 'failed')
                      .map((item) => ({ track: item.track.title, error: item.error })),
              }
            : {}),
        ...(job.autoRetryAt ? { retryingAutomaticallyAt: new Date(job.autoRetryAt).toISOString() } : {}),
        ...(job.error ? { error: job.error } : {}),
    };
}

/** Albums already waiting, running or saved (album ID -> job), so a long list doesn't queue duplicates. */
function knownAlbumJobs() {
    const known = new Map();
    for (const job of [...getDownloadJobs()].reverse()) {
        const usable = job.status !== 'failed' && job.status !== 'cancelled';
        if (job.source?.kind === 'album' && job.source.id != null && usable) known.set(String(job.source.id), job);
    }
    return known;
}

async function queueAlbum(albumId, quality, provider) {
    const { downloadAlbum } = await import('./downloads.js');
    const { album, tracks } = await api().getAlbum(albumId, provider || null);
    if (!tracks?.length) throw new Error(`Album ${albumId} has no downloadable tracks`);
    await downloadAlbum(album, tracks, api(), quality, LyricsManager.instance);
    const job = getDownloadJobs().find((j) => j.source?.kind === 'album' && String(j.source.id) === String(albumId));
    return { jobId: job?.id, ...describeAlbum(album) };
}

const commands = {
    async status() {
        const jobs = getDownloadJobs();
        return {
            downloadDir: await desktop?.getDownloadDir(),
            defaultQuality: downloadQualitySettings.getQuality(),
            running: jobs.filter((j) => j.status === 'active').length,
            queued: jobs.filter((j) => j.status === 'queued').length,
            jobs: jobs.slice(0, 50).map((job) => jobSummary(job, jobs)),
        };
    },

    async search_albums({ query, limit = 8 }) {
        if (!query) throw new Error('query is required');
        const request = parseAlbumRequest(query);
        const albums = await searchAlbums(query, Math.min(Number(limit) || 8, 25));
        return albums.map((album) => describeAlbum(album, scoreAlbum(request, album)));
    },

    async download_album({ albumId, quality, provider }) {
        if (albumId == null) throw new Error('albumId is required');
        return queueAlbum(albumId, quality || downloadQualitySettings.getQuality(), provider);
    },

    async find_and_download_albums({ albums, quality, minConfidence = 0.75, dryRun = false }) {
        const list = Array.isArray(albums) ? albums : String(albums || '').split(/\r?\n/);
        const requests = list.map((entry) => ({ input: entry, ...parseAlbumRequest(entry) })).filter((r) => r.title);
        const chosenQuality = quality || downloadQualitySettings.getQuality();
        const alreadyHave = knownAlbumJobs();
        const result = { queued: [], alreadyQueued: [], needsChoice: [], notFound: [], errors: [] };

        for (const request of requests) {
            const label =
                typeof request.input === 'string' ? request.input.trim() : `${request.artist} - ${request.title}`;
            try {
                const query = request.artist ? `${request.artist} ${request.title}` : request.title;
                let candidates = await searchAlbums(query, 10);
                // Searching artist + title can bury the album under the artist's other releases; try the title alone.
                if (request.artist && !pickBestMatch(request, candidates, minConfidence).match) {
                    const byTitle = await searchAlbums(request.title, 10);
                    const seen = new Set(candidates.map((a) => String(a.id)));
                    candidates = [...candidates, ...byTitle.filter((a) => !seen.has(String(a.id)))];
                }

                const { match, ranked, ambiguous } = pickBestMatch(request, candidates, minConfidence);
                if (!match) {
                    const options = ranked.slice(0, 5).map(({ album, score }) => describeAlbum(album, score));
                    if (options.length && (ambiguous || options[0].confidence >= 0.5)) {
                        result.needsChoice.push({
                            request: label,
                            reason: ambiguous ? 'ambiguous' : 'low confidence',
                            options,
                        });
                    } else {
                        result.notFound.push({ request: label });
                    }
                    continue;
                }

                const albumId = String(match.album.id);
                const existing = alreadyHave.get(albumId);
                if (existing) {
                    // A partial job can be finished with retry_download.
                    result.alreadyQueued.push({
                        request: label,
                        ...describeAlbum(match.album, match.score),
                        jobId: existing.id || undefined,
                        status: existing.status,
                    });
                    continue;
                }
                alreadyHave.set(albumId, { id: null, status: dryRun ? 'dry run' : 'queued' });
                if (dryRun) {
                    result.queued.push({ request: label, dryRun: true, ...describeAlbum(match.album, match.score) });
                } else {
                    const queued = await queueAlbum(albumId, chosenQuality, match.album.provider);
                    result.queued.push({ request: label, ...queued, confidence: Math.round(match.score * 100) / 100 });
                }
            } catch (error) {
                result.errors.push({ request: label, error: error?.message || String(error) });
            }
        }
        return result;
    },

    async cancel_download({ jobId }) {
        if (jobId === 'all') {
            const { cancelAllDownloads } = await import('./download-manager.ts');
            cancelAllDownloads();
            return { cancelled: 'all' };
        }
        cancelDownloadJob(jobId);
        return { cancelled: jobId };
    },

    async retry_download({ jobId }) {
        const { retryDownloadJob } = await import('./downloads.js');
        await retryDownloadJob(jobId);
        return { retried: jobId };
    },

    async clear_finished() {
        clearFinishedDownloads();
        return { cleared: true };
    },
};

/** Answers MCP requests relayed by the desktop app. No-op in a browser. */
export function registerAutomation() {
    if (!desktop) return;
    desktop.onAutomationRequest(async (method, params) => {
        const command = commands[method];
        if (!command) throw new Error(`Unknown command: ${method}`);
        return command(params || {});
    });
}
