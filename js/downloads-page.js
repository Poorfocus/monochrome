//js/downloads-page.js
import {
    cancelAllDownloads,
    cancelDownloadJob,
    clearFinishedDownloads,
    countActiveDownloads,
    queuePosition,
    removeDownloadJob,
    subscribeDownloads,
    summarizeJob,
} from './download-manager.ts';
import { canShowInFolder, describeSavedPath, showInFolder } from './download-locations.ts';
import { retryDownloadJob } from './download-service.js';
import { isDesktopApp } from './desktop-bridge.ts';
import { settingsUiState } from './storage.js';
import {
    SVG_BIN,
    SVG_CHEVRON_DOWN,
    SVG_CIRCLE_ALERT,
    SVG_CIRCLE_CHECK,
    SVG_CLOSE,
    SVG_COPY,
    SVG_DOWNLOAD,
    SVG_FOLDER_OPEN,
    SVG_HOURGLASS,
    SVG_LOADER,
    SVG_ROTATE_CCW,
    SVG_SETTINGS,
} from './icons.ts';

/**
 * The Downloads page (/downloads) and the sidebar badge. Renders the
 * download manager's jobs; cards are updated in place so buttons stay put
 * while progress ticks.
 */

const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'In progress' },
    { id: 'done', label: 'Completed' },
    { id: 'failed', label: 'Needs attention' },
];

// The desktop app opens the real file explorer; a browser can only open the file dialog there.
const SHOW_IN_FOLDER_HINT = isDesktopApp ? 'Show in folder' : 'Show in folder (opens your system file dialog there)';

const KIND_LABELS = {
    track: 'Track',
    album: 'Album',
    playlist: 'Playlist',
    queue: 'Queue',
    liked: 'Liked tracks',
    discography: 'Discography',
};

let jobs = [];
let filter = 'all';
let root = null;
let listEl = null;
const cards = new Map();
const expanded = new Set();

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function iconButton(svg, title, onClick, className = 'btn-icon') {
    const btn = el('button', className);
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svg;
    btn.addEventListener('click', onClick);
    return btn;
}

function textButton(svg, label, title, onClick) {
    const btn = el('button', 'btn-secondary downloads-action downloads-job-action');
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = svg;
    btn.appendChild(el('span', 'downloads-job-action-label', label));
    btn.addEventListener('click', onClick);
    return btn;
}

function reportError(error) {
    console.error(error);
    alert(error?.message || String(error));
}

function coverUrl(cover) {
    if (!cover) return 'images/monochrome_logo.svg';
    if (/^(https?:|blob:|data:|assets\/|images\/)/.test(cover)) return cover;
    return `https://resources.tidal.com/images/${String(cover).replace(/-/g, '/')}/160x160.jpg`;
}

function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function isPending(job) {
    return job.status === 'active' || job.status === 'queued';
}

function matchesFilter(job) {
    switch (filter) {
        case 'active':
            return isPending(job);
        case 'done':
            return job.status === 'done';
        case 'failed':
            return ['failed', 'partial', 'cancelled'].includes(job.status);
        default:
            return true;
    }
}

function statusIcon(status) {
    switch (status) {
        case 'done':
            return `<span class="downloads-status-icon is-done">${SVG_CIRCLE_CHECK(16)}</span>`;
        case 'failed':
        case 'partial':
            return `<span class="downloads-status-icon is-failed">${SVG_CIRCLE_ALERT(16)}</span>`;
        case 'downloading':
        case 'active':
            return `<span class="downloads-status-icon is-active">${SVG_LOADER(16)}</span>`;
        case 'cancelled':
            return `<span class="downloads-status-icon is-muted">${SVG_CLOSE(16)}</span>`;
        default:
            return `<span class="downloads-status-icon is-muted">${SVG_HOURGLASS(16)}</span>`;
    }
}

