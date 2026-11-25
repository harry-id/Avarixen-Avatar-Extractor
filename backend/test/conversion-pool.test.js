"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ConversionPool } = require("../worker/conversion-pool");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makePool(overrides = {}) {
    return new ConversionPool({
        size: 1,
        recycleAfter: 1000,
        resourceLimits: { maxOldGenerationSizeMb: 512 },
        log: () => {},
        ...overrides
    });
}

test("pool reuses a single worker across jobs", async () => {
    const pool = makePool({ size: 1 });
    try {
        const results = await Promise.all([
            pool.run({ cmd: "sleep", ms: 50 }),
            pool.run({ cmd: "sleep", ms: 50 }),
            pool.run({ cmd: "sleep", ms: 50 })
        ]);
        assert.equal(results.length, 3);
        assert.ok(results.every((r) => r.ok));
        assert.equal(pool.workers.length, 1, "one worker reused");
        assert.equal(pool.workers[0].jobsDone, 3);
    } finally {
        pool.close();
    }
});

test("pool respawns a worker after an unexpected exit", async () => {
    const pool = makePool({ size: 1 });
    try {
        await assert.rejects(pool.run({ cmd: "crash" }), (err) => {
            assert.equal(err.code, "ECONVERSIONCRASH");
            return true;
        });
        // A replacement worker must serve the next job.
        const ok = await pool.run({ cmd: "sleep", ms: 20 });
        assert.equal(ok.ok, true);
        assert.equal(pool.workers.length, 1);
    } finally {
        pool.close();
    }
});

test("pool recycles a worker after N jobs", async () => {
    const pool = makePool({ size: 1, recycleAfter: 2 });
    try {
        const firstThread = pool.workers[0].worker.threadId;
        await pool.run({ cmd: "sleep", ms: 10 });
        await pool.run({ cmd: "sleep", ms: 10 });
        // After 2 jobs the worker is recycled -> a new thread id.
        const secondThread = pool.workers[0].worker.threadId;
        assert.notEqual(secondThread, firstThread, "worker recycled after N jobs");
        assert.equal(pool.workers.length, 1, "still exactly one worker");
        const ok = await pool.run({ cmd: "sleep", ms: 10 });
        assert.equal(ok.ok, true);
    } finally {
        pool.close();
    }
});

test("close rejects in-flight and pending runs and terminates workers", async () => {
    const pool = makePool({ size: 1 });
    const inflight = pool.run({ cmd: "sleep", ms: 5000 });
    // Queue a second job behind the first (size 1).
    const queued = pool.run({ cmd: "sleep", ms: 10 });

    await delay(50);
    pool.close();

    await assert.rejects(inflight, /closed/);
    await assert.rejects(queued, /closed/);
    assert.equal(pool.workers.length, 0, "workers terminated");
});

test("cancel terminates the worker, respawns, and the next job succeeds", async () => {
    const pool = makePool({ size: 1 });
    try {
        const ac = new AbortController();
        const firstThread = pool.workers[0].worker.threadId;
        const run = pool.run({ cmd: "sleep", ms: 5000 }, { signal: ac.signal });

        await delay(50);
        ac.abort();

        await assert.rejects(run, (err) => {
            assert.equal(err.name, "AbortError");
            return true;
        });

        // Worker was terminated and respawned (new thread id).
        await delay(50);
        assert.notEqual(pool.workers[0].worker.threadId, firstThread);
        assert.equal(pool.workers.length, 1);

        // The pool still works.
        const ok = await pool.run({ cmd: "sleep", ms: 20 });
        assert.equal(ok.ok, true);
    } finally {
        pool.close();
    }
});

test("cancel while queued drops the job without spawning/leaking", async () => {
    const pool = makePool({ size: 1 });
    try {
        const ac1 = new AbortController();
        const blocking = pool.run({ cmd: "sleep", ms: 5000 }, { signal: ac1.signal });
        const ac2 = new AbortController();
        const queued = pool.run({ cmd: "sleep", ms: 10 }, { signal: ac2.signal });

        await delay(30);
        ac2.abort(); // cancel the queued (not started) job
        await assert.rejects(queued, (err) => err.name === "AbortError");

        ac1.abort();
        await assert.rejects(blocking, (err) => err.name === "AbortError");

        await delay(50);
        assert.equal(pool.workers.length, 1, "no leaked workers");
        const ok = await pool.run({ cmd: "sleep", ms: 10 });
        assert.equal(ok.ok, true);
    } finally {
        pool.close();
    }
});
// ---- Step 5: server lifecycle (shutdown with an in-flight job) ----

const { spawn } = require("child_process");
const path = require("path");

test("shutdown closes the pool with an in-flight job without hanging", async () => {
    const backend = path.join(__dirname, "..");
    const child = `
        const { ConversionPool } = require(${JSON.stringify(path.join(backend, "worker/conversion-pool.js"))});
        const pool = new ConversionPool({ size: 1, recycleAfter: 100, log: () => {} });
        pool.run({ cmd: "sleep", ms: 60000 }).catch(() => {});
        process.on("SIGTERM", () => {
            const t = Date.now();
            pool.close();
            // Exit shortly after close; close() must not block the loop.
            setTimeout(() => process.exit(0), 50);
        });
    `;
    const childProc = spawn("node", ["-e", child], { stdio: ["ignore", "pipe", "pipe"] });
    let exited = false;
    childProc.on("exit", () => { exited = true; });

    // Let the job start (worker busy), then request shutdown.
    await delay(400);
    const t0 = Date.now();
    childProc.kill("SIGTERM");

    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { childProc.kill("SIGKILL"); resolve("timeout"); }, 5000);
        childProc.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    const ms = Date.now() - t0;

    assert.equal(exited, true, "child exited");
    assert.notEqual(code, "timeout", "shutdown must not hang");
    assert.ok(ms < 3000, `shutdown took ${ms}ms, expected prompt`);
});
