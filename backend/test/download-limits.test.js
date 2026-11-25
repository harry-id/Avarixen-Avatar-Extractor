"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");

const registerDownloadRoutes = require("../avatar-downloader");
const {
    readResponseLimited,
    fetchAssetResponse,
    DownloadTooLargeError
} = require("../avatar-downloader");
const { createAdmissionLimiter } = require("../admission-limiter");

const USER_ID = String(9_920_000_000 + Math.floor(Math.random() * 100000));

function jsonResponse(value) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => value,
        arrayBuffer: async () => Buffer.from(JSON.stringify(value))
    };
}

function bufferResponse(buffer, headers = {}) {
    return {
        ok: true,
        status: 200,
        headers: { get: (name) => headers[String(name).toLowerCase()] || null },
        arrayBuffer: async () => Buffer.from(buffer)
    };
}

function metadata() {
    return JSON.stringify({
        obj: "objhash",
        mtl: "mtlhash",
        textures: ["texhash"]
    });
}

function makeFetch({ obj = Buffer.from("v 0 0 0\n"), delaySignal = false } = {}) {
    return async (url, options = {}) => {
        if (url.includes("thumbnails.roblox.com/v1/users/avatar-3d")) {
            if (delaySignal) {
                return new Promise((resolve, reject) => {
                    if (options.signal) {
                        options.signal.addEventListener("abort", () => {
                            const error = new Error("aborted");
                            error.name = "AbortError";
                            reject(error);
                        });
                    }
                });
            }
            return jsonResponse({ data: [{ imageUrl: "https://tr.rbxcdn.com/metadata" }] });
        }

        if (url.includes("avatar.roblox.com")) {
            return { ok: false, status: 404, headers: { get: () => null } };
        }

        if (url.endsWith("/metadata")) {
            return bufferResponse(Buffer.from(metadata()));
        }

        if (url.endsWith("/objhash")) return bufferResponse(obj);
        if (url.endsWith("/mtlhash")) return bufferResponse(Buffer.from("newmtl m\nKd 1 1 1\n"));
        if (url.endsWith("/texhash")) return bufferResponse(Buffer.from("texture"));

        throw new Error(`Unexpected URL: ${url}`);
    };
}

