"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const http = require("node:http");
const express = require("express");

const registerDownloadRoutes = require("../avatar-downloader");

const USER_ID = String(9_900_000_000 + Math.floor(Math.random() * 100000));
const DOWNLOADS_DIR = path.join(__dirname, "../../downloads");
const USER_DIR = path.join(DOWNLOADS_DIR, USER_ID);

const OBJ = [
    "mtllib avatar.mtl",
    "v 0 0 0",
    "v 2 0 0",
    "v 0 2 0",
    "vt 0 0",
    "vt 1 0",
    "vt 0 1",
    "vn 0 0 1",
    "usemtl cloth",
    "g Body",
    "f 1/1/1 2/2/1 3/3/1",
    ""
].join("\n");

const MTL = "newmtl cloth\nKd 0.8 0.8 0.8\nmap_Kd texhash\n";

const METADATA = JSON.stringify({
    obj: "objhash",
    mtl: "mtlhash",
    textures: ["texhash"]
});

function jsonResponse(value) {
    return {
        ok: true,
        status: 200,
        json: async () => value,
        arrayBuffer: async () => Buffer.from(JSON.stringify(value))
    };
}

function bufferResponse(buffer) {
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(buffer)
    };
}

function makeFetch({ failAssets = false } = {}) {
    return async (url) => {
        if (url.includes("thumbnails.roblox.com/v1/users/avatar-3d")) {
            return jsonResponse({
                data: [{ imageUrl: "https://tr.rbxcdn.com/metadata" }]
            });
        }

        if (url.includes("avatar.roblox.com")) {
            return { ok: false, status: 404 };
        }

        if (url.endsWith("/metadata")) {
            return bufferResponse(Buffer.from(METADATA));
        }

        if (failAssets) {
            throw new Error("simulated CDN outage");
        }

        if (url.endsWith("/objhash")) {
            return bufferResponse(Buffer.from(OBJ));
        }

        if (url.endsWith("/mtlhash")) {
            return bufferResponse(Buffer.from(MTL));
        }

        if (url.endsWith("/texhash")) {
            return bufferResponse(Buffer.from("not-a-real-png"));
        }

        throw new Error(`Unexpected URL: ${url}`);
    };
}

