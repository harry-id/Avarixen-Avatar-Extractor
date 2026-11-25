"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const BACKEND = path.join(__dirname, "..");

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

async function waitForHealth(port, timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (r.status === 200) return true;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

test("/api/health is exempt from the rate limiter; other /api routes still 429", async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, ["server.js"], {
        cwd: BACKEND,
        env: {
            ...process.env,
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: String(port),
            CORS_ORIGINS: "http://localhost:3001",
            TRUST_PROXY: "false",
            RATE_LIMIT_MAX: "3",
            RATE_LIMIT_WINDOW_MS: "60000",
            LOG_REQUESTS: "false",
            AAE_LOG_FILE: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    try {
        assert.ok(
            await waitForHealth(port),
            `server did not become healthy: ${stderr.slice(-800)}`
        );

        // Health: far more than the limit (3) from one IP; never 429.
        const healthStatuses = [];
        for (let i = 0; i < 8; i += 1) {
            const r = await fetch(`http://127.0.0.1:${port}/api/health`);
            healthStatuses.push(r.status);
        }
        assert.ok(
            healthStatuses.every((s) => s === 200),
            `health should never be rate limited: ${healthStatuses}`
        );

        // Another /api route from the same IP: first 3 pass the limiter (the
        // route answers 400 for an empty username), then 429 with Retry-After.
        const statuses = [];
        let retryAfter = null;
        for (let i = 0; i < 6; i += 1) {
            const r = await fetch(`http://127.0.0.1:${port}/api/roblox/user`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: "" })
            });
            if (r.status === 429 && retryAfter === null) {
                retryAfter = r.headers.get("retry-after");
            }
            statuses.push(r.status);
        }
        assert.deepEqual(
            statuses.slice(0, 3),
            [400, 400, 400],
            `first three requests should pass the limiter: ${statuses}`
        );
        assert.ok(
            statuses.slice(3).every((s) => s === 429),
            `requests over the limit should be 429: ${statuses}`
        );
        assert.ok(retryAfter, "429 should carry a Retry-After header");
    } finally {
        child.kill("SIGKILL");
    }
});