#!/usr/bin/env node
// Measures every stream host on your connection and ranks them.
//
//   bun run bench:hosts
//   bun run bench:hosts -- --mb 16 --quality LOSSLESS --json
//
// Each host is tested one after another (so they don't share your bandwidth):
// find the track by ISRC, ask for its stream link, download a few MB, time it.
// The monochrome server is measured the same way for comparison. Use the
// result to choose Settings > Downloads > Download Source.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { benchmarkHifiHost, benchmarkMonochromeServer, listHifiHosts, rankResults } from '../js/source-benchmark.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at !== -1 && args[at + 1] ? args[at + 1] : fallback;
};
const asJson = args.includes('--json');
const bytes = Number(option('mb', '8')) * 1048576;
const quality = option('quality', 'LOSSLESS');
const isrc = option('isrc', undefined);

const instancesFile = fileURLToPath(new URL('../public/instances.json', import.meta.url));
const hosts = listHifiHosts(JSON.parse(await readFile(instancesFile, 'utf8')));

const results = [];
const log = (text) => !asJson && console.log(text);

log(`Testing the monochrome server and ${hosts.length} HiFi hosts (${bytes / 1048576} MB each)...\n`);
results.push(await benchmarkMonochromeServer({ bytes }));
for (const host of hosts) {
    log(`  ${host}`);
    results.push(await benchmarkHifiHost(host, { bytes, quality, isrc }));
}

const ranked = rankResults(results);
if (asJson) {
    console.log(JSON.stringify(ranked, null, 2));
} else {
    const ms = (value) => (value == null ? '-' : `${Math.round(value)}ms`);
    console.log('\nFastest first:\n');
    console.log('speed       first byte  lookup   host');
    for (const r of ranked) {
        const speed = r.ok ? `${r.mbps.toFixed(1)} MB/s`.padEnd(11) : 'failed'.padEnd(11);
        const note = r.ok ? (r.cdn ? ` (streams from ${r.cdn})` : '') : `  ${r.error}`;
        console.log(`${speed} ${ms(r.firstByteMs).padEnd(11)} ${ms(r.lookupMs).padEnd(8)} ${r.host}${note}`);
    }

    const best = ranked.find((r) => r.ok);
    const monochrome = ranked.find((r) => r.kind === 'monochrome');
    console.log('');
    if (!best) {
        console.log('No host answered. Check your connection.');
    } else if (best.kind === 'monochrome') {
        console.log('The monochrome server is the fastest here: leave Download Source on its default.');
    } else if (monochrome?.ok && best.mbps < monochrome.mbps * 1.2) {
        console.log('The hosts are about as fast as the monochrome server: the default is fine.');
    } else {
        console.log(
            `${best.host} is ${monochrome?.ok ? `${(best.mbps / monochrome.mbps).toFixed(1)}x faster than the monochrome server` : 'the only one that worked'}: set Settings > Downloads > Download Source to "HiFi hosts, then monochrome server".`
        );
    }
}
