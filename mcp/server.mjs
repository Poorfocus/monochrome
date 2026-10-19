#!/usr/bin/env node
// Monochrome MCP server: lets Claude (or any MCP client) find and download
// albums through the Monochrome desktop app.
//
// It talks to the running desktop app over localhost (the URL and secret token
// are in automation.json in the app's data folder) and starts the app if it is
// not running. Searching and downloading happen inside the app, so downloads
// use its queue, retries, folder layout and Downloads page.
//
// Setup: see mcp/README.md.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_START_TIMEOUT_MS = 60_000;

const QUALITIES = [
    'HI_RES_LOSSLESS',
    'LOSSLESS',
    'HIGH',
    'LOW',
    'DOLBY_ATMOS_EAC3_HIGH',
    'DOLBY_ATMOS_EAC3_LOW',
    'DOLBY_ATMOS_AC4_HIGH',
    'DOLBY_ATMOS_AC4_LOW',
];

// ── Talking to the desktop app ───────────────────────────────────────────────

/** Where the desktop app keeps automation.json (matches app.setPath('userData') in desktop/main.cjs). */
function appDataDir() {
    if (process.env.MONOCHROME_DATA_DIR) return process.env.MONOCHROME_DATA_DIR;
    switch (process.platform) {
        case 'win32':
            return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Monochrome');
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'Monochrome');
        default:
            return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Monochrome');
    }
}

function readAutomationInfo() {
    try {
        return JSON.parse(fs.readFileSync(path.join(appDataDir(), 'automation.json'), 'utf8'));
    } catch {
        return null;
    }
}

async function post(info, method, params) {
    const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ method, params }),
    });
    if (response.status === 401) throw new Error('stale-token');
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    return body.result;
}

async function isAppRunning() {
    const info = readAutomationInfo();
    if (!info) return false;
    try {
        await post(info, 'ping', {});
        return true;
    } catch {
        return false;
    }
}

/** The installed desktop app, or the repo's Electron build as a fallback. */
function findAppCommand() {
    if (process.env.MONOCHROME_APP_PATH) return { command: process.env.MONOCHROME_APP_PATH, args: [] };
    const installed = {
        win32: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Monochrome', 'Monochrome.exe'),
        darwin: '/Applications/Monochrome.app/Contents/MacOS/Monochrome',
        linux: '/opt/Monochrome/monochrome',
    }[process.platform];
    if (installed && fs.existsSync(installed)) return { command: installed, args: [] };

    const electronBin = path.join(
        REPO_ROOT,
        'node_modules',
        'electron',
        'dist',
        process.platform === 'win32'
            ? 'electron.exe'
            : process.platform === 'darwin'
              ? 'Electron.app/Contents/MacOS/Electron'
              : 'electron'
    );
    if (fs.existsSync(electronBin) && fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
        return { command: electronBin, args: [path.join(REPO_ROOT, 'desktop', 'main.cjs')] };
    }
    return null;
}

async function ensureAppRunning() {
    if (await isAppRunning()) return;
    const app = findAppCommand();
    if (!app) {
        throw new Error(
            'The Monochrome desktop app is not running and could not be found. Open it, or build it from the repo with "npm run desktop" (see mcp/README.md).'
        );
    }
    const child = spawn(app.command, app.args, { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + APP_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (await isAppRunning()) return;
    }
    throw new Error('Started the Monochrome desktop app but it did not respond within a minute.');
}

async function callApp(method, params = {}) {
    await ensureAppRunning();
    try {
        return await post(readAutomationInfo(), method, params);
    } catch (error) {
        // The app restarted between the check and the call: it wrote a new token.
        if (error.message === 'stale-token') return post(readAutomationInfo(), method, params);
        throw error;
    }
}

// ── Tools ────────────────────────────────────────────────────────────────────

function asText(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function asError(error) {
    return { content: [{ type: 'text', text: `Error: ${error?.message || error}` }], isError: true };
}

const tool = (handler) => async (args) => {
    try {
        return asText(await handler(args));
    } catch (error) {
        return asError(error);
    }
};

const server = new McpServer(
    { name: 'monochrome', version: '1.0.0' },
    {
        instructions: [
            'Downloads music through the Monochrome desktop app into the folder set in its Settings, organized as "Album - Artist" folders.',
            'For a list of albums, pass the whole list to find_and_download_albums in one call (one "Artist - Album" per entry).',
            'It queues confident matches and returns needsChoice entries with candidate albums: show those to the user, then call download_album with the album IDs they pick.',
            'Downloads run one at a time in the app; use download_status to report progress and failures, and retry_download for jobs with failed tracks.',
        ].join(' '),
    }
);

server.registerTool(
    'find_and_download_albums',
    {
        title: 'Find and download albums',
        description:
            'Searches for each album in a list and queues the best match for download. Entries can be "Artist - Album", "Album by Artist", or just an album title. Returns which albums were queued, which were already downloaded or queued, which need the user to pick between candidates, and which were not found.',
        inputSchema: {
            albums: z.array(z.string()).min(1).describe('One entry per album, e.g. "Radiohead - OK Computer".'),
            quality: z.enum(QUALITIES).optional().describe("Download quality; defaults to the app's setting."),
            min_confidence: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('How close a match must be to queue it without asking (default 0.75).'),
            dry_run: z.boolean().optional().describe('Only report the matches; queue nothing.'),
        },
        annotations: { openWorldHint: true },
    },
    tool(({ albums, quality, min_confidence, dry_run }) =>
        callApp('find_and_download_albums', { albums, quality, minConfidence: min_confidence, dryRun: dry_run })
    )
);

server.registerTool(
    'search_albums',
    {
        title: 'Search albums',
        description:
            'Searches the catalog for albums. Returns IDs to pass to download_album, with artist, year, track count and quality.',
        inputSchema: {
            query: z.string().min(1).describe('Search text, e.g. "Radiohead OK Computer".'),
            limit: z.number().int().min(1).max(25).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(({ query, limit }) => callApp('search_albums', { query, limit }))
);

server.registerTool(
    'download_album',
    {
        title: 'Download album',
        description: 'Queues one album for download by its ID (from search_albums or a needsChoice candidate).',
        inputSchema: {
            album_id: z.union([z.string(), z.number()]).describe('Album ID.'),
            provider: z
                .string()
                .optional()
                .describe('The "provider" field from search_albums or the candidate, when present.'),
            quality: z.enum(QUALITIES).optional(),
        },
        annotations: { openWorldHint: true },
    },
    tool(({ album_id, provider, quality }) => callApp('download_album', { albumId: album_id, provider, quality }))
);

server.registerTool(
    'download_status',
    {
        title: 'Download status',
        description:
            'Shows the download folder and every recent download: running, queued (with position), finished, and failed tracks with their errors.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    },
    tool(() => callApp('status'))
);

server.registerTool(
    'retry_download',
    {
        title: 'Retry download',
        description: 'Downloads the missing tracks of a finished, failed or cancelled job again, into the same folder.',
        inputSchema: { job_id: z.string().describe('jobId from download_status.') },
        annotations: { openWorldHint: true },
    },
    tool(({ job_id }) => callApp('retry_download', { jobId: job_id }))
);

server.registerTool(
    'cancel_download',
    {
        title: 'Cancel download',
        description: 'Cancels a running or queued download, or "all" to stop everything.',
        inputSchema: { job_id: z.string().describe('jobId from download_status, or "all".') },
        annotations: { destructiveHint: true },
    },
    tool(({ job_id }) => callApp('cancel_download', { jobId: job_id }))
);

await server.connect(new StdioServerTransport());