function jobStatusText(job) {
    const { done, failed, total, bytes } = summarizeJob(job);
    const size = formatBytes(bytes);
    switch (job.status) {
        case 'queued': {
            const position = queuePosition(job.id, jobs);
            return position > 1 ? `Queued · ${position - 1} ahead` : 'Up next';
        }
        case 'active': {
            if (total === 0) return 'Starting…';
            const current = job.items.find((item) => item.status === 'downloading');
            const speed = formatSpeed(
                job.items.reduce((sum, item) => sum + (item.status === 'downloading' ? item.speed || 0 : 0), 0)
            );
            const running = job.items.filter((item) => item.status === 'downloading');
            if (total === 1) {
                return current
                    ? ['Downloading', `${Math.round(current.progress * 100)}%`, speed].filter(Boolean).join(' · ')
                    : 'Downloading';
            }
            const now = running.length > 1 ? `${running.length} at once` : current?.track.title;
            return [`${done}/${total}`, now, speed].filter(Boolean).join(' · ');
        }
        case 'done':
            return [total > 1 ? `${total} tracks` : 'Saved', size].filter(Boolean).join(' · ');
        case 'partial':
            return `${done}/${total} saved · ${failed} failed${retryNote(job)}`;
        case 'cancelled':
            return done > 0 ? `Cancelled · ${done}/${total} saved` : 'Cancelled';
        default:
            return `${job.error || 'Download failed'}${retryNote(job)}`;
    }
}

/** " · retrying at 3:42 PM" while the app has an automatic retry scheduled for the job. */
function retryNote(job) {
    if (!job.autoRetryAt) return '';
    const time = new Date(job.autoRetryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return ` · retrying automatically at ${time}`;
}

function destinationText(job) {
    const destination = job.destination;
    if (!destination) return '';
    switch (destination.method) {
        case 'folder':
        case 'local':
            return `Saving to ${destination.label}${job.folderName ? `/${job.folderName}` : ''}`;
        case 'zip':
            return `Saving to ${destination.label}`;
        case 'desktop':
            return `Saving to ${describeSavedPath(destination, job.folderName || '')}`;
        default:
            return destination.label && destination.label !== 'Browser downloads'
                ? `Saving to your browser's Downloads folder as ${destination.label}`
                : "Saving to your browser's Downloads folder";
    }
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond) return '';
    return `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`;
}

function itemDetail(item) {
    // Retry countdowns and the last error while a track waits for its next attempt.
    if (item.statusText && (item.status === 'queued' || item.status === 'failed')) return item.statusText;
    switch (item.status) {
        case 'downloading':
            return [`${Math.round(item.progress * 100)}%`, formatSpeed(item.speed)].filter(Boolean).join(' · ');
        case 'failed':
            return item.error || 'Failed';
        case 'done':
            return formatBytes(item.bytes);
        case 'cancelled':
            return 'Cancelled';
        default:
            return 'Waiting';
    }
}

// ── Track rows ───────────────────────────────────────────────────────────────

function createTrackRow(card) {
    const row = el('li', 'downloads-track');
    const refs = {
        number: el('span', 'downloads-track-number'),
        icon: el('span'),
        title: el('div', 'downloads-track-title'),
        meta: el('div', 'downloads-track-meta'),
        progress: el('div', 'downloads-progress is-small'),
        fill: el('div', 'downloads-progress-fill'),
        detail: el('span', 'downloads-track-detail'),
        actions: el('div', 'downloads-track-actions'),
        actionsKey: '',
        iconKey: '',
    };
    refs.progress.appendChild(refs.fill);
    const info = el('div', 'downloads-track-info');
    info.append(refs.title, refs.meta, refs.progress);
    row.append(refs.number, refs.icon, info, refs.detail, refs.actions);
    row.refs = refs;
    row.card = card;
    return row;
}

function updateTrackRow(row, job, item, index, number) {
    const { refs } = row;
    row.className = `downloads-track is-${item.status}`;
    refs.number.textContent = String(number);
    if (refs.iconKey !== item.status) {
        refs.icon.innerHTML = statusIcon(item.status);
        refs.iconKey = item.status;
    }
    refs.title.textContent = item.track.title;
    const savedAt = item.status === 'done' ? describeSavedPath(job.destination, item.path) : '';
    refs.meta.textContent = savedAt || item.track.artist;
    refs.meta.title = savedAt;
    refs.progress.style.display = item.status === 'downloading' ? '' : 'none';
    refs.fill.style.width = `${item.progress * 100}%`;
    refs.detail.textContent = itemDetail(item);
    refs.detail.classList.toggle('is-failed', item.status === 'failed');

    const showFolder = item.status === 'done' && canShowInFolder(job.destination);
    const key = `${showFolder}|${item.status === 'done' && savedAt ? savedAt : ''}`;
    if (key !== refs.actionsKey) {
        refs.actionsKey = key;
        refs.actions.replaceChildren();
        if (showFolder) {
            refs.actions.appendChild(
                iconButton(SVG_FOLDER_OPEN(16), SHOW_IN_FOLDER_HINT, () => {
                    const current = row.card.job;
                    showInFolder(current.destination, current.items[index]?.path).catch(reportError);
                })
            );
        }
        if (item.status === 'done' && savedAt) {
            refs.actions.appendChild(
                iconButton(SVG_COPY(16), 'Copy file location', () => {
                    navigator.clipboard?.writeText(savedAt).catch(reportError);
                })
            );
        }
    }
}

