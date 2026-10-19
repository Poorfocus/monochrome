export const isTidalAudioUrl = () => false;

export const getProxyUrl = (url) => {
    if (!url) return url;
    return url;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch targets for a download URL. Public CORS proxies (corsproxy.io,
 * allorigins) are deliberately not used: they would receive signed stream
 * URLs, block or size-limit audio from production origins, and turn each
 * failed request into extra timeouts.
 * @param {string} url
 * @returns {string[]}
 */
export function downloadFetchEndpoints(url) {
    return [url];
}

function combineSignals(signals) {
    const active = signals.filter(Boolean);
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);

    const controller = new AbortController();
    for (const signal of active) {
        if (signal.aborted) {
            controller.abort();
            break;
        }
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller.signal;
}

/**
 * Fetches a download URL, retrying transient failures with backoff.
 * @param {string} url
 * @param {RequestInit & { attempts?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchDownload(url, options = {}) {
    const { attempts = 2, signal, timeoutMs = 15000, ...init } = options;
    const endpoints = downloadFetchEndpoints(url);
    let lastError = null;

    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
        const endpoint = endpoints[endpointIndex];
        const tries = endpointIndex === 0 ? attempts : 1;

        for (let attempt = 1; attempt <= tries; attempt++) {
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }

            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), timeoutMs);

            try {
                const response = await fetch(endpoint, {
                    cache: 'no-store',
                    ...init,
                    signal: combineSignals([signal, timeout.signal]),
                });

                if (response.ok) return response;

                lastError = new Error(`Fetch failed: ${response.status}`);
                const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
                if (!retryable) break;
            } catch (error) {
                if (signal?.aborted) throw error;
                lastError = error?.name === 'AbortError' ? new Error('Download request timed out') : error;
            } finally {
                clearTimeout(timer);
            }

            if (attempt < tries) await sleep(400 * attempt);
        }
    }

    throw lastError || new Error(`Fetch failed for ${url}`);
}

export const wrapTidalUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    return url
        .replace('openapi.tidal.com', 'tidal-proxy.monochrome.tf/openapi')
        .replace('api.tidal.com', 'tidal-proxy.monochrome.tf/api')
        .replace('https://tidal.com', 'https://tidal-proxy.monochrome.tf/tidal');
};
