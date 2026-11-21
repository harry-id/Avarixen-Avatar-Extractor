"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchAvatarMetadataJson } = require("../avatar-metadata");

function response(status, { location = null, body = "" } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return String(name).toLowerCase() === "location" ? location : null;
            }
        },
        arrayBuffer: async () => Buffer.from(body)
    };
}

const METADATA = JSON.stringify({
    obj: "objhash",
    mtl: "mtlhash",
    textures: ["texhash"]
});

test("metadata fetch follows redirects only to allowed hosts", async () => {
    const calls = [];
    const fetchWithTimeout = async (url) => {
        calls.push(url);

        if (calls.length === 1) {
            return response(302, {
                location: "https://tr.rbxcdn.com/metadata/final"
            });
        }

        return response(200, { body: METADATA });
    };

    const result = await fetchAvatarMetadataJson(
        fetchWithTimeout,
        "https://tr.rbxcdn.com/metadata/start",
        { attempts: 1, delayMs: 0 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.metadata.obj, "objhash");
    assert.deepEqual(calls, [
        "https://tr.rbxcdn.com/metadata/start",
        "https://tr.rbxcdn.com/metadata/final"
    ]);
});

test("metadata fetch blocks redirects to private/non-Roblox hosts", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return response(302, { location: "http://169.254.169.254/latest/meta-data" });
    };

    const result = await fetchAvatarMetadataJson(
        fetchWithTimeout,
        "https://tr.rbxcdn.com/metadata/start",
        { attempts: 5, delayMs: 0 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked");
    assert.equal(calls, 1, "blocked target must not be fetched");
});

test("metadata fetch blocks redirects without a Location header", async () => {
    const fetchWithTimeout = async () => response(302);

    const result = await fetchAvatarMetadataJson(
        fetchWithTimeout,
        "https://tr.rbxcdn.com/metadata/start",
        { attempts: 1, delayMs: 0 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked");
});

test("metadata fetch stops after the redirect limit", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return response(302, {
            location: `https://tr.rbxcdn.com/metadata/${calls + 1}`
        });
    };

    const result = await fetchAvatarMetadataJson(
        fetchWithTimeout,
        "https://tr.rbxcdn.com/metadata/0",
        { attempts: 1, delayMs: 0 }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked");
    assert.equal(calls, 4, "initial request plus three redirects");
});