// ── Job cards ────────────────────────────────────────────────────────────────

function createCard(job) {
    const card = { job, rows: [], groupTitles: new Map() };
    const article = el('article', 'downloads-job');
    const header = el('div', 'downloads-job-header');

    const cover = el('img', 'downloads-job-cover');
    cover.alt = '';
    cover.loading = 'lazy';
    cover.crossOrigin = 'anonymous';
    cover.referrerPolicy = 'no-referrer';
    cover.addEventListener('error', () => (cover.src = 'images/monochrome_logo.svg'), { once: true });

    const main = el('button', 'downloads-job-main');
    main.type = 'button';
    const kind = el('div', 'downloads-job-kind');
    const title = el('div', 'downloads-job-title');
    const subtitle = el('div', 'downloads-job-subtitle');
    const status = el('div', 'downloads-job-status');
    const statusIconEl = el('span');
    const statusText = el('span', 'downloads-job-status-text');
    status.append(statusIconEl, statusText);
    main.append(kind, title, subtitle, status);
    main.addEventListener('click', () => toggleExpanded(card));

    const actions = el('div', 'downloads-job-actions');
    const expandBtn = iconButton(
        SVG_CHEVRON_DOWN(18),
        'Show tracks',
        () => toggleExpanded(card),
        'btn-icon downloads-expand'
    );

    header.append(cover, main, actions);
    const progress = el('div', 'downloads-progress');
    const progressFill = el('div', 'downloads-progress-fill');
    progress.appendChild(progressFill);

    const body = el('div', 'downloads-job-body');
    const destination = el('div', 'downloads-job-destination');
    const tracks = el('div');
    body.append(destination, tracks);

    article.append(header, progress, body);
    Object.assign(card, {
        article,
        cover,
        kind,
        title,
        subtitle,
        statusIconEl,
        statusText,
        actions,
        actionsKey: '',
        expandBtn,
        progress,
        progressFill,
        body,
        destination,
        tracks,
        statusKey: '',
    });
    return card;
}

function toggleExpanded(card) {
    if (expanded.has(card.job.id)) expanded.delete(card.job.id);
    else expanded.add(card.job.id);
    updateCard(card, card.job);
}

function updateActions(card, job) {
    const summary = summarizeJob(job);
    const pending = isPending(job);
    const folder = canShowInFolder(job.destination) && summary.done > 0;
    const retry = !pending && (job.status !== 'done' || summary.failed > 0);
    const auto = Boolean(job.autoRetryAt);
    const key = `${pending}|${folder}|${retry}|${auto}`;
    if (key === card.actionsKey) return;
    card.actionsKey = key;

    const buttons = [];
    if (folder) {
        buttons.push(
            textButton(SVG_FOLDER_OPEN(16), 'Show in folder', SHOW_IN_FOLDER_HINT, () => {
                const current = card.job;
                const firstSaved = current.items.find((item) => item.status === 'done')?.path;
                showInFolder(current.destination, firstSaved).catch(reportError);
            })
        );
    }
    if (retry) {
        buttons.push(
            textButton(SVG_ROTATE_CCW(16), 'Retry', 'Download the missing tracks again, into the same folder', () =>
                retryDownloadJob(card.job.id).catch(reportError)
            )
        );
    }
    if (auto) {
        buttons.push(
            textButton(SVG_CLOSE(16), 'Stop retrying', 'Stop retrying the missing tracks automatically', () =>
                cancelDownloadJob(card.job.id)
            )
        );
    }
    buttons.push(
        pending
            ? iconButton(SVG_CLOSE(18), 'Cancel', () => cancelDownloadJob(card.job.id))
            : iconButton(SVG_BIN(16), 'Remove from list (keeps the files, stops retrying)', () =>
                  removeDownloadJob(card.job.id)
              )
    );
    buttons.push(card.expandBtn);
    card.actions.replaceChildren(...buttons);
}

