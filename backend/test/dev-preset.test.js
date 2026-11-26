"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const {
    PRESET_DEFAULTS,
    computeDevPreset,
    applyDevPreset,
    isLoopbackHost
} = require("../dev-preset");
const { sweepDownloads, ttlToMaxAgeMs } = require("../downloads-cleanup");

test("no preset when NODE_ENV is unset, test, production, or other", () => {
    for (const env of [
        {},
        { NODE_ENV: "test" },
        { NODE_ENV: "production" },
        { NODE_ENV: "staging" },
        { NODE_ENV: "Development" } // case-sensitive: not exactly "development"
    ]) {
        const plan = computeDevPreset(env);
        assert.equal(plan.active, false, `NODE_ENV=${env.NODE_ENV} must not activate`);
        assert.deepEqual(plan.set, {});
        assert.deepEqual(plan.skipped, []);
    }
});

test("development applies each default for unset variables", () => {
    const plan = computeDevPreset({ NODE_ENV: "development" });
    assert.equal(plan.active, true);
    assert.deepEqual(plan.set, PRESET_DEFAULTS);
    assert.deepEqual(plan.skipped, []);
});

test("explicit variables win over the preset (skipped, not overwritten)", () => {
    const env = {
        NODE_ENV: "development",
        DOWNLOADS_TTL_HOURS: "12",
        LOG_REQUESTS: "false",
        RATE_LIMIT_MAX: "5"
    };
    const plan = computeDevPreset(env);
    assert.equal(plan.active, true);
    assert.equal(plan.set.DOWNLOADS_TTL_HOURS, undefined);
    assert.equal(plan.set.LOG_REQUESTS, undefined);
    assert.equal(plan.set.RATE_LIMIT_MAX, undefined);
    assert.ok(plan.skipped.includes("DOWNLOADS_TTL_HOURS"));
    assert.ok(plan.skipped.includes("LOG_REQUESTS"));
    assert.ok(plan.skipped.includes("RATE_LIMIT_MAX"));
    // Unset ones are still filled.
    assert.equal(plan.set.AAE_LOG_LEVEL, "debug");
});

test("applyDevPreset mutates only unset keys; explicit values are preserved", () => {
    const env = { NODE_ENV: "development", DOWNLOADS_MAX_BYTES: "123" };
    applyDevPreset(env);
    assert.equal(env.DOWNLOADS_MAX_BYTES, "123", "explicit value preserved");
    assert.equal(env.DOWNLOADS_TTL_HOURS, "0");
    assert.equal(env.AAE_LOG_LEVEL, "debug");
    assert.equal(env.LOG_REQUESTS, "verbose");
    assert.equal(env.LOG_ASSETS, "1");
    assert.equal(env.RATE_LIMIT_MAX, "100000");
    assert.equal(env.DOWNLOAD_RATE_LIMIT_MAX, "100000");
    assert.equal(env.AAE_PROFILE_STAGES, "true");
});

test("applyDevPreset is a no-op when not in development", () => {
    const env = { NODE_ENV: "production" };
    applyDevPreset(env);
    assert.deepEqual(env, { NODE_ENV: "production" });
});

test("empty-string values are treated as unset and filled by the preset", () => {
    const env = { NODE_ENV: "development", AAE_LOG_LEVEL: "" };
    const plan = computeDevPreset(env);
    assert.equal(plan.set.AAE_LOG_LEVEL, "debug");
    assert.ok(!plan.skipped.includes("AAE_LOG_LEVEL"));
});

test("isLoopbackHost recognizes loopback and rejects non-loopback", () => {
    assert.equal(isLoopbackHost(""), true);
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("127.1.2.3"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("192.168.1.10"), false);
    assert.equal(isLoopbackHost("example.com"), false);
});

test("development preset: an avatar older than the TTL survives a sweep", () => {
    // In development the preset disables the age sweep (DOWNLOADS_TTL_HOURS=0).
    const env = { NODE_ENV: "development" };
    applyDevPreset(env);
    const maxAgeMs = ttlToMaxAgeMs(env.DOWNLOADS_TTL_HOURS);
    assert.equal(maxAgeMs, Number.POSITIVE_INFINITY);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-devttl-"));
    try {
        const full = path.join(dir, "1");
        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, "avatar.obj"), "x");
        // 30 days old — far older than the 24h default TTL.
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        fs.utimesSync(full, old, old);

        const result = sweepDownloads(dir, maxAgeMs, Date.now());
        assert.equal(result.removed, 0, "age sweep disabled in development");
        assert.equal(fs.existsSync(full), true, "old avatar survives");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

test("real server start in development prints the banner and warns on non-loopback HOST", async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, ["server.js"], {
        cwd: path.join(__dirname, ".."),
        env: {
            ...process.env,
            NODE_ENV: "development",
            HOST: "0.0.0.0",
            PORT: String(port),
            AAE_LOG_FILE: "false",
            LOG_REQUESTS: "false"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });

    try {
        // Wait for the server to listen (or a short timeout).
        const listened = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), 8000);
            child.stdout.on("data", () => {
                if (out.includes("running at")) { clearTimeout(t); resolve(true); }
            });
            child.on("exit", () => { clearTimeout(t); resolve(false); });
        });
        assert.ok(listened, "server started");
        assert.match(out, /DEVELOPMENT PRESET ACTIVE \(NODE_ENV=development\)/);
        assert.match(out, /set: /);
        assert.match(out, /not loopback/);
    } finally {
        child.kill("SIGKILL");
    }
});