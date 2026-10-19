import { beforeEach, describe, expect, test, vi } from 'vitest';

const deezerSettings = { enabled: false, baseUrl: 'https://deezer.example' };

vi.mock('../utils.js', () => ({
    RATE_LIMIT_ERROR_MESSAGE: 'rate limited',
    deriveTrackQuality: vi.fn(),
    delay: vi.fn(() => Promise.resolve()),
    isTrackUnavailable: vi.fn(() => false),
    getExtensionFromBlob: vi.fn(),
    getTrackDiscNumber: vi.fn(),
    normalizeQualityToken: vi.fn((quality) => quality),
    isAtmosQuality: vi.fn((quality) => String(quality || '').startsWith('DOLBY_ATMOS_')),
    isAc4AtmosQuality: vi.fn((quality) => String(quality || '').startsWith('DOLBY_ATMOS_AC4_')),
    getTrackCoverId: vi.fn(),
    getCoverBlob: vi.fn(),
}));

vi.mock('../ModernSettings.js', () => ({
    modernSettings: { downloadSourcePreference: 'auto' },
}));

vi.mock('../storage.js', () => ({
    preferDolbyAtmosSettings: { isEnabled: vi.fn(() => false) },
    trackDateSettings: { useAlbumYear: vi.fn(() => false) },
    devModeSettings: { isEnabled: vi.fn(() => false), getUrl: vi.fn(() => '') },
    unifiedPlaybackSettings: {
        isEnabled: vi.fn(() => false),
        getApiBaseUrl: vi.fn(() => 'https://unified.example'),
        getApiToken: vi.fn(() => ''),
    },
    deezerFallbackSettings: {
        isEnabled: vi.fn(() => deezerSettings.enabled),
        getApiBaseUrl: vi.fn(() => deezerSettings.baseUrl),
    },
}));

vi.mock('../dash-downloader.ts', () => ({ DashDownloader: class {} }));
vi.mock('../hls-downloader.js', () => ({ HlsDownloader: class {} }));
vi.mock('../proxy-utils.js', () => ({
    getProxyUrl: vi.fn((url) => url),
    wrapTidalUrl: vi.fn((url) => url),
    fetchDownload: vi.fn((url, { attempts: _attempts, ...init } = {}) => fetch(url, init)),
}));
vi.mock('../ffmpeg.js', () => ({ loadFfmpeg: vi.fn(), FfmpegError: class extends Error {}, ffmpeg: vi.fn() }));
vi.mock('../download-utils.ts', () => ({ triggerDownload: vi.fn(), applyAudioPostProcessing: vi.fn() }));
vi.mock('../ffmpegFormats.ts', () => ({ isCustomFormat: vi.fn(() => false) }));
vi.mock('../progressEvents.js', () => ({ DownloadProgress: class {} }));
vi.mock('../readableStreamIterator.js', () => ({ readableStreamIterator: vi.fn() }));
vi.mock('../HiFi.ts', () => ({ HiFiClient: { instance: { query: vi.fn() } }, TidalResponse: class {} }));
vi.mock('../platform-detection.js', () => ({
    isIos: false,
    isSafari: false,
    isChrome: true,
    canBrowserStreamAtmosQuality: vi.fn(() => true),
}));
vi.mock('../container-classes.js', () => ({
    TrackAlbum: class {},
    EnrichedAlbum: class {},
    EnrichedTrack: class {},
    ReplayGain: class {},
    PlaybackInfo: class {},
    Track: class {},
    Album: class {},
    PreparedVideo: class {},
    PreparedTrack: class {},
}));

const { LosslessAPI } = await import('../api.js');
const { modernSettings } = await import('../ModernSettings.js');
const { tracksStreamerAPI } = await import('../tracks-api.js');

const CATALOG_ID = '155102871061270528';
const ISRC = 'GBDUW0000053';
const catalogTrack = { id: CATALOG_ID, provider: 'tracks', isrc: ISRC, title: 'One More Time' };

