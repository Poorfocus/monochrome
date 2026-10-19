//js/source-benchmark.js
//
// Measures how fast each stream host serves one real track, so you can see
// which to prefer. No browser or app dependencies: runs in Node (see
// scripts/bench-hosts.mjs) and in the app.

const DEFAULT_ISRC = 'GBDUW0000053'; // Daft Punk - One More Time
const DEFAULT_CATALOG_ID = '155102871061270528'; // the same track in the monochrome catalog
const MONOCHROME_SERVER = 'https://tracks.monochrome.st';

/** First value stored under `key` anywhere in a JSON-like structure. */
function findValue(node, key) {
    if (!node || typeof node !== 'object') return null;
    if (node[key] != null) return node[key];
    for (const value of Object.values(node)) {
        const found = findValue(value, key);
        if (found != null) return found;
    }
    return null;
}

function firstWithId(node) {
    if (Array.isArray(node)) {
        for (const item of node) if (item && typeof item === 'object' && item.id != null) return item;
        return null;
    }
    if (!node || typeof node !== 'object') return null;
    return firstWithId(node.items) || firstWithId(node.data) || firstWithId(node.tracks);
}

/** Direct audio link from a host's /track/ response, or { dash: true } for hi-res DASH manifests. */
export function extractAudioUrl(trackResponse) {
    const original = findValue(trackResponse, 'OriginalTrackUrl');
    if (typeof original === 'string') return { url: original };

    const manifest = findValue(trackResponse, 'manifest');
    if (typeof manifest !== 'string') return { error: 'no stream link in the response' };

    let decoded = manifest;
    try {
        decoded = atob(manifest);
    } catch {
        // already plain text
    }
    if (decoded.includes('<MPD')) return { dash: true, error: 'hi-res DASH manifest (try quality LOSSLESS)' };
    try {
        const urls = JSON.parse(decoded)?.urls;
        if (Array.isArray(urls) && urls[0]) return { url: urls[0] };
    } catch {
        // fall through to a plain-text scan
    }
    const match = decoded.match(/https?:\/\/[^\s"'<>]+/);
    return match ? { url: match[0] } : { error: 'no stream link in the manifest' };
}

async function timedJson(fetchImpl, url, timeoutMs) {
    const started = performance.now();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    return { json, ms: performance.now() - started };
}

/** Downloads up to `bytes` from `url` and returns { mbps, firstByteMs, bytes }. */
export async function measureDownload(url, { bytes, timeoutMs, fetchImpl = fetch }) {
    const started = performance.now();
    const response = await fetchImpl(url, {
        headers: { Range: `bytes=0-${bytes - 1}` },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    let received = 0;
    let firstByteAt = null;
    while (received < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        firstByteAt ??= performance.now();
        received += value.byteLength;
    }
    reader.cancel().catch(() => {});

    const end = performance.now();
    if (!received) throw new Error('empty response');
    const transferMs = Math.max(end - (firstByteAt ?? started), 1);
    return {
        bytes: received,
        firstByteMs: (firstByteAt ?? end) - started,
        // Speed once data is flowing, so slow connection setup doesn't hide a fast host.
        mbps: received / 1048576 / (transferMs / 1000),
    };
}

/** One HiFi host: ISRC -> TIDAL ID -> stream link -> download speed. */
export async function benchmarkHifiHost(
    baseUrl,
    { isrc = DEFAULT_ISRC, quality = 'LOSSLESS', bytes = 8 * 1048576, timeoutMs = 25000, fetchImpl = fetch } = {}
) {
    const host = baseUrl.replace(/\/+$/, '');
    const result = { host, kind: 'hifi' };
    try {
        const search = await timedJson(fetchImpl, `${host}/search/?i=${encodeURIComponent(isrc)}`, timeoutMs);
        result.searchMs = search.ms;
        const track = firstWithId(search.json);
        if (!track) throw new Error('ISRC not found');

        const lookup = await timedJson(
            fetchImpl,
            `${host}/track/?id=${encodeURIComponent(track.id)}&quality=${encodeURIComponent(quality)}`,
            timeoutMs
        );
        result.lookupMs = lookup.ms;
        const audio = extractAudioUrl(lookup.json);
        if (!audio.url) throw new Error(audio.error);

        result.cdn = new URL(audio.url).host;
        Object.assign(result, await measureDownload(audio.url, { bytes, timeoutMs, fetchImpl }));
        result.ok = true;
    } catch (error) {
        result.ok = false;
        result.error = error?.name === 'TimeoutError' ? 'timed out' : error?.message || String(error);
    }
    return result;
}

/** The monochrome server's own stream for the same track. */
export async function benchmarkMonochromeServer({
    catalogId = DEFAULT_CATALOG_ID,
    bytes = 8 * 1048576,
    timeoutMs = 25000,
    fetchImpl = fetch,
} = {}) {
    const result = { host: MONOCHROME_SERVER, kind: 'monochrome' };
    try {
        Object.assign(
            result,
            await measureDownload(`${MONOCHROME_SERVER}/track/${catalogId}`, { bytes, timeoutMs, fetchImpl })
        );
        result.ok = true;
    } catch (error) {
        result.ok = false;
        result.error = error?.name === 'TimeoutError' ? 'timed out' : error?.message || String(error);
    }
    return result;
}

/** Hosts from instances.json (the streaming list first), de-duplicated. */
export function listHifiHosts(instances) {
    const seen = new Set();
    const hosts = [];
    for (const url of [...(instances?.streaming || []), ...(instances?.api || [])]) {
        const host = String(url).replace(/\/+$/, '');
        if (host && !seen.has(host)) {
            seen.add(host);
            hosts.push(host);
        }
    }
    return hosts;
}

/** Fastest working host first, then slower ones, then failures. */
export function rankResults(results) {
    return [...results].sort((a, b) => (b.ok ? b.mbps : -1) - (a.ok ? a.mbps : -1));
}