function updateTracks(card, job) {
    const discography = job.kind === 'discography';
    let groupPosition = 0;
    let currentGroup;
    let list = null;
    const fragment = [];

    // Rows are kept by index; groups (discography releases) get a heading each.
    job.items.forEach((item, index) => {
        if (index === 0 || item.group !== currentGroup) {
            currentGroup = item.group;
            groupPosition = 0;
            if (discography && item.group) {
                let heading = card.groupTitles.get(index);
                if (!heading) {
                    heading = el('h3', 'downloads-group-title');
                    card.groupTitles.set(index, heading);
                }
                heading.textContent = item.group;
                fragment.push(heading);
            }
            list = el('ol', 'downloads-tracks');
            fragment.push(list);
        }
        groupPosition++;
        let row = card.rows[index];
        if (!row) {
            row = createTrackRow(card);
            card.rows[index] = row;
        }
        updateTrackRow(row, job, item, index, discography ? groupPosition : index + 1);
        list.appendChild(row);
    });

    if (job.items.length === 0) {
        fragment.push(el('div', 'downloads-empty-tracks', isPending(job) ? 'Looking up tracks…' : 'No tracks'));
    }
    card.tracks.replaceChildren(...fragment);
}

function updateCard(card, job) {
    card.job = job;
    const open = expanded.has(job.id);
    card.article.className = `downloads-job is-${job.status}`;
    const src = coverUrl(job.cover);
    if (card.cover.dataset.src !== src) {
        card.cover.dataset.src = src;
        card.cover.src = src;
    }
    card.kind.textContent = `${KIND_LABELS[job.kind] || 'Download'}${
        job.quality ? ` · ${job.quality.replace(/_/g, ' ').toLowerCase()}` : ''
    }`;
    card.title.textContent = job.title;
    card.subtitle.textContent = job.subtitle || '';
    card.subtitle.style.display = job.subtitle ? '' : 'none';
    if (card.statusKey !== job.status) {
        card.statusIconEl.innerHTML = statusIcon(job.status);
        card.statusKey = job.status;
    }
    card.statusText.textContent = jobStatusText(job);

    updateActions(card, job);
    card.expandBtn.classList.toggle('is-open', open);
    card.expandBtn.title = open ? 'Hide tracks' : 'Show tracks';
    card.expandBtn.setAttribute('aria-expanded', String(open));

    const summary = summarizeJob(job);
    card.progress.style.display = isPending(job) || job.status === 'partial' ? '' : 'none';
    card.progressFill.style.width = `${summary.fraction * 100}%`;

    card.body.style.display = open ? '' : 'none';
    if (open) {
        card.destination.textContent = destinationText(job);
        card.destination.style.display = job.destination ? '' : 'none';
        updateTracks(card, job);
    }
}

// ── Page ─────────────────────────────────────────────────────────────────────

function buildPage(container) {
    container.replaceChildren();
    const page = el('div', 'downloads-page');

    const header = el('div', 'downloads-header');
    const titles = el('div');
    titles.append(el('h1', 'section-title', 'Downloads'), el('p', 'downloads-summary'));
    const actions = el('div', 'downloads-header-actions');

    const cancelAll = el('button', 'btn-secondary downloads-action downloads-cancel-all');
    cancelAll.type = 'button';
    cancelAll.innerHTML = `${SVG_CLOSE(16)}<span>Cancel all</span>`;
    cancelAll.addEventListener('click', () => {
        if (confirm('Cancel the current download and everything waiting in the queue?')) cancelAllDownloads();
    });

    const clear = el('button', 'btn-secondary downloads-action downloads-clear-finished');
    clear.type = 'button';
    clear.innerHTML = `${SVG_BIN(16)}<span>Clear finished</span>`;
    clear.addEventListener('click', () => clearFinishedDownloads());

    const settings = el('a', 'btn-secondary downloads-action');
    settings.href = '/settings';
    settings.innerHTML = `${SVG_SETTINGS(16)}<span>Settings</span>`;
    settings.addEventListener('click', () => settingsUiState.setActiveTab('downloads'));

    actions.append(cancelAll, clear, settings);
    header.append(titles, actions);

    const filters = el('div', 'downloads-filters');
    filters.setAttribute('role', 'tablist');
    filters.setAttribute('aria-label', 'Filter downloads');
    for (const option of FILTERS) {
        const btn = el('button', 'downloads-filter', option.label);
        btn.type = 'button';
        btn.dataset.filter = option.id;
        btn.setAttribute('role', 'tab');
        btn.addEventListener('click', () => {
            filter = option.id;
            renderDownloadsPage();
        });
        filters.appendChild(btn);
    }

    const empty = el('div', 'downloads-empty');
    empty.innerHTML = SVG_DOWNLOAD(32);
    empty.appendChild(el('p'));

    listEl = el('div', 'downloads-list');
    page.append(header, filters, empty, listEl);
    container.appendChild(page);
    root = page;
}