async function collect(api, id, track, prepared = null) {
    const labels = [];
    for await (const source of api.iterateDownloadSources(id, 'LOSSLESS', track, prepared, new Set())) {
        labels.push(`${source.label}:${source.url}`);
    }
    return labels;
}

describe('download sources', () => {
    let api;

    beforeEach(() => {
        api = new LosslessAPI({});
        modernSettings.downloadSourcePreference = 'auto';
        vi.spyOn(tracksStreamerAPI, 'resolveTrackStream').mockResolvedValue({
            url: `https://tracks.example/track/${CATALOG_ID}`,
            playbackType: 'direct',
        });
        vi.spyOn(api, 'getUnifiedPlaybackStreamUrl').mockResolvedValue(null);
    });

    describe('resolveTidalTrackId', () => {
        test('TIDAL IDs pass straight through', async () => {
            const search = vi.spyOn(api, 'searchTracksByIsrc');
            expect(await api.resolveTidalTrackId('12345678', { id: '12345678' })).toBe('12345678');
            expect(search).not.toHaveBeenCalled();
        });

        test('catalog IDs are mapped through the ISRC, preferring the track with that ISRC', async () => {
            const search = vi.spyOn(api, 'searchTracksByIsrc').mockResolvedValue({
                items: [
                    { id: 111, isrc: 'OTHER0000001' },
                    { id: 222, isrc: ISRC.toLowerCase() },
                ],
            });
            expect(await api.resolveTidalTrackId(CATALOG_ID, catalogTrack)).toBe('222');
            // The answer is remembered for the rest of the session.
            expect(await api.resolveTidalTrackId(`tracks:track:${CATALOG_ID}`, catalogTrack)).toBe('222');
            expect(search).toHaveBeenCalledTimes(1);
        });

        test('a catalog track without an ISRC cannot be mapped', async () => {
            expect(await api.resolveTidalTrackId(CATALOG_ID, { id: CATALOG_ID, provider: 'tracks' })).toBeNull();
        });
    });

    describe('order', () => {
        beforeEach(() => {
            vi.spyOn(api, 'searchTracksByIsrc').mockResolvedValue({ items: [{ id: 222, isrc: ISRC }] });
            vi.spyOn(api, 'getTrack').mockResolvedValue({
                originalTrackUrl: 'https://cdn.example/222.flac',
                info: { audioQuality: 'LOSSLESS' },
            });
        });

        test('automatic: monochrome server first, then the HiFi hosts using the TIDAL ID', async () => {
            expect(await collect(api, CATALOG_ID, catalogTrack)).toEqual([
                `monochrome:https://tracks.example/track/${CATALOG_ID}`,
                'streaming-api:https://cdn.example/222.flac',
            ]);
            expect(api.getTrack).toHaveBeenCalledWith('222', 'LOSSLESS');
        });

        test('hifi-first: HiFi hosts before the monochrome server', async () => {
            modernSettings.downloadSourcePreference = 'hifi-first';
            expect(await collect(api, CATALOG_ID, catalogTrack)).toEqual([
                'streaming-api:https://cdn.example/222.flac',
                `monochrome:https://tracks.example/track/${CATALOG_ID}`,
            ]);
        });

        test('a failing HiFi lookup does not stop the other sources', async () => {
            modernSettings.downloadSourcePreference = 'hifi-first';
            api.getTrack.mockRejectedValue(new Error('all hosts failed'));
            expect(await collect(api, CATALOG_ID, catalogTrack)).toEqual([
                `monochrome:https://tracks.example/track/${CATALOG_ID}`,
            ]);
        });

        test('a plain TIDAL track uses its own ID on the HiFi hosts', async () => {
            await collect(api, '98765432', { id: '98765432', isrc: ISRC });
            expect(api.getTrack).toHaveBeenCalledWith('98765432', 'LOSSLESS');
            expect(api.searchTracksByIsrc).not.toHaveBeenCalled();
        });
    });
});
