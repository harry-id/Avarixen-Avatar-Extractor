"use strict";

// Reusable worker pool for conversion jobs.
//
// - Size = MAX_CONCURRENT_CONVERSIONS (the route limiter caps admission to the
//   same number, so a slot always maps to a worker).
// - Workers are reused; a crashed or exited worker is respawned.
// - Each worker gets explicit V8 resourceLimits (heap). This isolates a runaway
//   worker's JS-heap OOM (it dies alone), but it does NOT cover off-heap memory
//   (Buffers/typed arrays) — the output-face budget remains the primary defense.
// - A worker is recycled after N jobs to bound any slow leaks.
// - run(job, { signal }) supports cancellation: aborting terminates that worker
//   (killing the in-flight job), respawns it, and rejects the run exactly once.
// - close() rejects all pending/in-flight runs and terminates every worker.

const path = require("path");
const { Worker } = require("worker_threads");

const WORKER_PATH = path.join(__dirname, "conversion-worker.js");

function abortError() {
    const err = new Error("Conversion cancelled");
    err.name = "AbortError";
    err.code = "ECONVERSIONCANCELLED";
    return err;
}

function crashError(info) {
    const code = info && typeof info === "object" ? (info.code || info.message) : info;
    const err = new Error(`Conversion worker exited unexpectedly (${code})`);
    err.name = "WorkerCrashError";
    err.code = "ECONVERSIONCRASH";
    err.workerCode = info && typeof info === "object" ? info.code : undefined;
    err.exitCode = typeof info === "number" ? info : undefined;
    return err;
}

function decodeError(info) {
    const err = new Error((info && info.message) || "Conversion failed");
    if (info && info.name) err.name = info.name;
    if (info && info.code) err.code = info.code;
    if (info && info.stack) err.stack = info.stack;
    return err;
}

class ConversionPool {
    constructor(options = {}) {
        this.size = Math.max(1, Math.floor(options.size || 1));
        this.recycleAfter = Math.max(1, Math.floor(options.recycleAfter || 50));
        this.resourceLimits = options.resourceLimits || { maxOldGenerationSizeMb: 512 };
        this.workerPath = options.workerPath || WORKER_PATH;
        this.log = options.log || ((level, args) => {
            // Default: forward to the main console.
            if (level === "warn") console.warn(...args);
            else if (level === "error") console.error(...args);
        });

        this.workers = []; // { worker, idle, job, jobsDone, dead }
        this.idle = [];
        this.pending = [];
        this.closed = false;
        this.nextId = 0;

        for (let i = 0; i < this.size; i++) {
            this._spawn();
        }
    }

    _spawn() {
        const record = { worker: null, idle: true, job: null, jobsDone: 0, dead: false };
        const w = new Worker(this.workerPath, {
            resourceLimits: this.resourceLimits,
            env: process.env
        });
        record.worker = w;

        w.on("message", (m) => this._onMessage(record, m));
        w.on("error", (err) => this._onWorkerDown(record, err));
        w.on("exit", (code) => this._onWorkerDown(record, code));

        this.workers.push(record);
        this.idle.push(record);
        return record;
    }

    _onMessage(record, m) {
        if (m && m.type === "console") {
            try { this.log(m.level, m.args); } catch { /* never break */ }
            return;
        }

        const entry = record.job;
        if (!entry || (m && m.id !== entry.job.id)) return;

        record.job = null;
        record.idle = true;
        record.jobsDone += 1;
        this._settle(entry);

        if (m.ok) entry.resolve(m);
        else entry.reject(decodeError(m.error));

        if (record.jobsDone >= this.recycleAfter) {
            this._replace(record);
        } else {
            this.idle.push(record);
        }
        this._pump();
    }

    _removeRecord(record) {
        const wi = this.workers.indexOf(record);
        if (wi >= 0) this.workers.splice(wi, 1);
        const ii = this.idle.indexOf(record);
        if (ii >= 0) this.idle.splice(ii, 1);
    }

    _onWorkerDown(record, info) {
        if (record.dead) return;
        record.dead = true;
        record.idle = false;

        const entry = record.job;
        record.job = null;
        if (entry) {
            this._settle(entry);
            entry.reject(crashError(info));
        }

        this._removeRecord(record);

        // Respawn a replacement unless the pool is closed.
        if (!this.closed) this._spawn();
        this._pump();
    }

    _replace(record) {
        // Recycle: terminate the old worker and spawn a fresh one.
        record.dead = true;
        record.idle = false;
        record.job = null;
        this._removeRecord(record);
        record.worker.terminate().catch(() => {});
        if (!this.closed) this._spawn();
    }

    _settle(entry) {
        if (entry.onAbort && entry.signal) {
            entry.signal.removeEventListener("abort", entry.onAbort);
        }
        entry.onAbort = null;
    }

    _dispatch(entry) {
        const record = this.idle.pop();
        if (!record) {
            this.pending.push(entry);
            return;
        }
        this._assign(record, entry);
    }

    _assign(record, entry) {
        record.job = entry;
        record.idle = false;
        entry.record = record;
        try {
            record.worker.postMessage(entry.job);
        } catch (err) {
            // Posting failed (worker gone): fail this run and respawn.
            record.job = null;
            this._settle(entry);
            entry.reject(err);
            this._replace(record);
            this._pump();
        }
    }

    _pump() {
        while (!this.closed && this.pending.length > 0 && this.idle.length > 0) {
            const entry = this.pending.shift();
            this._assign(this.idle.pop(), entry);
        }
    }

    _cancel(entry) {
        const record = entry.record;
        this._settle(entry);

        if (!record) {
            // Still queued: just drop it.
            const idx = this.pending.indexOf(entry);
            if (idx >= 0) this.pending.splice(idx, 1);
            entry.reject(abortError());
            return;
        }

        // Terminate the worker (kills the in-flight job) and respawn.
        record.job = null;
        entry.reject(abortError());
        this._replace(record);
        this._pump();
    }

    run(job, { signal } = {}) {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error("Conversion pool is closed"));
                return;
            }

            const entry = {
                job: { ...job, id: ++this.nextId },
                resolve,
                reject,
                signal: signal || null,
                onAbort: null,
                record: null
            };

            if (signal) {
                if (signal.aborted) {
                    reject(abortError());
                    return;
                }
                entry.onAbort = () => this._cancel(entry);
                signal.addEventListener("abort", entry.onAbort, { once: true });
            }

            this._dispatch(entry);
        });
    }

    close() {
        if (this.closed) return;
        this.closed = true;

        // Reject queued runs.
        while (this.pending.length > 0) {
            const entry = this.pending.shift();
            this._settle(entry);
            entry.reject(new Error("Conversion pool is closed"));
        }

        // Reject in-flight runs and terminate workers.
        for (const record of this.workers) {
            if (record.job) {
                const entry = record.job;
                record.job = null;
                this._settle(entry);
                entry.reject(new Error("Conversion pool is closed"));
            }
            record.dead = true;
            record.worker.terminate().catch(() => {});
        }

        this.workers = [];
        this.idle = [];
    }
}

module.exports = { ConversionPool, decodeError, abortError, crashError, WORKER_PATH };