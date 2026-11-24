"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    fetchAvatar3D,
    fetchAvatarMetadataJson,
    fetchPlayerAvatar
} = require("../avatar-metadata");

const METADATA_URL = "https://tr.rbxcdn.com/metadata/avatar";

function jsonResponse(value) {
    return {
        ok: true,
        status: 200,
        json: async () => value
    };
}

function errorResponse(status) {
    return {
        ok: false,
        status,
        json: async () => null
    };
}

function abortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}

// ---------------------------------------------------------------------------
// fetchAvatar3D
// ---------------------------------------------------------------------------

test("fetchAvatar3D retries retryable HTTP statuses and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        if (calls === 1) {
            return errorResponse(503);
        }
        return jsonResponse({ data: [{ imageUrl: "https://tr.rbxcdn.com/metadata" }] });
    };

    const result = await fetchAvatar3D(fetchWithTimeout, "test-key", "12345", {
        attempts: 3,
        delayMs: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.imageUrl, "https://tr.rbxcdn.com/metadata");
    assert.equal(calls, 2);
});

test("fetchAvatar3D returns the final response after retryable HTTP status exhaustion", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return errorResponse(503);
    };

    const result = await fetchAvatar3D(fetchWithTimeout, "test-key", "12345", {
        attempts: 3,
        delayMs: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
});

test("fetchAvatar3D stops immediately on a non-retryable HTTP status", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return errorResponse(401);
    };

    const result = await fetchAvatar3D(fetchWithTimeout, "test-key", "12345", {
        attempts: 5,
        delayMs: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
});

test("fetchAvatar3D rethrows the final network error after exhaustion", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        throw new Error("upstream network down");
    };

    const pending = fetchAvatar3D(fetchWithTimeout, "test-key", "12345", {
        attempts: 2,
        delayMs: 0
    });

    await assert.rejects(pending, (error) => error && error.message === "upstream network down");
    assert.equal(calls, 2);
});

test("fetchAvatar3D propagates caller abort when the next fetch attempt observes an aborted signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    let resolveFirst;

    const fetchWithTimeout = async (url, options = {}) => {
        if (options.signal && options.signal.aborted) {
            throw abortError();
        }
        calls += 1;
        if (calls === 1) {
            return new Promise((resolve) => {
                resolveFirst = resolve;
            });
        }
        throw abortError();
    };

    const pending = fetchAvatar3D(fetchWithTimeout, "test-key", "12345", {
        attempts: 3,
        delayMs: 0,
        signal: controller.signal
    });

    resolveFirst(errorResponse(503));
    controller.abort();

    await assert.rejects(pending, (error) => error && error.name === "AbortError");
});

// ---------------------------------------------------------------------------
// fetchAvatarMetadataJson
// ---------------------------------------------------------------------------

test("fetchAvatarMetadataJson retries a retryable HTTP status and succeeds later", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        if (calls === 1) {
            return errorResponse(503);
        }
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
                Buffer.from(JSON.stringify({ obj: "objhash", mtl: "mtlhash", textures: ["texhash"] }))
        };
    };

    const result = await fetchAvatarMetadataJson(fetchWithTimeout, METADATA_URL, {
        attempts: 2,
        delayMs: 0,
        maxBytes: 1024
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.metadata.obj, "objhash");
    assert.equal(calls, 2);
});

test("fetchAvatarMetadataJson stops immediately on a non-retryable HTTP status", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return errorResponse(401);
    };

    const result = await fetchAvatarMetadataJson(fetchWithTimeout, METADATA_URL, {
        attempts: 5,
        delayMs: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "http");
    assert.equal(result.status, 401);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
});

test("fetchAvatarMetadataJson returns the final retryable HTTP result after exhaustion", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        return errorResponse(503);
    };

    const result = await fetchAvatarMetadataJson(fetchWithTimeout, METADATA_URL, {
        attempts: 3,
        delayMs: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "http");
    assert.equal(result.status, 503);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
});

test("fetchAvatarMetadataJson returns the final network failure after exhaustion rather than throwing", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        throw new Error("metadata network down");
    };

    const result = await fetchAvatarMetadataJson(fetchWithTimeout, METADATA_URL, {
        attempts: 2,
        delayMs: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
});

test("fetchAvatarMetadataJson retries invalid metadata then succeeds with valid metadata", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        if (calls === 1) {
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => Buffer.from("not-json{")
            };
        }
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
                Buffer.from(JSON.stringify({ obj: "objhash", mtl: "mtlhash", textures: ["texhash"] }))
        };
    };

    const result = await fetchAvatarMetadataJson(fetchWithTimeout, METADATA_URL, {
        attempts: 2,
        delayMs: 0,
        maxBytes: 1024
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.metadata.obj, "objhash");
    assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// fetchPlayerAvatar
// ---------------------------------------------------------------------------

test("fetchPlayerAvatar honors explicitly configured retry attempts", async () => {
    let calls = 0;
    const fetchWithTimeout = async (url, options = {}) => {
        calls += 1;
        if (calls === 1) {
            throw new Error("avatar hint network down");
        }
        return jsonResponse({ playerAvatarType: "R15", assets: [{ id: "1", name: "Hat", assetType: "Texture" }] });
    };

    const result = await fetchPlayerAvatar(fetchWithTimeout, "test-key", "12345", {
        attempts: 2,
        delayMs: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.playerAvatarType, "R15");
    assert.equal(calls, 2);
});

test("fetchPlayerAvatar preserves the default single-attempt behavior", async () => {
    let calls = 0;
    const fetchWithTimeout = async () => {
        calls += 1;
        throw new Error("avatar hint network down");
    };

    const result = await fetchPlayerAvatar(fetchWithTimeout, "test-key", "12345");

    assert.equal(result.ok, false);
    assert.equal(calls, 1);
});
