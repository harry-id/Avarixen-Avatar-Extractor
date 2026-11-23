"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
    // Cached avatars are safe to drop after a day; tune with DOWNLOADS_TTL_HOURS.
    maxAgeMs: 24 * 60 * 60 * 1000,
    // Sweep once an hour so disk does not grow without bound.
    intervalMs: 60 * 60 * 1000
};

/**
 * Recursively total the size of a cache entry without following symlinks.
 */
function entrySize(full) {
    let stat;

    try {
        stat = fs.lstatSync(full);
    } catch {
        return 0;
    }

    if (stat.isSymbolicLink()) {
        return 0;
    }

    if (!stat.isDirectory()) {
        return stat.size;
    }

    let total = 0;
    let children = [];

    try {
        children = fs.readdirSync(full);
    } catch {
        return total;
    }

    for (const child of children) {
        total += entrySize(path.join(full, child));
    }

    return total;
}

/**
 * Delete entries under `dir` whose mtime is older than `maxAgeMs`.
 * Missing directories are not an error. Returns { removed, errors, removedBytes }.
 *
 * Options:
 *   maxBytes    optional total-size quota; when exceeded, the oldest entries
 *               are removed until the cache fits.
 *   shouldSkip  optional (fullPath, name) predicate for entries currently in
 *               use (e.g. an in-progress download). Skipped entries are not
 *               deleted and do not count toward the quota calculation.
 */
function sweepDownloads(
    dir,
    maxAgeMs = DEFAULTS.maxAgeMs,
    now = Date.now(),
    options = {}
) {
    const result = { removed: 0, errors: 0, removedBytes: 0 };
    const maxBytes = Number(options.maxBytes) || 0;
    const shouldSkip = typeof options.shouldSkip === "function"
        ? options.shouldSkip
        : () => false;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code !== "ENOENT") {
            result.errors += 1;
        }
        return result;
    }

    const candidates = [];

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (shouldSkip(full, entry.name)) {
            continue;
        }

        try {
            const stat = fs.lstatSync(full);
            candidates.push({
                full,
                mtimeMs: stat.mtimeMs,
                size: entrySize(full)
            });
        } catch {
            // A file can disappear between readdir and stat (another request).
            // Treat that as a non-fatal miss rather than an error.
            result.errors += 1;
        }
    }

    const removeEntry = (candidate) => {
        try {
            fs.rmSync(candidate.full, { recursive: true, force: true });
            result.removed += 1;
            result.removedBytes += candidate.size;
            candidate.deleted = true;
            return true;
        } catch {
            result.errors += 1;
            return false;
        }
    };

    // 1. Age-based expiry.
    for (const candidate of candidates) {
        if (maxAgeMs >= 0 && now - candidate.mtimeMs < maxAgeMs) {
            continue;
        }

        removeEntry(candidate);
    }

    // 2. Optional total-size quota: oldest surviving entries go first.
    if (maxBytes > 0) {
        let total = candidates
            .filter((candidate) => !candidate.deleted)
            .reduce((sum, candidate) => sum + candidate.size, 0);

        if (total > maxBytes) {
            const oldestFirst = candidates
                .filter((candidate) => !candidate.deleted)
                .sort((a, b) => a.mtimeMs - b.mtimeMs);

            for (const candidate of oldestFirst) {
                if (total <= maxBytes) {
                    break;
                }

                if (removeEntry(candidate)) {
                    total -= candidate.size;
                }
            }
        }
    }

    return result;
}

/**
 * Run sweepDownloads once now and then on a timer. The timer is unref'd so it
 * never keeps the process alive on its own.
 */
function startDownloadsCleanup(options = {}) {
    const dir = options.dir;
    const maxAgeMs = options.maxAgeMs !== undefined
        ? options.maxAgeMs
        : DEFAULTS.maxAgeMs;
    const intervalMs = options.intervalMs || DEFAULTS.intervalMs;
    const maxBytes = Number(options.maxBytes) || 0;
    const shouldSkip = options.shouldSkip;
    const log = options.log || ((message) => console.log(message));

    if (!dir) {
        return { stop() {}, sweep: () => ({ removed: 0, errors: 0 }) };
    }

    const sweep = () => sweepDownloads(dir, maxAgeMs, Date.now(), {
        maxBytes,
        shouldSkip
    });

    const run = () => {
        const { removed, errors, removedBytes } = sweep();

        if (removed > 0 || errors > 0) {
            log(
                `[cleanup] removed ${removed} download(s) ` +
                `(${(removedBytes / (1024 * 1024)).toFixed(1)} MiB), ` +
                `${errors} error(s)`
            );
        }

        return { removed, errors, removedBytes };
    };

    run();

    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === "function") {
        timer.unref();
    }

    return {
        stop() {
            clearInterval(timer);
        },
        sweep
    };
}

/**
 * Return bytes available to the current process on the filesystem holding
 * `dir`. Falls back to Infinity when statfs is unavailable so callers can
 * decide whether to treat that as a hard failure.
 */
async function getAvailableBytes(dir) {
    if (typeof fs.promises.statfs !== "function") {
        return Infinity;
    }

    try {
        const stats = await fs.promises.statfs(dir);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return 0;
    }
}

module.exports = {
    DEFAULTS,
    entrySize,
    getAvailableBytes,
    sweepDownloads,
    startDownloadsCleanup
};