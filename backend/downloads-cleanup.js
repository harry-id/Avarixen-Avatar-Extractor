"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
    // Cached avatars are safe to drop after a day; tune with DOWNLOADS_TTL_HOURS.
    maxAgeMs: 24 * 60 * 60 * 1000,
    // Sweep once an hour so disk does not grow without bound.
    intervalMs: 60 * 60 * 1000
};

const OLD_BACKUP_RE = /^\.old-(\d+)-/;

/**
 * Best-effort "touch" that refreshes an entry's mtime so an avatar in active
 * use is not treated as old by the age/quota sweep. Never throws: a read must
 * not fail because the timestamp could not be updated.
 *
 * @param {string} full absolute path to the cache entry (the user directory)
 */
async function touchEntry(full) {
    try {
        const now = new Date();
        await fs.promises.utimes(full, now, now);
    } catch {
        // Best-effort only.
    }
}

/**
 * True when `name` is an `.old-<userId>-*` backup whose live output directory
 * (`<dir>/<userId>`) is missing. Such a backup is the only surviving copy of a
 * user's cache after a crash between the two commit renames, so the age sweep
 * must never delete it (startup recovery restores it first).
 */
function isOldBackupOfMissingOutput(dir, name) {
    const match = OLD_BACKUP_RE.exec(name);

    if (!match) {
        return false;
    }

    try {
        return !fs.existsSync(path.join(dir, match[1]));
    } catch {
        return false;
    }
}

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
 *   minAgeMs    optional minimum age (ms) an entry must reach before the quota
 *               sweep may evict it. Entries younger than this are protected
 *               (e.g. an avatar read moments ago); if the quota cannot be met
 *               without evicting them, they are left in place.
 */
function sweepDownloads(
    dir,
    maxAgeMs = DEFAULTS.maxAgeMs,
    now = Date.now(),
    options = {}
) {
    const result = { removed: 0, errors: 0, removedBytes: 0 };
    const maxBytes = Number(options.maxBytes) || 0;
    const minAgeMs = Number(options.minAgeMs) || 0;
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
                // Protect recently-used entries from quota eviction.
                .filter((candidate) => now - candidate.mtimeMs >= minAgeMs)
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
 * Convert a DOWNLOADS_TTL_HOURS value into a maxAgeMs for sweepDownloads.
 * 0 disables the age sweep (Infinity: nothing is ever "older than" it); a
 * positive value is hours in ms. Invalid/negative falls back to the default.
 */
function ttlToMaxAgeMs(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0) {
        return DEFAULTS.maxAgeMs;
    }
    if (h === 0) {
        return Number.POSITIVE_INFINITY;
    }
    return h * 60 * 60 * 1000;
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
    const minAgeMs = Number(options.minAgeMs) || 0;
    const shouldSkip = options.shouldSkip;
    const log = options.log || ((message) => console.log(message));

    if (!dir) {
        return { stop() {}, sweep: () => ({ removed: 0, errors: 0 }) };
    }

    const sweep = () => sweepDownloads(dir, maxAgeMs, Date.now(), {
        maxBytes,
        minAgeMs,
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
    isOldBackupOfMissingOutput,
    sweepDownloads,
    startDownloadsCleanup,
    touchEntry,
    ttlToMaxAgeMs
};