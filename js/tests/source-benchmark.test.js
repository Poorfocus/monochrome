import { describe, expect, test } from 'vitest';
import {
    benchmarkHifiHost,
    extractAudioUrl,
    listHifiHosts,
    measureDownload,
    rankResults,
} from '../source-benchmark.js';

const b64 = (value) => btoa(JSON.stringify(value));

function stream(totalBytes) {
    let sent = 0;
    return new ReadableStream({
        pull(controller) {
            if (sent >= totalBytes) return controller.close();
            const chunk = Math.min(65536, totalBytes - sent);
            sent += chunk;
            controller.enqueue(new Uint8Array(chunk));
        },
    });
}

describe('extractAudioUrl', () => {
    test('prefers OriginalTrackUrl', () => {
        expect(
            extractAudioUrl([{ duration: 1 }, { manifest: 'x' }, { OriginalTrackUrl: 'https://cdn/a.flac' }])
        ).toEqual({
            url: 'https://cdn/a.flac',
        });
    });

    test('reads the stream link from a base64 manifest, also inside {data}', () => {
        const manifest = b64({ urls: ['https://cdn/b.flac'] });
        expect(extractAudioUrl({ data: { manifest } })).toEqual({ url: 'https://cdn/b.flac' });
    });

    test('flags DASH manifests and empty responses', () => {
        expect(extractAudioUrl({ manifest: btoa('<MPD></MPD>') }).dash).toBe(true);
        expect(extractAudioUrl({}).error).toMatch(/no stream link/);
    });
});

describe('host list and ranking', () => {
    test('streaming hosts first, no duplicates, no trailing slashes', () => {
        expect(
            listHifiHosts({
                streaming: ['https://a.example/', 'https://b.example'],
                api: ['https://a.example', 'https://c.example/'],
            })
        ).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    });

    test('fastest first, failures last', () => {
        const ranked = rankResults([
            { host: 'slow', ok: true, mbps: 1 },
            { host: 'down', ok: false },
            { host: 'fast', ok: true, mbps: 9 },
        ]);
        expect(ranked.map((r) => r.host)).toEqual(['fast', 'slow', 'down']);
    });
});

describe('measuring a host', () => {
    test('measureDownload reads up to the requested bytes', async () => {
        const fetchImpl = async () => new Response(stream(2 * 1048576), { status: 206 });
        const result = await measureDownload('https://cdn/x', { bytes: 1048576, timeoutMs: 5000, fetchImpl });
        expect(result.bytes).toBeGreaterThanOrEqual(1048576);
        expect(result.mbps).toBeGreaterThan(0);
    });

    test('benchmarkHifiHost walks ISRC -> TIDAL ID -> stream link -> download', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(String(url));
            if (String(url).includes('/search/')) return Response.json({ data: { items: [{ id: 222 }] } });
            if (String(url).includes('/track/')) {
                return Response.json({ data: { manifest: b64({ urls: ['https://cdn.example/a.flac'] }) } });
            }
            return new Response(stream(1048576), { status: 206 });
        };
        const result = await benchmarkHifiHost('https://host.example/', { bytes: 524288, fetchImpl });
        expect(result.ok).toBe(true);
        expect(result.cdn).toBe('cdn.example');
        expect(calls[0]).toBe('https://host.example/search/?i=GBDUW0000053');
        expect(calls[1]).toBe('https://host.example/track/?id=222&quality=LOSSLESS');
    });

    test('a host that errors is reported, not thrown', async () => {
        const result = await benchmarkHifiHost('https://down.example', {
            fetchImpl: async () => new Response('', { status: 503 }),
        });
        expect(result).toMatchObject({ ok: false, error: 'HTTP 503' });
    });
});
