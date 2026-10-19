# Monochrome MCP server

Lets Claude (or any MCP client) find and download albums through the Monochrome desktop app. Open a chat, paste a list of albums, and they are searched, matched, queued and saved into your download folder as `Album - Artist/` folders with cover art.

Searching and downloading happen inside the desktop app, so you get its download queue (one album at a time), retries, folder layout and Downloads page. The server starts the app if it is not running.

## Setup

1. `bun install` (or `npm install`) and `npm run build` in the repo root.
2. In the desktop app (`npm run desktop`), open **Settings → Downloads** and pick the **Default Download Location**. The default is `Music/Monochrome`.
3. Add the server to your client:
    - **Claude Code**: nothing to do inside this repo, `.mcp.json` is already here. Elsewhere: `claude mcp add monochrome -- node /path/to/monochrome/mcp/server.mjs`
    - **Claude Desktop**: add to `claude_desktop_config.json`:
        ```json
        { "mcpServers": { "monochrome": { "command": "node", "args": ["/path/to/monochrome/mcp/server.mjs"] } } }
        ```

If you installed the packaged app (`npm run desktop:dist`) the server launches it from its install location; otherwise it uses the repo's Electron build. Set `MONOCHROME_APP_PATH` to point at a different executable.

## Using it

> Download these in lossless:
> Radiohead - OK Computer
> Daft Punk - Discovery
> Kendrick Lamar - good kid, m.A.A.d city

Entries can be `Artist - Album`, `Album by Artist`, or just a title. Confident matches are queued; anything ambiguous comes back with candidates so Claude can ask you which one you meant. Ask for progress any time ("how are the downloads going?") and failed tracks can be retried.

## Tools

| Tool                       | What it does                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `find_and_download_albums` | Takes a whole list. Returns `queued`, `alreadyQueued`, `needsChoice` (with candidates), `notFound`. |
| `search_albums`            | Searches the catalog; returns album IDs with artist, year and a match confidence.                   |
| `download_album`           | Queues one album by ID (for `needsChoice` picks).                                                   |
| `download_status`          | Download folder, running and queued jobs, finished jobs, failed tracks with their errors.           |
| `retry_download`           | Downloads a job's missing tracks again into the same folder.                                        |
| `cancel_download`          | Cancels one job, or `all`.                                                                          |

`find_and_download_albums` also takes `quality` (`HI_RES_LOSSLESS`, `LOSSLESS`, `HIGH`, ...), `min_confidence` (default 0.75) and `dry_run` to preview matches without downloading.

## How it works and security

The desktop app listens on `127.0.0.1` only. It writes a random token to `automation.json` in its data folder (`%APPDATA%/Monochrome`, `~/Library/Application Support/Monochrome`, or `~/.config/Monochrome`) each time it starts, and rejects requests without it. The MCP server reads that file, so only programs running as you can control the app. It can only search, download into your download folder and manage the queue.

Troubleshooting: the desktop app logs warnings and errors to `logs/app.log` in the same data folder.