async function withServer(options, run) {
    const app = express();
    registerDownloadRoutes(app, {
        fetchWithTimeout: makeFetch(),
        getApiKey: () => "test-key",
        minFreeDiskBytes: 0,
        getFreeDiskBytes: async () => Number.MAX_SAFE_INTEGER,
        ...options
    });

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("readResponseLimited rejects oversized Content-Length before reading", async () => {
    const response = new Response(Buffer.alloc(100), {
        headers: { "content-length": "100" }
    });

    await assert.rejects(
        () => readResponseLimited(response, { maxBytes: 10 }),
        (error) => error instanceof DownloadTooLargeError
    );
});

test("readResponseLimited enforces streamed byte limits without Content-Length", async () => {
    const response = new Response(Buffer.alloc(100));

    await assert.rejects(
        () => readResponseLimited(response, { maxBytes: 10 }),
        (error) => error instanceof DownloadTooLargeError
    );
});

test("readResponseLimited maintains a shared avatar budget", async () => {
    const budget = { used: 0, max: 10 };
    const first = new Response(Buffer.alloc(6));
    const second = new Response(Buffer.alloc(6));

    await readResponseLimited(first, { maxBytes: 100, budget });
    await assert.rejects(
        () => readResponseLimited(second, { maxBytes: 100, budget }),
        (error) => error instanceof DownloadTooLargeError
    );
});

test("asset redirects to non-Roblox hosts are rejected before fetching", async () => {
    const calls = [];
    const fetchWithTimeout = async (url) => {
        calls.push(url);
        return bufferResponse(Buffer.from("x"), {
            location: "http://127.0.0.1/internal"
        });
    };

    // Give the first response a redirect status.
    fetchWithTimeout.firstStatus = 302;
    const fetchStub = async (url, options) => {
        calls.push(url);
        return {
            ok: false,
            status: 302,
            headers: { get: (name) => name.toLowerCase() === "location" ? "http://127.0.0.1/internal" : null }
        };
    };

    await assert.rejects(
        () => fetchAssetResponse("https://t0.rbxcdn.com/hash", fetchStub, {}, undefined),
        /not an approved/
    );
    assert.equal(calls.length, 1, "internal destination must not be fetched");
});

test("asset redirects to approved CDN hosts are followed", async () => {
    const calls = [];
    const fetchStub = async (url) => {
        calls.push(url);
        if (calls.length === 1) {
            return {
                ok: false,
                status: 302,
                headers: { get: (name) => name.toLowerCase() === "location" ? "https://tr.rbxcdn.com/final" : null }
            };
        }
        return bufferResponse(Buffer.from("ok"));
    };

    const response = await fetchAssetResponse(
        "https://t0.rbxcdn.com/hash",
        fetchStub,
        {},
        undefined
    );

    assert.equal(response.ok, true);
    assert.deepEqual(calls, [
        "https://t0.rbxcdn.com/hash",
        "https://tr.rbxcdn.com/final"
    ]);
});

test("oversized asset returns 413 and leaves no cache entry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-limit-"));

    try {
        await withServer({
            downloadsRoot: root,
            maxAssetBytes: 16,
            maxAvatarBytes: 1024
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 413);
            const body = await response.json();
            assert.equal(body.success, false);
        });

        await assert.rejects(
            () => fs.access(path.join(root, USER_ID)),
            /ENOENT/
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("download queue saturation returns 503", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-queue-"));
    const limiter = createAdmissionLimiter({
        maxConcurrent: 1,
        maxQueue: 0,
        code: "EDOWNLOADBUSY"
    });

    try {
        await withServer({
            downloadsRoot: root,
            downloadLimiter: limiter,
            fetchWithTimeout: makeFetch({ delaySignal: true })
        }, async (base) => {
            const first = fetch(`${base}/api/roblox/download/${USER_ID}`);
            // Let the first request acquire the limiter and start waiting upstream.
            await new Promise((resolve) => setTimeout(resolve, 50));

            const second = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(second.status, 503);
            assert.equal(second.headers.get("retry-after"), "5");

            // Abort the first request; the server should clean up.
            first.catch(() => {});
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("download deadline aborts a slow upstream request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-timeout-"));

    try {
        await withServer({
            downloadsRoot: root,
            downloadTimeoutMs: 30,
            fetchWithTimeout: makeFetch({ delaySignal: true })
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 504);
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("free-space guard rejects downloads before upstream work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-space-"));
    let fetched = false;

    try {
        await withServer({
            downloadsRoot: root,
            minFreeDiskBytes: 1024,
            getFreeDiskBytes: async () => 0,
            fetchWithTimeout: async () => {
                fetched = true;
                throw new Error("should not be called");
            }
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 507);
        });

        assert.equal(fetched, false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("cache quota rejects a download before committing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-quota-"));

    try {
        await withServer({
            downloadsRoot: root,
            downloadsMaxBytes: 32,
            maxAssetBytes: 1024,
            maxAvatarBytes: 4096
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 507);
            const body = await response.json();
            assert.equal(body.success, false);
        });

        await assert.rejects(
            () => fs.access(path.join(root, USER_ID)),
            /ENOENT/
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("misleading small Content-Length cannot bypass the streamed limit", async () => {
    const response = new Response(Buffer.alloc(100), {
        headers: { "content-length": "5" }
    });

    await assert.rejects(
        () => readResponseLimited(response, { maxBytes: 50 }),
        (error) => error instanceof DownloadTooLargeError
    );
});

test("quota pressure with only protected entries fails 507 and keeps the active avatar", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-protected-"));
    // A young (recently used) entry from another user, larger than the quota.
    const otherDir = path.join(root, "777");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "avatar.obj"), "z".repeat(200));

    try {
        await withServer({
            downloadsRoot: root,
            downloadsMaxBytes: 32,
            maxAssetBytes: 1024,
            maxAvatarBytes: 4096,
            downloadsMinAgeMs: 300000
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 507);
            const body = await response.json();
            assert.equal(body.success, false);
        });

        // The protected (young) entry survived; the new user was not committed.
        await fs.access(otherDir);
        await assert.rejects(
            () => fs.access(path.join(root, USER_ID)),
            /ENOENT/
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("client disconnect aborts upstream work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-abort-"));
    let aborted = false;

    try {
        const fetchWithTimeout = (url, options = {}) => new Promise((resolve, reject) => {
            if (options.signal) {
                options.signal.addEventListener("abort", () => {
                    aborted = true;
                    const error = new Error("client aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            }
        });

        await withServer({
            downloadsRoot: root,
            fetchWithTimeout
        }, async (base) => {
            const controller = new AbortController();
            const request = fetch(`${base}/api/roblox/download/${USER_ID}`, {
                signal: controller.signal
            }).catch(() => null);

            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.abort();
            await request;
            await new Promise((resolve) => setTimeout(resolve, 100));
        });

        assert.equal(aborted, true);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("oversized aggregate avatar returns 413", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aae-download-total-"));

    try {
        await withServer({
            downloadsRoot: root,
            maxAssetBytes: 1024,
            maxAvatarBytes: 16
        }, async (base) => {
            const response = await fetch(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(response.status, 413);
        });

        await assert.rejects(
            () => fs.access(path.join(root, USER_ID)),
            /ENOENT/
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
