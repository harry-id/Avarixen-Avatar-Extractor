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

// The global Express error middleware has no coverage: a malformed JSON body
// makes body-parser throw, and the middleware must answer 400 with the stable
// { success: false, message } shape (never a stack trace or upstream body).
test("malformed JSON to an API route returns 400 with the error shape", async () => {
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

        const r = await fetch(`http://127.0.0.1:${port}/api/roblox/user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{ not valid json",
        });

        assert.equal(r.status, 400, "malformed JSON should be a 400");

        const body = await r.json();
        assert.equal(body.success, false, "error body should have success:false");
        assert.equal(
            typeof body.message,
            "string",
            "error body should carry a string message"
        );
        assert.ok(body.message.length > 0, "error message should not be empty");
        // The client must never receive a stack trace or internal details.
        assert.ok(
            !/stack|at .*\(.*:\d+:\d+\)/.test(body.message),
            "error message must not leak a stack trace"
        );
    } finally {
        child.kill("SIGKILL");
    }
});