const STATUS_RANK = { active: 0, queued: 1 };

/** Running job first, then the queue in the order it will run, then history (newest first). */
function byQueueOrder(a, b) {
    const rankA = STATUS_RANK[a.status] ?? 2;
    const rankB = STATUS_RANK[b.status] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    return rankA === 1 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
}

function isPageVisible() {
    return document.getElementById('page-downloads')?.classList.contains('active');
}

/** Renders the page into #page-downloads. Cheap to call repeatedly. */
export function renderDownloadsPage() {
    const container = document.getElementById('page-downloads');
    if (!container) return;
    if (!root || !container.contains(root)) buildPage(container);

    const running = jobs.filter((job) => job.status === 'active').length;
    const queued = jobs.filter((job) => job.status === 'queued').length;
    const finished = jobs.length - running - queued;

    root.querySelector('.downloads-summary').textContent =
        running || queued
            ? `${[running ? `${running} downloading` : '', queued ? `${queued} waiting in the queue` : ''].filter(Boolean).join(' · ')}. Downloads run one at a time, in order.`
            : 'Nothing downloading right now. Downloads run one at a time, in order.';
    root.querySelector('.downloads-cancel-all').style.display = running || queued ? '' : 'none';
    root.querySelector('.downloads-clear-finished').style.display = finished > 0 ? '' : 'none';
    for (const btn of root.querySelectorAll('.downloads-filter')) {
        const active = btn.dataset.filter === filter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
    }

    const visible = jobs.filter(matchesFilter).sort(byQueueOrder);
    const empty = root.querySelector('.downloads-empty');
    empty.style.display = visible.length ? 'none' : '';
    empty.querySelector('p').textContent = jobs.length
        ? 'No downloads match this filter.'
        : 'Albums, playlists and tracks you download show up here.';

    const seen = new Set();
    const order = [];
    for (const job of visible) {
        seen.add(job.id);
        let card = cards.get(job.id);
        if (!card) {
            card = createCard(job);
            cards.set(job.id, card);
            // Single tracks have nothing to hide; other finished history starts collapsed.
            if (job.items.length === 1 && !isPending(job)) expanded.add(job.id);
        }
        // Open a job when it starts running. Jobs are mutated in place, so remember the last status seen.
        if (job.status === 'active' && card.lastStatus !== 'active') expanded.add(job.id);
        card.lastStatus = job.status;
        updateCard(card, job);
        order.push(card.article);
    }
    for (const [id, card] of cards) {
        if (!jobs.some((job) => job.id === id)) {
            cards.delete(id);
            expanded.delete(id);
        } else if (!seen.has(id)) {
            card.article.remove();
        }
    }
    // Reorder without recreating nodes (keeps focus and hover).
    order.forEach((node, index) => {
        if (listEl.children[index] !== node) listEl.insertBefore(node, listEl.children[index] || null);
    });
}

function updateSidebarBadge() {
    const link = document.querySelector('#sidebar-nav-downloads a');
    if (!link) return;
    const count = countActiveDownloads(jobs);
    let badge = link.querySelector('.nav-badge');
    if (!count) {
        badge?.remove();
        return;
    }
    if (!badge) {
        badge = el('span', 'nav-badge');
        link.appendChild(badge);
    }
    badge.textContent = String(count);
    badge.setAttribute('aria-label', `${count} active`);
}

let initialized = false;

/** Subscribes the page and sidebar badge to the download manager. */
export function initDownloadsPage() {
    if (initialized) return;
    initialized = true;
    subscribeDownloads((next) => {
        jobs = next;
        updateSidebarBadge();
        if (isPageVisible()) renderDownloadsPage();
    });
}