async function withServer({ failAssets = false, fetchWithTimeout, ...rest } = {}, run) {
    const app = express();
    registerDownloadRoutes(app, {
        fetchWithTimeout: fetchWithTimeout || makeFetch({ failAssets }),
        getApiKey: () => "test-key",
        ...rest
    });

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        await run(base);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function getJson(url) {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
}

test("concurrent downloads for one user serialize and leave no staging dirs", async () => {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
    await fs.rm(USER_DIR, { recursive: true, force: true });

    try {
        await withServer({}, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const results = await Promise.all([getJson(url), getJson(url)]);

            for (const result of results) {
                assert.equal(result.status, 200);
                assert.equal(result.body.success, true);
                assert.equal(result.body.textureCount, 1);
            }

            const entries = await fs.readdir(DOWNLOADS_DIR);
            assert.equal(
                entries.some((name) => name.startsWith(`.stage-${USER_ID}-`)),
                false,
                "no staging directory remains"
            );
            assert.equal(
                entries.some((name) => name.startsWith(`.old-${USER_ID}-`)),
                false,
                "no backup directory remains"
            );
        });

        const obj = await fs.readFile(path.join(USER_DIR, "avatar.obj"), "utf8");
        assert.match(obj, /g Body/);
        assert.equal(
            (await fs.readdir(USER_DIR)).filter((n) => /^texture\d+\.png$/.test(n)).length,
            1
        );
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

// ---- Part 3: in-flight download coalescing ----

function instrumentedFetch(counter, { delayMs = 0, failAssets = false } = {}) {
    const base = makeFetch({ failAssets });
    return async (url, options) => {
        // One avatar-3d lookup per download sequence.
        if (url.includes("avatar-3d")) counter.sequences += 1;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return base(url, options);
    };
}

test("two simultaneous same-user downloads coalesce into one upstream sequence", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter) }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const [a, b] = await Promise.all([getJson(url), getJson(url)]);
            assert.equal(a.status, 200);
            assert.equal(b.status, 200);
            assert.equal(a.body.textureCount, 1);
            assert.equal(b.body.textureCount, 1);
            assert.deepEqual(a.body.files, b.body.files);
            assert.equal(counter.sequences, 1, "only one upstream download sequence");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("a failed shared download reaches every waiter", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter, { failAssets: true }) }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const [a, b] = await Promise.all([getJson(url), getJson(url)]);
            assert.equal(a.status, 500);
            assert.equal(b.status, 500);
            assert.equal(counter.sequences, 1, "one shared (failed) sequence");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("a first-client abort does not fail the second waiter", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter, { delayMs: 150 }) }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const ac = new AbortController();
            const first = fetch(url, { signal: ac.signal }).catch(() => null);
            // Let the shared download start, then abort only the first client.
            await new Promise((resolve) => setTimeout(resolve, 40));
            ac.abort();
            await first;

            // The second waiter still gets the result of the shared download.
            const second = await getJson(url);
            assert.equal(second.status, 200);
            assert.equal(counter.sequences, 1);
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("a new request after completion starts a fresh download (no stale reuse)", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter) }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const first = await getJson(url);
            assert.equal(first.status, 200);
            const second = await getJson(url);
            assert.equal(second.status, 200);
            assert.equal(counter.sequences, 2, "each completed request re-downloads");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("different users are not coalesced", async () => {
    const userA = String(9_930_000_000 + Math.floor(Math.random() * 100000));
    const userB = String(9_940_000_000 + Math.floor(Math.random() * 100000));
    const dirA = path.join(DOWNLOADS_DIR, userA);
    const dirB = path.join(DOWNLOADS_DIR, userB);
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter) }, async (base) => {
            const [a, b] = await Promise.all([
                getJson(`${base}/api/roblox/download/${userA}`),
                getJson(`${base}/api/roblox/download/${userB}`)
            ]);
            assert.equal(a.status, 200);
            assert.equal(b.status, 200);
            assert.equal(counter.sequences, 2, "one sequence per distinct user");
        });
    } finally {
        await fs.rm(dirA, { recursive: true, force: true });
        await fs.rm(dirB, { recursive: true, force: true });
    }
});

// ---- Part 4: optional cache-first window (default OFF) ----

test("cache-first is disabled by default (always re-downloads)", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        await withServer({ fetchWithTimeout: instrumentedFetch(counter) }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            await getJson(url);
            await getJson(url);
            assert.equal(counter.sequences, 2, "no cache-first by default");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("cache-first returns the cache within the window, re-downloads after", async () => {
    await fs.rm(USER_DIR, { recursive: true, force: true });
    const counter = { sequences: 0 };

    try {
        // Large window: the second request is served from cache.
        await withServer({
            fetchWithTimeout: instrumentedFetch(counter),
            downloadsCacheFirstMs: 600000
        }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            const first = await getJson(url);
            assert.equal(first.status, 200);
            const second = await getJson(url);
            assert.equal(second.status, 200);
            assert.deepEqual(second.body.files, first.body.files);
            assert.equal(counter.sequences, 1, "second served from cache");
        });

        // Zero window (disabled) on a fresh counter re-downloads every time.
        const counter2 = { sequences: 0 };
        await withServer({
            fetchWithTimeout: instrumentedFetch(counter2),
            downloadsCacheFirstMs: 0
        }, async (base) => {
            const url = `${base}/api/roblox/download/${USER_ID}`;
            await getJson(url);
            await getJson(url);
            assert.equal(counter2.sequences, 2, "disabled window re-downloads");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("a failed re-download leaves the previous cache intact", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), "OLD-CACHE");

    try {
        await withServer({ failAssets: true }, async (base) => {
            const result = await getJson(`${base}/api/roblox/download/${USER_ID}`);
            assert.equal(result.status, 500);
            assert.equal(result.body.success, false);
        });

        const obj = await fs.readFile(path.join(USER_DIR, "avatar.obj"), "utf8");
        assert.equal(obj, "OLD-CACHE", "previous cache was not destroyed");
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});
