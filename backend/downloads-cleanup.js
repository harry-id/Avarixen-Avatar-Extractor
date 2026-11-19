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
 * Delete entries under `dir` whose mtime is older than `maxAgeMs`.
 * Missing directories are not an error. Returns { removed, errors }.
 */
function sweepDownloads(dir, maxAgeMs = DEFAULTS.maxAgeMs, now = Date.now()) {
    const result = { removed: 0, errors: 0 };

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code !== "ENOENT") {
            result.errors += 1;
        }
        return result;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs < maxAgeMs) {
                continue;
            }

            fs.rmSync(full, { recursive: true, force: true });
            result.removed += 1;
        } catch {
            // A file can disappear between readdir and stat (another request).
            // Treat that as a non-fatal miss rather than an error.
            result.errors += 1;
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
    const maxAgeMs = options.maxAgeMs || DEFAULTS.maxAgeMs;
    const intervalMs = options.intervalMs || DEFAULTS.intervalMs;
    const log = options.log || ((message) => console.log(message));

    if (!dir) {
        return { stop() {}, sweep: () => ({ removed: 0, errors: 0 }) };
    }

    const run = () => {
        const { removed, errors } = sweepDownloads(dir, maxAgeMs);
        if (removed > 0 || errors > 0) {
            log(
                `[cleanup] removed ${removed} old download(s), ` +
                `${errors} error(s)`
            );
        }
        return { removed, errors };
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
        sweep: () => sweepDownloads(dir, maxAgeMs)
    };
}

module.exports = {
    DEFAULTS,
    sweepDownloads,
    startDownloadsCleanup
};