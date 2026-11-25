"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const net = require("net");
const http = require("node:http");
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

// Issue a request bound to a specific loopback source IP so the server sees a
// distinct client IP (127.0.0.2, 127.0.0.3, ... are all loopback on Linux).
function request(port, reqPath, { method = "GET", localAddress, body } = {}) {
    return new Promise((resolve, reject) => {
        const headers = body ? { "Content-Type": "application/json" } : {};
        const req = http.request(
            { host: "127.0.0.1", port, path: reqPath, method, localAddress, headers },
            (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode));
            }
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

test("download route has a stricter per-IP limit; other routes and health unaffected", async () => {
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
            // Force "not configured" so the download route answers 500 without
            // any upstream network call (dotenv will not override an existing key).
            ROBLOX_API_KEY: "",
            // Global limit high so only the download limiter trips.
            RATE_LIMIT_MAX: "100",
            RATE_LIMIT_WINDOW_MS: "60000",
            DOWNLOAD_RATE_LIMIT_MAX: "3",
            DOWNLOAD_RATE_LIMIT_WINDOW_MS: "60000",
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

        // Health is exempt from both limiters.
        const health = [];
        for (let i = 0; i < 8; i += 1) {
            health.push(await request(port, "/api/health", { localAddress: "127.0.0.1" }));
        }
        assert.ok(health.every((s) => s === 200), `health: ${health}`);

        // Download from 127.0.0.1: first 3 pass the limiter (route answers 500
        // because no API key is configured), then 429.
        const dl = [];
        let retryAfter = null;
        for (let i = 0; i < 5; i += 1) {
            const status = await request(port, `/api/roblox/download/123`, {
                localAddress: "127.0.0.1"
            });
            dl.push(status);
        }
        assert.deepEqual(dl.slice(0, 3), [500, 500, 500], `first three: ${dl}`);
        assert.deepEqual(dl.slice(3), [429, 429], `over limit: ${dl}`);

        // A different IP has its own bucket: not limited.
        const otherIp = await request(port, `/api/roblox/download/123`, {
            localAddress: "127.0.0.2"
        });
        assert.equal(otherIp, 500, "second IP must not be limited by the first");

        // Other /api routes are unaffected by the download limiter.
        const user = [];
        for (let i = 0; i < 6; i += 1) {
            user.push(await request(port, "/api/roblox/user", {
                method: "POST",
                localAddress: "127.0.0.1",
                body: JSON.stringify({ username: "" })
            }));
        }
        assert.ok(user.every((s) => s === 400), `user route: ${user}`);
    } finally {
        child.kill("SIGKILL");
    }
});